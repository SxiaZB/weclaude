#!/usr/bin/env node
// `wezard migrate` — one-shot upgrade from a pre-rename `weclaude` install.
//
// The two names collide on everything that matters (port 17890, the plugin id,
// the hook/MCP/env blocks inside each agent's settings.json), so they can never
// run side by side. Order below is load-bearing:
//   1. stop + deregister the old daemon      — frees :17890 before step 5
//   2. drop the old plugin + marketplace     — else the hook fires twice
//   3. copy ~/.weclaude → ~/.wezard, rewriting only *path-anchored* mentions
//   4. re-sync settings.json                 — sync.ts strips the WECLAUDE_* block
//   5. install + start the daemon under the new label
//
// Non-destructive by default: the old state dir is left untouched (`--purge`
// removes it) so a failed migration is a `rm -rf ~/.wezard` away from a retry.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { confirm } from "@inquirer/prompts";
import { loadConfig } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = pathResolve(here, "..", "..");

// Everything the old install owned, by name.
const OLD = {
  tilde: "~/.weclaude",
  label: "com.weclaude.daemon",
  unit: "weclaude.service",
  plugin: "weclaude@weclaude-local",
  marketplace: "weclaude-local",
} as const;
const NEW_TILDE = "~/.wezard";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const log = (s: string): void => console.log(s);

interface Opts { dryRun: boolean; force: boolean; purge: boolean; yes: boolean }
const parseArgs = (argv: string[]): Opts => ({
  dryRun: argv.includes("--dry-run"),
  force: argv.includes("--force"),
  purge: argv.includes("--purge"),
  yes: argv.includes("--yes") || argv.includes("-y"),
});

// ── Shell helpers ────────────────────────────────────────────────────
// Every teardown step is best-effort: a half-uninstalled old release (plist
// gone but plugin still registered, or vice versa) must not abort the swap.
const quiet = (cmd: string, args: string[]): boolean =>
  spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const loud = (cmd: string, args: string[], cwd?: string): void => {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status ?? r.signal})`);
};
const has = (bin: string): boolean => quiet("which", [bin]);

// ── 1. Stop + deregister the old daemon ──────────────────────────────
const stopOldDaemon = async (dry: boolean): Promise<void> => {
  log(c.dim("  [1/5] 停止旧 daemon ..."));
  if (dry) return;
  // HTTP shutdown first: lets the daemon flush state before launchd kills it.
  await fetch("http://127.0.0.1:17890/shutdown", { method: "POST" }).catch(() => undefined);
  if (process.platform === "darwin") {
    const plist = join(homedir(), "Library/LaunchAgents", `${OLD.label}.plist`);
    quiet("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${OLD.label}`]);
    quiet("launchctl", ["unload", plist]);
    if (existsSync(plist)) { rmSync(plist); log(c.dim(`        removed ${plist}`)); }
  } else {
    const unit = join(homedir(), ".config/systemd/user", OLD.unit);
    quiet("systemctl", ["--user", "disable", "--now", OLD.unit]);
    if (existsSync(unit)) { rmSync(unit); log(c.dim(`        removed ${unit}`)); }
    quiet("systemctl", ["--user", "daemon-reload"]);
  }
  quiet("pkill", ["-f", "weclaude/dist/daemon/index.js"]);
};

// ── 2. Drop the old Claude Code plugin ───────────────────────────────
// Both bins are tried because either could have run the original `init`.
const dropOldPlugin = (dry: boolean): void => {
  log(c.dim("  [2/5] 卸载旧插件 + marketplace ..."));
  if (dry) return;
  for (const bin of ["claude", "claude-internal", "codebuddy"]) {
    if (!has(bin)) continue;
    if (quiet(bin, ["plugin", "uninstall", OLD.plugin])) log(c.dim(`        ${bin}: plugin uninstalled`));
    if (quiet(bin, ["plugin", "marketplace", "remove", OLD.marketplace])) log(c.dim(`        ${bin}: marketplace removed`));
  }
};

// ── 3. Copy state, rewriting path-anchored mentions ──────────────────
// Only `~/.weclaude` and `$HOME/.weclaude` are rewritten — a blanket
// s/weclaude/wezard/ would corrupt every recorded cwd, transcript path and
// session key belonging to a project that merely *happens* to be named
// weclaude (this repo, for one).
const REWRITABLE = /\.(jsonc?|txt|ya?ml|sh)$/;
const MAX_REWRITE_BYTES = 8 * 1024 * 1024;

const retarget = (txt: string): string =>
  txt
    .replaceAll(`${homedir()}/.weclaude`, `${homedir()}/.wezard`)
    .replaceAll("~/.weclaude", NEW_TILDE);

const rewriteTree = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    const abs = join(dir, e.name);
    if (e.isDirectory()) return n + rewriteTree(abs);
    if (!e.isFile() || !REWRITABLE.test(e.name)) return n;
    if (statSync(abs).size > MAX_REWRITE_BYTES) return n;
    const txt = readFileSync(abs, "utf8");
    const next = retarget(txt);
    if (next === txt) return n;
    writeFileSync(abs, next, "utf8");
    return n + 1;
  }, 0);

const copyState = (oldDir: string, newDir: string, o: Opts): void => {
  log(c.dim(`  [3/5] 迁移状态 ${OLD.tilde} → ${NEW_TILDE} ...`));
  if (existsSync(newDir) && !o.force) {
    throw new Error(`${NEW_TILDE} 已存在 — 用 --force 覆盖, 或先 rm -rf ${NEW_TILDE}`);
  }
  if (o.dryRun) return;
  cpSync(oldDir, newDir, { recursive: true, force: true });
  const touched = rewriteTree(newDir);
  log(c.dim(`        copied, ${touched} 个文件里的路径已改写`));
};

// ── 4/5. Re-register under the new name ──────────────────────────────
const ensureBuild = (): void => {
  if (existsSync(`${REPO}/dist/daemon/index.js`)) return;
  log(c.dim("        building..."));
  loud("npx", ["tsc", "-p", "tsconfig.json"], REPO);
};

// sync.targets is the authoritative list of agents this install feeds; the
// plugin only exists for the claude family (codebuddy is settings.json-only).
const pluginBinsFor = (targets: Array<{ kind: string; settingsPath: string }>): string[] => [
  ...new Set(
    targets
      .filter((t) => t.kind !== "codebuddy")
      .map((t) => (t.settingsPath.includes(".claude-internal") ? "claude-internal" : "claude")),
  ),
];

const installPlugin = (bin: string): void => {
  if (!has(bin)) { log(c.yellow(`        ${bin} 不在 PATH — 跳过插件注册, 之后手动跑 wezard init`)); return; }
  loud(bin, ["plugin", "marketplace", "add", REPO]);
  loud(bin, ["plugin", "install", "wezard@wezard-local", "--scope", "user"]);
  log(c.dim(`        ${bin}: plugin installed`));
};

const reinstall = (o: Opts): void => {
  log(c.dim("  [4/5] 重写 settings.json (hooks / MCP / env) ..."));
  if (!o.dryRun) {
    ensureBuild();
    loud(process.execPath, [`${REPO}/dist/cli/sync.js`]);
    const { config } = loadConfig();
    for (const bin of pluginBinsFor(config.sync.targets)) installPlugin(bin);
  }
  log(c.dim("  [5/5] 安装 resident daemon (com.wezard.daemon) ..."));
  if (!o.dryRun) loud("bash", [`${REPO}/scripts/install.sh`]);
};

// ── Main ─────────────────────────────────────────────────────────────
const main = async (): Promise<void> => {
  const o = parseArgs(process.argv.slice(2));
  const oldDir = expandHome(OLD.tilde);
  const newDir = expandHome(NEW_TILDE);

  log(c.bold("\nwezard migrate · 从 weclaude 迁移\n"));
  if (!existsSync(oldDir)) {
    log(c.yellow(`未发现 ${OLD.tilde} — 没有可迁移的旧安装。`));
    log(c.dim("  全新安装请直接跑 `wezard init`。"));
    return;
  }
  log(`  ${OLD.tilde} → ${NEW_TILDE}   ${c.dim(o.dryRun ? "(dry-run)" : "")}`);
  log(c.dim("  会停掉旧 daemon、卸载旧插件、复制状态、重新注册 hooks/MCP/daemon。\n"));

  if (!o.yes && !o.dryRun) {
    const ok = await confirm({ message: "继续？", default: true });
    if (!ok) { log(c.yellow("已取消。")); return; }
  }

  await stopOldDaemon(o.dryRun);
  dropOldPlugin(o.dryRun);
  copyState(oldDir, newDir, o);
  reinstall(o);

  if (o.purge && !o.dryRun) {
    rmSync(oldDir, { recursive: true, force: true });
    log(c.dim(`  已删除 ${OLD.tilde}`));
  }

  log(c.green("\n✅ 迁移完成。"));
  log(c.dim(`  检查: wezard status / wezard logs -f`));
  // The old npm package still owns a `weclaude` bin on $PATH; its launchd job
  // is gone, so it's inert — but leaving it invites running the wrong CLI.
  log(c.dim("  收尾: npm uninstall -g weclaude" + (o.purge ? "" : `  &&  rm -rf ${OLD.tilde}`)));
  log(c.dim("  注意: tmuxPrefix 默认由 `weclaude` 变为 `wezard` — 已绑定的旧 pane 仍按存量 id 工作,"));
  log(c.dim("        新会话会开在 `wezard` tmux session 里 (显式配过 wrc.tmuxPrefix 的不受影响)。"));
};

main().catch((e) => {
  console.error(c.red(`\n[wezard-migrate] ${(e as Error).message}`));
  process.exit(1);
});
