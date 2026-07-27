// 单元测试: daemon/allow-rules.ts — 运行: npx tsx tests/allow-rules.test.ts
import assert from "node:assert";
import { parseRule, ruleAllows } from "../daemon/allow-rules.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}: ${(e as Error).message}`);
  }
};

const bash = (cmd: string): { command: string } => ({ command: cmd });

// ── parseRule ───────────────────────────────────────────────────────────
t("parseRule: 裸工具名", () => {
  assert.deepEqual(parseRule("Read"), { tool: "Read", spec: undefined });
});
t("parseRule: Bash 带 specifier", () => {
  assert.deepEqual(parseRule("Bash(git log *)"), { tool: "Bash", spec: "git log *" });
});
t("parseRule: 非法格式返回 undefined", () => {
  assert.equal(parseRule("Bash(git log"), undefined);
  assert.equal(parseRule(""), undefined);
});

// ── 非 Bash 工具 ────────────────────────────────────────────────────────
t("裸工具名精确放行", () => {
  assert.equal(ruleAllows(["Read"], "Read", {}), "Read");
  assert.equal(ruleAllows(["Read"], "Write", {}), undefined);
});
t("mcp server 级规则覆盖其全部工具", () => {
  assert.equal(ruleAllows(["mcp__jira"], "mcp__jira__get_issue", {}), "mcp__jira");
  assert.equal(ruleAllows(["mcp__jira"], "mcp__jira2__get_issue", {}), undefined);
});
t("mcp 单工具规则", () => {
  assert.equal(ruleAllows(["mcp__jira__get_issue"], "mcp__jira__get_issue", {}), "mcp__jira__get_issue");
  assert.equal(ruleAllows(["mcp__jira__get_issue"], "mcp__jira__add_comment", {}), undefined);
});
t("非 Bash 工具的 specifier 规则无效(不误放行)", () => {
  assert.equal(ruleAllows(["Read(/etc/*)"], "Read", { file_path: "/etc/hosts" }), undefined);
});
t("交互卡工具永不可被规则放行", () => {
  assert.equal(ruleAllows(["AskUserQuestion"], "AskUserQuestion", {}), undefined);
  assert.equal(ruleAllows(["ExitPlanMode"], "ExitPlanMode", {}), undefined);
  assert.equal(ruleAllows(["EnterPlanMode"], "EnterPlanMode", {}), undefined);
});

// ── Bash: 精确与前缀 ────────────────────────────────────────────────────
t("Bash 精确匹配(空白归一)", () => {
  assert.equal(ruleAllows(["Bash(git status)"], "Bash", bash("git  status ")), "Bash(git status)");
  assert.equal(ruleAllows(["Bash(git status)"], "Bash", bash("git status -s")), undefined);
});
t("Bash 空格-星前缀", () => {
  const rules = ["Bash(git log *)"];
  assert.ok(ruleAllows(rules, "Bash", bash("git log --oneline -5")));
  assert.ok(ruleAllows(rules, "Bash", bash("git log")));
  assert.equal(ruleAllows(rules, "Bash", bash("git logs")), undefined);
  assert.equal(ruleAllows(rules, "Bash", bash("git push")), undefined);
});
t("Bash 冒号-星前缀", () => {
  assert.ok(ruleAllows(["Bash(npm run test:*)"], "Bash", bash("npm run test -- --watch")));
});
t("Bash 星号紧贴路径的前缀", () => {
  const rules = ["Bash(python3 .claude/skills/*)"];
  assert.ok(ruleAllows(rules, "Bash", bash("python3 .claude/skills/release-doc/scripts/gen_mr_list.py --sprint 91")));
  assert.equal(ruleAllows(rules, "Bash", bash("python3 evil.py")), undefined);
});

// ── Bash: 复合命令与安全语义 ────────────────────────────────────────────
t("复合命令逐段校验: 全命中才放行", () => {
  const rules = ["Bash(date *)", "Bash(cd *)", "Bash(python3 .claude/skills/*)"];
  assert.ok(ruleAllows(rules, "Bash", bash(
    'date "+%Y%m%d%H%M"; cd /Users/x/qm-brain && python3 .claude/skills/release-doc/scripts/gen_mr_list.py --sprint 91',
  )));
});
t("复合命令有一段不命中即整体拒绝(防搭便车)", () => {
  const rules = ["Bash(python3 .claude/skills/*)"];
  assert.equal(ruleAllows(rules, "Bash", bash("python3 .claude/skills/a/b.py && rm -rf /tmp/x")), undefined);
});
t("管道下游同样逐段校验", () => {
  assert.ok(ruleAllows(["Bash(cat *)", "Bash(grep *)"], "Bash", bash("cat a.log | grep ERROR")));
  assert.equal(ruleAllows(["Bash(cat *)"], "Bash", bash("cat a.sh | bash")), undefined);
});
t("段首环境变量前缀剥掉后匹配", () => {
  assert.ok(ruleAllows(["Bash(python3 .claude/skills/*)"], "Bash", bash(
    "timeout=60 python3 .claude/skills/release-doc/scripts/get_jenkins_images.py --service x",
  )));
});
t("命令替换一律不命中", () => {
  assert.equal(ruleAllows(["Bash(echo *)"], "Bash", bash("echo $(whoami)")), undefined);
  assert.equal(ruleAllows(["Bash(echo *)"], "Bash", bash("echo `id`")), undefined);
});
t("裸 Bash 规则放行一切(与 Claude 语义对齐)", () => {
  assert.ok(ruleAllows(["Bash"], "Bash", bash("anything at all")));
});
t("空规则/空命令不放行", () => {
  assert.equal(ruleAllows([], "Bash", bash("ls")), undefined);
  assert.equal(ruleAllows(["Bash(ls *)"], "Bash", bash("  ")), undefined);
  assert.equal(ruleAllows(["Bash(ls *)"], "Bash", {}), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
