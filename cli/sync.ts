// `weclaude sync` — write weclaude's hooks / MCP / env into target settings.json files
// (e.g. ~/.claude/settings.json so claude-internal wrappers pick them up).
// Idempotent + reversible via per-target lock manifest in ~/.weclaude/sync.lock.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { loadConfig } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";

// ── Plugin root resolution ────────────────────────────────────────────
// dist/cli/sync.js → repo root is two `..` up.
const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = pathResolve(here, "..", "..");

const MCP_ENTRY = `${PLUGIN_ROOT}/dist/mcp/server.js`;
const LOCK_FILE = expandHome("~/.weclaude/sync.lock.json");
const MARKER = "weclaude";

interface Lock {
  targets: Record<string, { wroteHooks: boolean; wroteMcp: boolean; wroteEnv: string[] }>;
}

const readLock = (): Lock => {
  if (!existsSync(LOCK_FILE)) return { targets: {} };
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  } catch {
    return { targets: {} };
  }
};
const writeLock = (l: Lock): void => {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, JSON.stringify(l, null, 2));
};

const readJson = (p: string): Record<string, unknown> => {
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, "utf8");
  return (parseJsonc(txt) ?? {}) as Record<string, unknown>;
};
const writeJson = (p: string, obj: unknown): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
};

// ── Hook strip ───────────────────────────────────────────────────────
// Hook registration is owned by the Claude Code plugin (`hooks/hooks.json`
// + `${CLAUDE_PLUGIN_ROOT}`). `weclaude init` runs `claude plugin install`
// to wire it up. We keep stripHooks only to clean up legacy settings.json
// entries from earlier installs — leaving both registered fires the hook
// twice per tool call → duplicate approval cards.
interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number; _managedBy?: string }>;
  _managedBy?: string;
}

const stripHooks = (settings: Record<string, unknown>): void => {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return;
  const list = (hooks.PreToolUse as HookEntry[] | undefined) ?? [];
  hooks.PreToolUse = list.filter((e) => e._managedBy !== MARKER);
  if ((hooks.PreToolUse as HookEntry[]).length === 0) delete hooks.PreToolUse;
};

// ── MCP upsert ────────────────────────────────────────────────────────
const upsertMcp = (settings: Record<string, unknown>): void => {
  const m = ((settings.mcpServers as Record<string, unknown>) ??= {});
  // strip legacy `wecom` entry from earlier installs (renamed to weclaude).
  const legacy = m.wecom as Record<string, unknown> | undefined;
  if (legacy?._managedBy === MARKER) delete m.wecom;
  m.weclaude = {
    command: "node",
    args: [MCP_ENTRY],
    _managedBy: MARKER,
  };
};
const stripMcp = (settings: Record<string, unknown>): void => {
  const m = settings.mcpServers as Record<string, unknown> | undefined;
  if (!m) return;
  for (const k of ["weclaude", "wecom"]) {
    const cur = m[k] as Record<string, unknown> | undefined;
    if (cur?._managedBy === MARKER) delete m[k];
  }
};

// ── Env upsert ────────────────────────────────────────────────────────
const ENV_KEYS = [
  "WECLAUDE_DAEMON_BASE",
  "WECLAUDE_DAEMON_URL",
  "WECLAUDE_STATE_DIR",
  "WECLAUDE_HOOK_FALLBACK",
];
interface EnvVals {
  base: string;
  stateDir: string;
  hookFallback: "ask" | "allow" | "deny";
}
const upsertEnv = (settings: Record<string, unknown>, v: EnvVals): string[] => {
  const env = ((settings.env as Record<string, unknown>) ??= {});
  env.WECLAUDE_DAEMON_BASE = v.base;
  env.WECLAUDE_DAEMON_URL = `${v.base}/approve`;
  env.WECLAUDE_STATE_DIR = expandHome(v.stateDir);
  env.WECLAUDE_HOOK_FALLBACK = v.hookFallback;
  return ENV_KEYS;
};
const stripEnv = (settings: Record<string, unknown>): void => {
  const env = settings.env as Record<string, unknown> | undefined;
  if (!env) return;
  for (const k of ENV_KEYS) delete env[k];
};

// ── Drivers ───────────────────────────────────────────────────────────
const targetKey = (path: string): string => expandHome(path);

interface SyncOpts { remove?: boolean }

const syncOne = (settingsPath: string, opts: SyncOpts, lock: Lock, env: EnvVals): void => {
  const abs = expandHome(settingsPath);
  const settings = readJson(abs);

  // Always strip first — keeps re-runs idempotent and clears any legacy
  // hook entries from earlier installs that wrote into settings.json directly.
  stripHooks(settings);

  if (opts.remove) {
    stripMcp(settings);
    stripEnv(settings);
    delete lock.targets[targetKey(settingsPath)];
  } else {
    upsertMcp(settings);
    const wroteEnv = upsertEnv(settings, env);
    lock.targets[targetKey(settingsPath)] = { wroteHooks: false, wroteMcp: true, wroteEnv };
  }
  writeJson(abs, settings);
};

const main = (): void => {
  const argv = process.argv.slice(2);
  const remove = argv.includes("--remove") || argv.includes("--uninstall");
  const dryRun = argv.includes("--dry-run");

  const { config: cfg } = loadConfig();
  const targets = cfg.sync.targets;
  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.error("no sync.targets in config — nothing to do.");
    process.exit(0);
  }
  const envVals: EnvVals = {
    base: `http://${cfg.daemon.host}:${cfg.daemon.port}`,
    stateDir: cfg.daemon.stateDir,
    hookFallback: cfg.approval.fallbackOnError,
  };

  const lock = readLock();
  for (const t of targets) {
    const action = remove ? "remove" : "upsert";
    // eslint-disable-next-line no-console
    console.log(`[weclaude-sync] ${action} ${t.kind} → ${t.settingsPath}`);
    if (dryRun) continue;
    syncOne(t.settingsPath, { remove }, lock, envVals);
  }
  if (!dryRun) writeLock(lock);
  // eslint-disable-next-line no-console
  console.log(remove ? "[weclaude-sync] removed." : "[weclaude-sync] synced.");
};

main();
