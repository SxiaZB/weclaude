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
