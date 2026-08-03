// 单元测试: shared/claude-config-path.ts — 运行: npx tsx tests/claude-config-path.test.ts
import assert from "node:assert";
import { claudeConfigWrite, isClaudeConfigPath } from "../shared/claude-config-path.js";

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

const bash = (command: string): ReturnType<typeof claudeConfigWrite> => claudeConfigWrite("Bash", { command });

// ── 现场样本: 2026-07-28 两次死锁的原命令 ───────────────────────────────
t("命中: 死锁现场 mkdir + ls（第二条，被 allowRules 放行那次）", () => {
  const hit = bash("mkdir -p ontology-curator/skills/ontology-iterate ontology-curator/workspace ontology-curator/.claude/skills && ls -a ontology-curator");
  assert.equal(hit?.why, "bash-write");
  assert.equal(hit?.path, "ontology-curator/.claude/skills");
});

t("命中: 死锁现场 mkdir + ln（第一条，被 ⏱窗口放行那次）", () => {
  const hit = bash("mkdir -p ontology-curator/.claude/skills && ln -sfn ../../skills/ontology-iterate ontology-curator/.claude/skills/ontology-iterate && echo done");
  assert.equal(hit?.why, "bash-write");
});

// ── Bash: 写 vs 读 ─────────────────────────────────────────────────────
t("命中: 写命令的各种形态", () => {
  for (const cmd of [
    "mkdir ~/.claude/skills/x",
    "cp a.md ~/.claude/skills/b.md",
    "mv ~/.claude/settings.json /tmp/bak",
    "rm -f ~/.claude/settings.local.json",
    "touch .claude/hooks/x.sh",
    'ln -sfn /real/path "$HOME/.claude/skills/foo"',
    "chmod +x ~/.claude/hooks/pre.sh",
    "/bin/mkdir -p ~/.claude/agents",
    "sed -i '' 's/a/b/' ~/.claude/settings.json",
    "echo '{}' > ~/.claude/settings.json",
    "cat tpl.json >> .claude/settings.json",
  ]) {
    assert.ok(bash(cmd), `应命中: ${cmd}`);
  }
});

t("不命中: 只读命令碰 .claude（读不触发原生框，拦了纯属误伤）", () => {
  for (const cmd of [
    "cat ~/.claude/settings.json",
    "ls -a ~/.claude/skills",
    "grep -rn allowRules ~/.claude/settings.json",
    "readlink .claude/skills/fix-bug",
    "sed -n '1,20p' ~/.claude/settings.json",
    "wc -l ~/.claude/settings.json",
  ]) {
    assert.equal(bash(cmd), undefined, `不应命中: ${cmd}`);
  }
});

t("不命中: 写命令但不碰 .claude", () => {
  for (const cmd of [
    "mkdir -p ~/Code/foo/bar",
    "rm -rf /tmp/scratch",
    "echo hi > /tmp/x",
    "git commit -m 'x'",
  ]) {
    assert.equal(bash(cmd), undefined, `不应命中: ${cmd}`);
  }
});

t("命中: 复合命令里只有后段写 .claude（逐段判定）", () => {
  assert.ok(bash("cd ~/work-agent && echo x > product-engineer/.claude/settings.json"));
});

t("命中: 引号未闭合 → 整条当一段 fail-closed", () => {
  assert.ok(bash("mkdir -p '~/.claude/skills"));
});

t("不命中: .claude 只是名字的一部分", () => {
  assert.equal(bash("mkdir -p ~/my.claude-backup"), undefined);
  assert.equal(bash("mkdir -p ~/.claudex/skills"), undefined);
});

// ── 重定向: 只看目标, 不看"段里出现过 >" ────────────────────────────────
// 2026-08-03 现场: 住在 .claude/skills 下的 skill 脚本 + `2>/dev/null`, 同一会话
// 被守卫连发 13 张卡。执行脚本不写配置面, CC 不立原生框, 守卫本无用武之地。
t("不命中: 执行 .claude 下的脚本 + 重定向到别处（现场样本）", () => {
  for (const cmd of [
    'python3 /Users/x/qm-brain/.claude/skills/ylog-query/scripts/run_ylog.py --service pmdj --line-limit 200 2>/dev/null | python3 -c "print(1)"',
    "bash ~/.claude/skills/foo/run.sh > /tmp/out.log",
    "bash ~/.claude/skills/foo/run.sh 2>&1 | tee /tmp/out.log",
    "cat ~/.claude/settings.json > /tmp/bak.json",
    "python3 .claude/skills/x/gen.py >> /tmp/acc.txt",
  ]) {
    assert.equal(bash(cmd), undefined, `不应命中: ${cmd}`);
  }
});

t("命中: 重定向目标就是 .claude（守卫真正要拦的）", () => {
  for (const cmd of [
    "python3 gen.py > ~/.claude/settings.json",
    "python3 gen.py >~/.claude/settings.json",
    "curl -s https://x/y 2> .claude/err.log",
    "python3 gen.py &> ~/.claude/out.log",
  ]) {
    const hit = bash(cmd);
    assert.equal(hit?.why, "bash-write", `应命中: ${cmd}`);
    assert.ok(hit && isClaudeConfigPath(hit.path), `path 应是重定向目标: ${cmd} → ${hit?.path}`);
  }
});

t("已知盲点: `>|` noclobber 覆写 —— splitSegments 把 `|` 当管道切段(既有行为)", () => {
  // 改 splitSegments 会牵动 allow-rules 的分段语义, 为这个几乎不出现的写法不划算。
  assert.equal(bash("python3 gen.py >| ~/.claude/settings.json"), undefined);
});

// ── 变量间接 ───────────────────────────────────────────────────────────
// 写命令段里没有字面 `.claude`, 但赋值的值就在同一条命令里 → 展开一层再判。
// 不展开的话: 规则侧纯赋值段被当无害段跳过后, `Bash(rm *)` 会静默放行这条命令,
// 而 CC 的原生确认框照样立起 → 不发卡 + pane 阻塞 (本文件存在的理由)。
t("命中: 变量间接的写入", () => {
  const hit = bash("f=~/.claude/settings.json; rm $f");
  assert.equal(hit?.why, "bash-write");
  assert.equal(hit?.path, "~/.claude/settings.json");
});
t("命中: 花括号引用 / export 声明头 / 重定向到变量", () => {
  assert.equal(bash("export d=~/.claude/skills && mkdir -p ${d}/x")?.path, "~/.claude/skills/x");
  assert.ok(bash("f=.claude/settings.json; echo '{}' > $f"));
  assert.ok(bash('f="~/.claude/settings.json"; tee $f < /tmp/new.json'));
});
t("不命中: 变量间接的只读命令(不误伤)", () => {
  assert.equal(bash("f=~/.claude/settings.json; cat $f"), undefined);
  assert.equal(bash("f=~/.claude/settings.json"), undefined);
});
t("不命中: 变量值不碰 .claude", () => {
  assert.equal(bash("f=/tmp/x; rm $f"), undefined);
});
t("已知盲点: 动态赋值值收不到(不做猜测)", () => {
  assert.equal(bash("f=$(cat /tmp/target); rm $f"), undefined);
});

// ── 文件类工具 ─────────────────────────────────────────────────────────
t("命中: Edit/Write/NotebookEdit 的 .claude 路径", () => {
  assert.equal(claudeConfigWrite("Edit", { file_path: "/Users/x/.claude/settings.json" })?.why, "file");
  assert.ok(claudeConfigWrite("Write", { file_path: "product-engineer/.claude/skills/fix-bug/SKILL.md" }));
  assert.ok(claudeConfigWrite("MultiEdit", { file_path: "~/.claude/CLAUDE.md" }));
  assert.ok(claudeConfigWrite("NotebookEdit", { notebook_path: "~/.claude/x.ipynb" }));
});

t("不命中: 文件类工具改别处 / Read 类工具", () => {
  assert.equal(claudeConfigWrite("Edit", { file_path: "/Users/x/Code/app/src/main.ts" }), undefined);
  assert.equal(claudeConfigWrite("Read", { file_path: "/Users/x/.claude/settings.json" }), undefined);
  assert.equal(claudeConfigWrite("Grep", { pattern: ".claude" }), undefined);
});

t("不命中: 输入残缺不抛异常", () => {
  assert.equal(claudeConfigWrite("Bash", undefined), undefined);
  assert.equal(claudeConfigWrite("Bash", { command: "" }), undefined);
  assert.equal(claudeConfigWrite("Edit", {}), undefined);
});

// ── 路径判定本身 ───────────────────────────────────────────────────────
t("isClaudeConfigPath: 段级比较", () => {
  assert.equal(isClaudeConfigPath("~/.claude/settings.json"), true);
  assert.equal(isClaudeConfigPath("a/b/.claude"), true);
  assert.equal(isClaudeConfigPath('".claude/skills"'), true);
  assert.equal(isClaudeConfigPath("~/.claude-backup/x"), false);
  assert.equal(isClaudeConfigPath(""), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
