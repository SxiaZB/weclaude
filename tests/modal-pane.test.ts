// 单元测试: shared/modal-pane.ts — 运行: npx tsx tests/modal-pane.test.ts
import assert from "node:assert";
import { isModalPane } from "../shared/modal-pane.js";

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

// ── 真实样本: .claude/** 编辑确认框 ─────────────────────────────────────
// 现场抓取 (tmux capture-pane -p)，即导致本 guard 存在的那次死锁。
const EDIT_SETTINGS_CONFIRM = `
────────────────────────────────────────────────────────────────────────────────
 Edit file
 .claude/skills/fix-bug/SKILL.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 158 -| 前端验证失败 | 回阶段 2 重修 |
 158 +| 字段约定缺失/矛盾 | 停下问用户，不自行拍口径（§1.0） |
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to SKILL.md?
 ❯ 1. Yes
   2. Yes, and allow Claude to edit its own settings for this session
   3. No

 Esc to cancel · Tab to amend`;

// 同一 pane 在确认框被应答后的空闲态。
const IDLE_INPUT_BOX = `
      163  任务中断时记录进度，提示可从中断点继续。
  ⎿  1 skill available

✻ Cultivating… (6m 22s · ↓ 14.6k tokens)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  🤖 Opus 5 | 📁 product-engineer | ⚡️ 44.0% · 88.0k tokens   ● high · /effort`;

t("命中: .claude 编辑确认框", () => {
  const v = isModalPane(EDIT_SETTINGS_CONFIRM);
  assert.equal(v.modal, true);
  assert.equal(v.title, "Do you want to make this edit to SKILL.md?");
});

t("放行: 空闲输入框 (含 ❯ 提示符, 无选项行/footer)", () => {
  assert.equal(isModalPane(IDLE_INPUT_BOX).modal, false);
});

t("放行: 空 pane (capture 失败降级为空串)", () => {
  assert.equal(isModalPane("").modal, false);
});

// ── 两个信号缺一不可 ────────────────────────────────────────────────────
t("放行: 只有 footer 没有选项行", () => {
  assert.equal(isModalPane("some output\n\n Esc to cancel · Tab to amend").modal, false);
});

t("放行: 只有选项行没有 footer", () => {
  assert.equal(isModalPane(" ❯ 1. Yes\n   2. No").modal, false);
});

// 用户消息本身在讲某个 picker —— 引号里的内容不该把自己挡在门外。
t("放行: 用户消息里提到 'Esc to cancel' 但无选项行", () => {
  const pane = `
────────────────────────────────────────────────────────────────────────────────
❯ 帮我看看为什么 pane 底下会出现 Esc to cancel
────────────────────────────────────────────────────────────────────────────────`;
  assert.equal(isModalPane(pane).modal, false);
});

t("放行: 用户消息里带编号列表但无 footer", () => {
  const pane = `
❯ 分三步做:
   1. 先拉最新主干
   2. 再开分支
   3. 最后提 MR`;
  assert.equal(isModalPane(pane).modal, false);
});

// ── 其它 picker 形态 ────────────────────────────────────────────────────
t("命中: 无可识别标题时仍判定 modal, title 为 undefined", () => {
  const pane = `
 Select a model
 ❯ 1. Opus 5
   2. Sonnet 5

 Esc to cancel`;
  const v = isModalPane(pane);
  assert.equal(v.modal, true);
  assert.equal(v.title, undefined);
});

t("命中: 高亮项不是第一个 (> 变体 + 非首行选中)", () => {
  const pane = `
 Would you like to proceed?
   1. Yes
 > 2. No

 Esc to cancel`;
  const v = isModalPane(pane);
  assert.equal(v.modal, true);
  assert.equal(v.title, "Would you like to proceed?");
});

t("footer 大小写不敏感", () => {
  assert.equal(isModalPane(" ❯ 1. Yes\n\n ESC TO CANCEL").modal, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
