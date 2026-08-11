// 单元测试: daemon/danger.ts 的 dangerEarlyExit — 运行: npx tsx tests/danger-early-exit.test.ts
//
// 为什么单独给这一个函数写测试: 「danger 的免卡开关」与「askRules / `.claude/**`
// 守卫」的优先级关系, 是本 fork 与上游合并时反复出错的那一处 —— 上游按「来源」
// 接线 (只判 danger), fork 又多出两条同语义的必发卡理由, 每次 rebase 都要重新
// 论证一遍谁压过谁。把真值表钉在这里, 下次谁改坏了测试会先炸。
import assert from "node:assert";
import { dangerEarlyExit, type DangerHit } from "../daemon/danger.js";
import type { Config } from "../shared/config.js";

let passed = 0;
let failed = 0;
const t = (name: string, fn: () => void): void => {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
};

// 只造 dangerEarlyExit 真正读到的那几个字段。
const cfgOf = (o: { mode?: "all" | "danger"; enabled?: boolean; skip?: boolean }): Config =>
  ({
    approval: {
      mode: o.mode ?? "all",
      danger: { enabled: o.enabled ?? true, skip: o.skip ?? false },
    },
  }) as unknown as Config;

const HIT: DangerHit = { rule: "删除文件 rm" };

// ── danger.skip: 命中名单也放行 ────────────────────────────────────────
t("skip=true + 命中名单 → danger_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ skip: true }), HIT, false), "danger_skip");
});

t("skip=true + 未命中 → 不早退 (skip 只管命中的那些)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ skip: true }), undefined, false), undefined);
});

t("skip=false + 命中名单 → 不早退 (正常发卡)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ skip: false }), HIT, false), undefined);
});

// ── danger 模式: 名单之外的放行 ────────────────────────────────────────
t("mode=danger + 未命中 → danger_mode_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), undefined, false), "danger_mode_skip");
});

t("mode=danger + 命中名单 → 不早退 (危险的照样发卡)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), HIT, false), undefined);
});

t("mode=danger + 名单关闭 → 不早退 (不能变成隐蔽全放行)", () => {
  assert.equal(
    dangerEarlyExit(cfgOf({ mode: "danger", enabled: false }), undefined, false),
    undefined,
  );
});

t("mode=all + 未命中 → 不早退 (默认全量审批)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "all" }), undefined, false), undefined);
});

// ── 核心: forcedByOthers 压过 danger 的两个开关 ───────────────────────
// askRules 命中 / `.claude/**` 守卫生效时, 无论 danger 侧怎么配都必须发卡。
t("forcedByOthers 压过 danger_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ skip: true }), HIT, true), undefined);
});

t("forcedByOthers 压过 danger_mode_skip", () => {
  assert.equal(dangerEarlyExit(cfgOf({ mode: "danger" }), undefined, true), undefined);
});

t("forcedByOthers 压过两开关同时打开", () => {
  assert.equal(
    dangerEarlyExit(cfgOf({ mode: "danger", skip: true }), HIT, true),
    undefined,
  );
  assert.equal(
    dangerEarlyExit(cfgOf({ mode: "danger", skip: true }), undefined, true),
    undefined,
  );
});

// 回归钉子: 若把 forcedByOthers 误写成 mustCard (danger 命中即为真),
// 下面这条会变成 undefined —— danger_skip 特性被静默废掉。
t("命中名单 + skip=true + 无其它理由 → 仍然放行 (不能被 mustCard 误伤)", () => {
  assert.equal(dangerEarlyExit(cfgOf({ skip: true }), HIT, false), "danger_skip");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
