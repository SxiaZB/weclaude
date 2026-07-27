// 单元测试: shared/allow-rules.ts + shared/claude-permissions.ts — 运行: npx tsx tests/allow-rules.test.ts
import assert from "node:assert";
import { alwaysAllowRulesFor, parseRule, ruleAllows, ruleMatchesAny } from "../shared/allow-rules.js";
import { mapClaudePermissions } from "../shared/claude-permissions.js";

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

// ── ruleMatchesAny (deny/ask 语义: 任一段命中) ──────────────────────────
t("deny/ask: 复合命令任一段命中即命中", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("cd /tmp && rm -rf x")), "Bash(rm *)");
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("cd /tmp && ls")), undefined);
});
t("deny/ask: 含 $() 的段仍按字面参与匹配", () => {
  assert.equal(ruleMatchesAny(["Bash(rm *)"], "Bash", bash("rm -rf $(pwd)/x")), "Bash(rm *)");
});
t("deny/ask: 非 Bash 工具与 mcp server 级匹配", () => {
  assert.equal(ruleMatchesAny(["Write"], "Write", {}), "Write");
  assert.equal(ruleMatchesAny(["mcp__wecom-mcp"], "mcp__wecom-mcp__send_message", {}), "mcp__wecom-mcp");
});
t("deny/ask: 对交互卡工具无硬保护(收紧方向 fail-closed)", () => {
  assert.equal(ruleMatchesAny(["AskUserQuestion"], "AskUserQuestion", {}), "AskUserQuestion");
});

// ── alwaysAllowRulesFor (「✅总是」规则生成) ─────────────────────────────
t("总是: Bash 取命令+子命令做前缀规则", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("git log --oneline -5")), ["Bash(git log *)"]);
});
t("总是: 第二个 token 是 flag 时退化为单命令", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("ls -la /tmp")), ["Bash(ls *)"]);
});
t("总是: 路径型第二 token 保留(精确到脚本)", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash("python3 .claude/skills/x/run.py --a b")),
    ["Bash(python3 .claude/skills/x/run.py *)"],
  );
});
t("总是: 复合命令逐段生成并去重", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash("cd /a && python3 x.py | head -3")),
    ["Bash(cd /a *)", "Bash(python3 x.py *)", "Bash(head *)"],
  );
});
t("总是: 段首环境变量前缀剥掉后生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("timeout=60 python3 x.py")), ["Bash(python3 x.py *)"]);
});
t("总是: 含 $()/反引号不生成(返回空)", () => {
  assert.deepEqual(alwaysAllowRulesFor("Bash", bash("echo $(whoami)")), []);
});
t("总是: 引号内的管道符被误切时不生成垃圾规则(实战回归)", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash('grep -h -iE "proxy|7890|1087" ~/.zshrc | head -8')),
    [],
  );
});
t("总是: 引号配对的正常管道命令不受影响", () => {
  assert.deepEqual(
    alwaysAllowRulesFor("Bash", bash('grep "ERROR" app.log | head -3')),
    ["Bash(grep *)", "Bash(head *)"],
  );
});
t("总是: 非 Bash 工具生成裸工具名", () => {
  assert.deepEqual(alwaysAllowRulesFor("Write", {}), ["Write"]);
  assert.deepEqual(alwaysAllowRulesFor("mcp__jira__get_issue", {}), ["mcp__jira__get_issue"]);
});
t("总是: 交互卡工具不生成", () => {
  assert.deepEqual(alwaysAllowRulesFor("AskUserQuestion", {}), []);
});
t("总是: 生成的规则能匹配原命令(闭环)", () => {
  const cmd = 'date "+%Y%m%d"; cd /a && timeout=60 python3 .claude/skills/x/run.py --b';
  const rules = alwaysAllowRulesFor("Bash", bash(cmd));
  assert.ok(ruleAllows(rules, "Bash", bash(cmd)), `generated rules should allow original: ${rules.join(", ")}`);
});

// ── mapClaudePermissions (Claude settings.json 导入映射) ────────────────
t("导入: 三层各自映射且保序去重", () => {
  const m = mapClaudePermissions({
    allow: ["Read", "Bash(git log *)", "mcp__jira", "Read"],
    ask: ["Bash(rm *)", "Bash(sudo *)"],
    deny: ["Bash(dd *)"],
  });
  assert.deepEqual(m.allow, ["Read", "Bash(git log *)", "mcp__jira"]);
  assert.deepEqual(m.ask, ["Bash(rm *)", "Bash(sudo *)"]);
  assert.deepEqual(m.deny, ["Bash(dd *)"]);
  assert.deepEqual(m.skipped, []);
});
t("导入: 引擎不支持的 specifier 跳过并汇报", () => {
  const m = mapClaudePermissions({ allow: ["WebFetch(domain:github.com)", "Read(/etc/*)", "Glob"] });
  assert.deepEqual(m.allow, ["Glob"]);
  assert.deepEqual(m.skipped, ["WebFetch(domain:github.com)", "Read(/etc/*)"]);
});
t("导入: allow 侧交互卡工具跳过, ask/deny 侧不受限", () => {
  const m = mapClaudePermissions({ allow: ["AskUserQuestion"], ask: ["AskUserQuestion"] });
  assert.deepEqual(m.allow, []);
  assert.deepEqual(m.ask, ["AskUserQuestion"]);
  assert.deepEqual(m.skipped, ["AskUserQuestion"]);
});
t("导入: 非法/空/非数组输入安全兜底", () => {
  const m = mapClaudePermissions({ allow: "Read" as unknown, ask: [42, "", "  "] as unknown, deny: undefined });
  assert.deepEqual(m.allow, []);
  assert.deepEqual(m.ask, []);
  assert.deepEqual(m.deny, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
