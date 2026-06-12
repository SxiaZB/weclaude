#!/usr/bin/env node
// `weclaude init` — interactive onboarding for new users.
// Flow:
//   1. Prompt creds + agent kind + hook toggle.
//   2. Write ~/.weclaude/config.jsonc + secrets.json (split secrets).
//   3. Build (if needed), run `weclaude sync` against chosen agent settings.json,
//      install resident daemon.
//   4. Arm bootstrap claim. Wait for the user to send a magic phrase in IM.
//      That message bypasses allowFrom, sets defaultChat, and adds the sender.
//   5. Demo: spawn `claude -p` with a prompt that exercises Bash → triggers
//      approval card → sleeps → sends final markdown via MCP. End-to-end smoke.
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { input, password, select, confirm } from "@inquirer/prompts";
import { patchJsonc } from "../shared/config-writer.js";
import { expandHome } from "../shared/paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(here, "..", "..");

const CONFIG = "~/.weclaude/config.jsonc";
const SECRETS = "~/.weclaude/secrets.json";
const CLAIM_PHRASE = "将本对话设置为默认会话";

// ── Pretty output (no ink — keep deps light) ─────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const log = (s: string): void => console.log(s);
const step = (n: number, title: string): void =>
  log(`\n${c.cyan(`[${n}/3]`)} ${c.bold(title)}`);

// ── Agent kind → settings.json path ──────────────────────────────────
type AgentKind = "claude" | "claude-internal" | "custom";
type WrcMode = "headless" | "mirror";
const settingsPathFor = (kind: AgentKind, custom?: string): string => {
  switch (kind) {
    case "claude": return "~/.claude/settings.json";
    case "claude-internal": return "~/.claude-internal/settings.json";
    case "custom": return custom ?? "";
  }
};
const claudeBinFor = (kind: AgentKind): string =>
  kind === "claude-internal" ? "claude-internal" : "claude";

// ── HTTP helpers (talk to local daemon) ──────────────────────────────
const DAEMON = "http://127.0.0.1:17890";
const get = async (p: string): Promise<unknown> => {
  const r = await fetch(`${DAEMON}${p}`);
  return r.json().catch(() => ({}));
};
const post = async (p: string, body: unknown): Promise<unknown> => {
  const r = await fetch(`${DAEMON}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Build + install + reload daemon ──────────────────────────────────
const ensureBuild = (): void => {
  if (existsSync(`${REPO}/dist/daemon/index.js`)) return;
  log(c.dim("  building..."));
  const r = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: REPO, stdio: "inherit" });
  if (r.status !== 0) throw new Error("build failed");
};

const runSync = (): void => {
  log(c.dim("  syncing hooks/MCP/env into agent settings.json..."));
  const r = spawnSync(process.execPath, [`${REPO}/dist/cli/sync.js`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("sync failed");
};

const installDaemon = (): void => {
  log(c.dim("  installing resident daemon..."));
  const r = spawnSync("bash", [`${REPO}/scripts/install.sh`], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("install.sh failed");
};

// Register the local repo as a Claude Code marketplace and install the
// `weclaude` plugin from it. This is what wires up `hooks/hooks.json` (so
// `${CLAUDE_PLUGIN_ROOT}` resolves) + `commands/wrc.md` + the MCP server
// declared in `.claude-plugin/plugin.json`. Idempotent: marketplace add
// re-uses the existing entry, install upgrades in place.
const installPlugin = (claudeBin: string): void => {
  log(c.dim(`  注册 marketplace + 安装插件 (${claudeBin}) ...`));
  const m = spawnSync(claudeBin, ["plugin", "marketplace", "add", REPO], { stdio: "inherit" });
  if (m.status !== 0) {
    log(c.yellow(`  ⚠ plugin marketplace add 失败 (退出码 ${m.status}) — hook 可能未注册，可手动:\n     ${claudeBin} plugin marketplace add ${REPO}\n     ${claudeBin} plugin install weclaude@weclaude-local`));
    return;
  }
  const i = spawnSync(claudeBin, ["plugin", "install", "weclaude@weclaude-local", "--scope", "user"], { stdio: "inherit" });
  if (i.status !== 0) {
    log(c.yellow(`  ⚠ plugin install 失败 (退出码 ${i.status}) — 可手动: ${claudeBin} plugin install weclaude@weclaude-local`));
  }
};

const waitDaemonReady = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = (await get("/status")) as { wsConnected?: boolean };
      if (s.wsConnected) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("daemon did not become ready in time");
};

// ── Main flow ────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  log(c.bold("\nweclaude · 新用户引导\n"));
  log(c.dim("  目标：3 步内完成 → IM 授权转发 + 远程 CC 控制可用。\n"));

  if (existsSync(expandHome(CONFIG))) {
    const ok = await confirm({
      message: `检测到已有 ${CONFIG}，覆盖关键字段后继续？`,
      default: false,
    });
    if (!ok) {
      log(c.yellow("已取消。"));
      return;
    }
  }

  // ── Step 1: prompts ────────────────────────────────────────────
  step(1, "采集配置");
  const botId = await input({ message: "智能机器人 botId:", required: true });
  const secret = await password({ message: "机器人 secret:", mask: "•" });
  const agentKind = (await select({
    message: "选择 Claude agent：",
    choices: [
      { name: "claude (Anthropic 官方)", value: "claude" },
      { name: "claude-internal (Tencent 内部)", value: "claude-internal" },
      { name: "自定义路径", value: "custom" },
    ],
    default: "claude-internal",
  })) as AgentKind;
  const customSettings =
    agentKind === "custom"
      ? await input({ message: "settings.json 绝对路径:", required: true })
      : "";
  const wrcMode = (await select({
    message: "选择 wrc 模式：",
    choices: [
      {
        name: "mirror (推荐：远程消息注入到本地 tmux 里的 claude 会话，CLI 可见双向同步)",
        value: "mirror",
      },
      {
        name: "headless (远程消息触发新的 `claude -p` 子进程，CLI 不可见)",
        value: "headless",
      },
    ],
    default: "mirror",
  })) as WrcMode;
  const enableHook = await confirm({
    message: "开启 PreToolUse 授权拦截 hook？(IM 按钮卡片授权)",
    default: true,
  });

  const settings = settingsPathFor(agentKind, customSettings);
  const claudeBin = claudeBinFor(agentKind);

  // ── Step 1b: write configs ─────────────────────────────────────
  log(c.dim(`  写入 ${CONFIG} ...`));
  patchJsonc(CONFIG, [
    { path: ["bot", "websocketUrl"], value: "wss://openws.work.weixin.qq.com" },
    { path: ["defaultChat"], value: "" },
    { path: ["wrc", "mode"], value: wrcMode },
    { path: ["wrc", "claudeBin"], value: claudeBin },
    { path: ["wrc", "cwd"], value: "~/.weclaude/workspace" },
    { path: ["wrc", "allowFrom"], value: [] },
    { path: ["approval", "enabled"], value: enableHook },
    { path: ["approval", "matcher"], value: ".*" },
    { path: ["sync", "targets"], value: [{ kind: "claude-internal", settingsPath: settings, scope: "user" }] },
  ]);
  log(c.dim(`  写入 ${SECRETS} ...`));
  patchJsonc(SECRETS, [
    { path: ["bot", "botId"], value: botId },
    { path: ["bot", "secret"], value: secret },
  ]);

  ensureBuild();
  if (enableHook) runSync();
  if (enableHook) installPlugin(claudeBin);
  installDaemon();

  log(c.dim("  等待 daemon 上线..."));
  await waitDaemonReady(20_000);
  log(c.green("  ✓ daemon ready"));

  // ── Step 2: claim default chat ─────────────────────────────────
  step(2, "绑定默认会话");
  await post("/claim/start", { phrase: CLAIM_PHRASE, ttlSec: 600 });
  log(`\n  ${c.bold("→ 现在打开企业微信，给该机器人发送：")}`);
  log(`     ${c.cyan(CLAIM_PHRASE)}\n`);
  log(c.dim("  等待中... (10 分钟超时)"));

  const claimed = await pollClaim(10 * 60_000);
  if (!claimed) {
    log(c.red("\n  超时未收到消息。可稍后手动编辑 config 的 defaultChat / wrc.allowFrom。"));
    return;
  }
  log(c.green(`\n  ✓ 已绑定: ${c.bold(claimed)}`));

  // ── Step 3: live demo ──────────────────────────────────────────
  step(3, "授权转发演示");
  if (!enableHook) {
    log(c.yellow("  hook 未启用 — 跳过授权演示。"));
    log(c.green("\n✅ 引导完成。"));
    return;
  }
  if (wrcMode === "mirror") {
    // Mirror 路径:不能用 `claude -p`(脱离 tmux),改为主动起 tmux+claude pane,
    // 让用户立即看到 mirror 形态;之后在 WeCom 发任意消息即可走完整 mirror 流。
    log(c.dim("  正在拉起 tmux+claude pane (mirror 模式) ..."));
    const r = (await post("/mirror/spawn", { target: claimed })) as {
      ok?: boolean; reason?: string; tmuxSession?: string; tmuxPane?: string; sessionId?: string;
    };
    if (!r.ok) {
      log(c.red(`  ✗ /mirror/spawn 失败: ${r.reason ?? "unknown"}`));
      log(c.yellow("  可手动: tmux new-session -s weclaude 后跑 claude;或在 WeCom 发任意消息触发 auto-spawn。"));
      return;
    }
    log(c.green(`  ✓ tmux session=${c.bold(r.tmuxSession ?? "")} pane=${r.tmuxPane ?? ""} sid=${r.sessionId ?? ""}`));
    log(c.dim(`  附加: tmux attach -t ${r.tmuxSession ?? "weclaude"}`));
    log(c.dim("  现在在 WeCom 发任意消息,daemon 会注入到该 pane 里的 claude;首次工具调用会推授权卡片。"));
    log(c.green("\n✅ 引导完成。后续可用 `weclaude status` / `weclaude logs -f` 观察。"));
    return;
  }
  log(c.dim("  即将启动 claude (headless),触发一次 Bash 授权 → 你会在 WeCom 收到按钮卡片。"));
  log(c.dim("  点击「✅」放行即可观察后续推送。\n"));
  await runDemo(claudeBin);
  log(c.green("\n✅ 引导完成。后续可用 `weclaude status` / `weclaude logs -f` 观察。"));
};

const pollClaim = async (timeoutMs: number): Promise<string | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = (await get("/claim/status")) as {
      claimed?: { principal: string } | null;
      armed?: boolean;
    };
    if (s.claimed) return s.claimed.principal;
    if (s.armed === false) break;
    await sleep(1000);
  }
  return undefined;
};

const DEMO_PROMPT =
  [
    "请按顺序执行,不要输出多余解释:",
    "1. 用 Bash 工具运行 `ls ~/.weclaude/` 看一下 weclaude 的状态目录里都有哪些文件。",
    "2. 用 Read 工具读取 ~/.weclaude/config.jsonc 的前 30 行,告诉我 wrc.mode 当前是什么值。",
    "3. 用一句话总结。",
  ].join("\n");

const runDemo = (claudeBin: string): Promise<void> =>
  new Promise((resolve) => {
    const proc = spawn(claudeBin, ["-p", DEMO_PROMPT], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, HOME: process.env.HOME ?? homedir() },
    });
    proc.on("close", () => resolve());
    proc.on("error", (e) => {
      log(c.red(`  demo spawn 失败: ${e.message}`));
      resolve();
    });
  });

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(c.red(`\n[weclaude-init] ${(e as Error).message}`));
  process.exit(1);
});

// keep loadConfig reference reachable for tree-shaking sanity (used by sub-binaries)
void readFileSync;
