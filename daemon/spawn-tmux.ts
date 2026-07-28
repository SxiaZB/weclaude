// Auto-spawn helper for mirror mode.
//
// Goal: from a WeCom inbound, materialize a fresh `claude` process inside a
// shared tmux session and attach the resulting jsonl to the WeCom chat —
// no human-in-the-loop `/wrc` needed.
//
// Layout: ONE shared tmux session named `cfg.wrc.tmuxPrefix` (default
// `weclaude`); each chat gets its own window inside it. The pane id (`%N`)
// uniquely identifies a chat's claude process — pane ids are monotonic per
// tmux server lifetime, so they're safe to persist and re-validate via
// `display-message -t %N`. Window names are cosmetic (sanitized principal id;
// WeCom doesn't expose a display name).
//
// Pipeline:
//   uuid = randomUUID                                       (deterministic session)
//   tmux has-session -t weclaude  → create or reuse
//   tmux new-window/new-session -P -F '#{pane_id}' …        (→ paneId)
//   tmux send-keys -t %paneId "claudeBin --session-id <uuid> …" Enter
//
// We do NOT wait for claude to write anything to the jsonl. The jsonl is the
// transcript file, populated as claude runs; the empty file is enough for
// MirrorBridge.attach() (existsSync) and startMirrorTail (statSync.size=0 →
// tail from offset 0). The brief post-launch settle exists only to give the
// pane's shell time to finish sourcing rc + claude TUI time to grab the pty
// before the first paste-buffer inject hits.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome } from "../shared/paths.js";
import { activateBackend, CLI_BACKEND_DEFAULTS, primaryBackend, type CliBackend, type CliBackendName } from "../shared/cli-backends.js";

const NODE_BIN_DIR = dirname(process.execPath);
const augmentedPath = (orig: string | undefined): string => {
  const extras = [NODE_BIN_DIR, "/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME ?? ""}/.local/bin`].filter(Boolean);
  const seen = new Set<string>();
  return [orig ?? "", ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(":");
};

// A spawn has no transcript to derive a backend from, so the caller picks one
// (`cli`) and we fall back to the primary (`wrc.defaultCli`). Everything the
// pane needs — binary, transcript root, project-dir encoding, trust-marker file
// — comes from that single descriptor, which is what lets one daemon host
// claude and codebuddy panes at the same time.
const backendFor = (cfg: Config, cli?: CliBackendName): CliBackend => {
  const primary = primaryBackend();
  if (!cli || cli === primary.name) return primary;
  const base = CLI_BACKEND_DEFAULTS[cli];
  const override = cfg.wrc.cliBackends?.[cli]?.bin;
  // Activate before spawning: this CLI's transcript root may not exist yet, in
  // which case the boot-time probe skipped it and backendForPath would misread
  // the jsonl we are about to create as the primary's dialect.
  return activateBackend(override ? { ...base, bin: override } : base);
};

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export const runTmux = (args: string[]): Promise<ExecResult> =>
  new Promise((resolve) => {
    const proc = spawn("tmux", args, {
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    proc.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message, code: null }));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: out, stderr: err, code }));
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Single-quote shell-escape: wrap in '…' and escape embedded ' as '\''.
const shQuote = (a: string): string => (/[\s"'`$\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);

// tmux window names are free-form but a status-bar friendly slug avoids
// surprises (no whitespace / colons / quoting hazards). Principals are
// shortened: `user:foo` → `u-foo`, `chat:foo` → `c-foo`, and get truncated to
// 8 chars total (status bar real estate is scarce; collisions don't matter —
// we always address windows by pane id, never by name). Explicit tag names
// (not `user:`/`chat:` prefixed) are treated as user-authored labels and kept
// up to 24 chars so `/new #my-tag` shows readably in the tmux status bar.
const safeWindowName = (s: string): string => {
  const isPrincipal = s.startsWith("user:") || s.startsWith("chat:");
  const compact = s.startsWith("user:") ? `u-${s.slice(5)}`
    : s.startsWith("chat:") ? `c-${s.slice(5)}`
    : s;
  const slug = compact.replace(/[^A-Za-z0-9_.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (slug || "claude").slice(0, isPrincipal ? 8 : 24);
};

// Time the daemon waits between launching claude and returning. Covers shell
// rc sourcing + claude TUI grabbing the pty + reaching interactive state so
// the very next paste-buffer inject lands inside claude's input box AND the
// trailing Enter is honored as submit (not eaten by the startup banner).
// 1.5s used to leave Enter racing with TUI init — text would land but the
// submit got dropped, leaving the prompt typed-but-unsent.
const TUI_SETTLE_MS = 3000;

export interface SpawnArgs {
  cfg: Config;
  log: Logger;
  /** Resume an existing claude session (its jsonl already exists) instead of
   *  minting a new uuid. Used when the user closed the original tmux pane and
   *  we need to reincarnate the same conversation in a fresh pane. */
  resumeSessionId?: string;
  /** Cosmetic tmux window name (status-bar label). Falls back to sessionId.
   *  Pass the principal (e.g. "user:xxx") to make windows easy to skim. */
  windowName?: string;
  /** Per-chat cwd override. Empty/undefined → fall back to cfg.wrc.cwd.
   *  Mirror mode persists this in mirror-attachments.json so /new respawns
   *  in the user-bound project, not the global default. */
  cwdOverride?: string;
  /** Which CLI to launch. Undefined → `wrc.defaultCli`. A respawn should pass
   *  the backend that owns `resumeSessionId`, else the resume finds no session. */
  cli?: CliBackendName;
}

export interface SpawnResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  jsonlPath?: string;
  tmuxPane?: string;
  tmuxSession?: string;
  /** Effective cwd the pane was launched in. Mirrors `cwdOverride ?? cfg.wrc.cwd`
   *  after expandHome, so callers can persist it without re-resolving. */
  cwd?: string;
  /** Backend actually launched. */
  cli?: CliBackendName;
}

// Pre-write the "trust this folder" + onboarding markers for `cwd` into
// claude's user-config json so the TUI doesn't park on the workspace-trust /
// onboarding prompts — those would silently swallow paste-buffer injects.
//
//   claude          → ~/.claude.json
//   claude-internal → ~/.claude-internal/.claude.json
//   <other>         → first existing of {~/.<bin>/.claude.json, ~/.<bin>.json};
//                     when neither exists we pick the dir-style path so the
//                     write also creates the conventional layout.
//
// Idempotent: deep-merges into the existing file, preserves unrelated keys.
type ClaudeProjectMeta = {
  hasTrustDialogAccepted?: boolean;
  projectOnboardingSeenCount?: number;
  hasClaudeMdExternalIncludesApproved?: boolean;
  hasClaudeMdExternalIncludesWarningShown?: boolean;
  [k: string]: unknown;
};
const claudeConfigCandidates = (claudeBin: string): string[] => {
  const home = homedir();
  const name = basename(claudeBin);
  if (name === "claude") return [join(home, ".claude.json")];
  return [join(home, `.${name}`, ".claude.json"), join(home, `.${name}.json`)];
};
export const trustWorkspace = (claudeBin: string, cwd: string, log: Logger): void => {
  const candidates = claudeConfigCandidates(claudeBin);
  const target: string = candidates.find(existsSync) ?? candidates[0]!;
  let cfg: { projects?: Record<string, ClaudeProjectMeta>; [k: string]: unknown } = {};
  try {
    if (existsSync(target)) cfg = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    log.warn({ target, err: (e as Error).message }, "trustWorkspace: parse failed; rewriting");
  }
  const projects = (cfg.projects ??= {});
  const proj: ClaudeProjectMeta = projects[cwd] ?? {};
  if (proj.hasTrustDialogAccepted && (proj.projectOnboardingSeenCount ?? 0) >= 1 && proj.hasClaudeMdExternalIncludesApproved) {
    return; // already trusted — no write needed
  }
  projects[cwd] = {
    ...proj,
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: Math.max(proj.projectOnboardingSeenCount ?? 0, 1),
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
  };
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(cfg, null, 2));
    log.info({ target, cwd }, "trustWorkspace: marker written");
  } catch (e) {
    log.warn({ target, err: (e as Error).message }, "trustWorkspace: write failed");
  }
};

export const spawnTmuxClaude = async ({ cfg, log, resumeSessionId, windowName, cwdOverride, cli }: SpawnArgs): Promise<SpawnResult> => {
  const backend = backendFor(cfg, cli);
  const cwd = expandHome((cwdOverride ?? "").trim() || cfg.wrc.cwd);
  const projectDir = join(expandHome(backend.projectsDir), backend.encodeProjectDir(cwd));
  const sessionId = resumeSessionId ?? randomUUID();
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  const tmuxName = cfg.wrc.tmuxPrefix; // shared session for all chats
  const winName = safeWindowName(windowName ?? sessionId);

  // Probe tmux availability up front — clearer error than a generic spawn fail.
  const probe = await runTmux(["-V"]);
  if (!probe.ok) return { ok: false, reason: `tmux not available: ${probe.stderr.trim() || probe.code}` };

  // Ensure cwd / projectDir exist (tmux `new-session -c` fails if cwd missing;
  // default `~/.weclaude/workspace` often hasn't been touched yet). Do NOT
  // pre-create the jsonl: `claude --session-id <uuid>` refuses to start when
  // the transcript file already exists ("session id is already in use"). We
  // poll for it after spawn instead.
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `prepare cwd failed: ${(e as Error).message}` };
  }

  // Pre-trust the workspace so claude TUI doesn't park on the "Do you trust
  // this folder?" / onboarding prompts — those prompts swallow paste-buffer
  // injects and the approval card never fires. Best-effort: log + continue
  // on failure (worst case the user clicks through the prompts manually).
  trustWorkspace(backend.bin, cwd, log);

  // Reuse the shared session if alive; otherwise create it. Either way, end
  // up with a fresh window whose pane id we capture via `-P -F '#{pane_id}'`.
  //
  // Seed the new pane's environment (`-e`, tmux ≥3.0) BEFORE its shell sources
  // rc: oh-my-zsh runs its update check while sourcing .zshrc and, when due,
  // blocks on `[oh-my-zsh] Would you like to update? [Y/n]`. That prompt eats
  // the `claude …` command line + the trailing Enter, so claude never launches
  // and the injected message falls through to a bare shell (`command not
  // found: hi`). These two legacy vars (still honored for back-compat) disable
  // the prompt regardless of the user's zstyle config.
  const paneEnv = ["-e", "DISABLE_AUTO_UPDATE=true", "-e", "DISABLE_UPDATE_PROMPT=true"];
  const has = await runTmux(["has-session", "-t", tmuxName]);
  const created = has.code === 0
    // `${tmuxName}:` (trailing colon) forces session-only resolution → next free
    // window index. Bare `-t weclaude` is ambiguous: if a *window* is also named
    // `weclaude`, tmux matches it and tries to reuse its index → "index N in use".
    ? await runTmux(["new-window", "-d", "-t", `${tmuxName}:`, "-n", winName, "-c", cwd, ...paneEnv, "-P", "-F", "#{pane_id}"])
    : await runTmux(["new-session", "-d", "-s", tmuxName, "-n", winName, "-c", cwd, ...paneEnv, "-P", "-F", "#{pane_id}"]);
  if (!created.ok) {
    const verb = has.code === 0 ? "new-window" : "new-session";
    return { ok: false, reason: `tmux ${verb} failed: ${created.stderr.trim() || created.code}` };
  }
  const tmuxPane = created.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? "";
  if (!tmuxPane) {
    return { ok: false, reason: "tmux returned no pane id" };
  }
  log.info({ tmuxName, winName, tmuxPane, cwd, sessionId, cli: backend.name, reused: has.code === 0 }, "spawn-tmux: pane created");

  // DISABLE_AUTOUPDATER=1 防止新 pane 启动时弹出 "An update is available" 询问 ——
  // 该交互会吞掉首条 paste-buffer 注入，导致仅落字符不进入 claude 输入框。
  const cmd = [
    "DISABLE_AUTOUPDATER=1",
    backend.bin,
    ...(resumeSessionId ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...cfg.wrc.extraArgs,
  ].map((a, i) => (i === 0 ? a : shQuote(a))).join(" ");
  const sent = await runTmux(["send-keys", "-t", tmuxPane, cmd, "Enter"]);
  if (!sent.ok) {
    // Kill only this window/pane, never the shared session.
    await runTmux(["kill-pane", "-t", tmuxPane]);
    return { ok: false, reason: `tmux send-keys failed: ${sent.stderr.trim() || sent.code}` };
  }

  // Settle so the next paste-buffer inject doesn't race claude's TUI startup.
  // Note: claude does NOT create the transcript jsonl until it processes the
  // first user input, so we don't wait for the file here — mirror tail tolerates
  // a missing jsonl and starts emitting once claude writes the first line.
  await sleep(TUI_SETTLE_MS);

  log.info({ tmuxName, tmuxPane, sessionId, jsonlPath, cwd, cli: backend.name }, "spawn-tmux: ready");
  return { ok: true, sessionId, jsonlPath, tmuxPane, tmuxSession: tmuxName, cwd, cli: backend.name };
};
