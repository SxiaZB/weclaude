// Scan the host for live `claude` sessions running inside tmux, and summarize
// what each is doing from its transcript tail. Used by the /sessions/* routes
// so a WeCom-side Claude can list / switch / describe sibling sessions.
//
// Why daemon-side: an MCP tool runs *inside one* claude process and can only
// see its own $TMUX_PANE / cwd / sessionId. Correlating *other* sessions to
// their tmux pane (required for IM→CLI inject) needs a host-wide /proc + tmux
// sweep, which only the resident daemon is positioned to do.
//
// Scope: tmux-hosted sessions only (a session with no pane can't receive
// pasted input, so it's not a useful mirror target). Linux-only (reads /proc);
// returns [] elsewhere, degrading gracefully.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync, readlinkSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { labelFor } from "./session-label.js";

export interface SessionInfo {
  sessionId: string;
  /** Stable animal-emoji tag (same as approval cards). */
  label: string;
  /** Working directory of the live claude process. */
  cwd: string;
  /** Transcript path (may not exist yet for a freshly-spawned session). */
  jsonlPath: string;
  tmuxSession: string;
  tmuxPane: string;
  /** jsonl mtime in ms (0 if absent); used for ordering. */
  lastActivity: number;
  /** One-line "what is this session doing" preview from the transcript tail. */
  summary: string;
}

interface PaneOwner {
  paneId: string;
  session: string;
}

const dirnameOfNode = (): string => {
  const i = process.execPath.lastIndexOf("/");
  return i > 0 ? process.execPath.slice(0, i) : "";
};

const augmentedPath = (orig: string | undefined): string => {
  const extras = [dirnameOfNode(), "/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME ?? ""}/.local/bin`].filter(Boolean);
  const seen = new Set<string>();
  return [orig ?? "", ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => p && !seen.has(p) && (seen.add(p), true))
    .join(":");
};

const runTmux = (args: string[]): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    const p = spawn("tmux", args, {
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout?.on("data", (c) => (out += c.toString("utf8")));
    p.on("error", () => resolve({ ok: false, stdout: "" }));
    p.on("close", (code) => resolve({ ok: code === 0, stdout: out }));
  });

// Read /proc/<pid>/stat → ppid. comm (2nd field) is wrapped in parens and may
// itself contain spaces/parens, so split on the LAST ')' and index from there:
// fields after comm are state ppid ... → ppid is index 1 of the tail.
const ppidOf = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return null;
    const rest = stat.slice(rp + 2).split(" ");
    const ppid = parseInt(rest[1] ?? "", 10);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
};

const cmdlineOf = (pid: number): string => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
};

const cwdOf = (pid: number): string => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
};

// Pull a `--session-id <uuid>` out of a cmdline. Returns "" when absent
// (e.g. claude launched with bare `-r`/`--resume` — no explicit id to bind).
const sessionIdFromCmd = (cmd: string): string => {
  const m = cmd.match(/--session-id[= ]+([0-9a-fA-F-]{36})/);
  return m?.[1] ?? "";
};

const looksLikeClaude = (cmd: string): boolean => /claude/i.test(cmd);

// Project roots claude writes transcripts under, internal build first.
const PROJECT_ROOT_INTERNAL = join(homedir(), ".claude-internal", "projects");
const PROJECT_ROOT_DEFAULT = join(homedir(), ".claude", "projects");
const PROJECT_ROOT_CODEBUDDY = join(homedir(), ".codebuddy", "projects");
const PROJECT_ROOTS = [PROJECT_ROOT_INTERNAL, PROJECT_ROOT_DEFAULT, PROJECT_ROOT_CODEBUDDY];

// Locate `<sessionId>.jsonl` (UUID is globally unique, so we don't have to
// reverse the cwd→dir encoding). Skips subagent transcripts (they live under a
// `<sid>/subagents/` subdir, never directly under a project dir).
const findJsonl = (sessionId: string): string => {
  const name = `${sessionId}.jsonl`;
  for (const root of PROJECT_ROOTS) {
    if (!existsSync(root)) continue;
    let subs: import("node:fs").Dirent[];
    try {
      subs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, name);
      if (existsSync(p)) return p;
    }
  }
  return "";
};

// cwd→projectDir encoding is backend-specific:
//   Claude Code / claude-internal: `/` `.` `_` → `-`   (leading `-` kept)
//   CodeBuddy:                     strip leading `/`, then `/` `.` → `-`
const encodeClaude = (absCwd: string): string => absCwd.replace(/[/._]/g, "-");
const encodeCodebuddy = (absCwd: string): string =>
  absCwd.replace(/^[/]+/, "").replace(/[/.]/g, "-");
const encodeForRoot = (root: string, absCwd: string): string =>
  root === PROJECT_ROOT_CODEBUDDY ? encodeCodebuddy(absCwd) : encodeClaude(absCwd);

// Expected jsonl path for a freshly-spawned session whose transcript doesn't
// exist on disk yet (claude only writes it after the first user input). Used so
// a brand-new `new_claude_session` still shows up in the list immediately.
const expectedJsonl = (cwd: string, sessionId: string): string => {
  if (!cwd || !sessionId) return "";
  for (const root of PROJECT_ROOTS) {
    const enc = encodeForRoot(root, cwd);
    if (existsSync(join(root, enc))) return join(root, enc, `${sessionId}.jsonl`);
  }
  return join(PROJECT_ROOT_INTERNAL, encodeClaude(cwd), `${sessionId}.jsonl`);
};

// Resume-mode fallback: a claude launched with bare `-r`/`--resume` carries no
// `--session-id` on its cmdline. Infer the session from its cwd: the most
// recently written `<uuid>.jsonl` directly under that project dir. `taken`
// holds session ids already claimed by explicit-id processes so two sessions
// sharing a cwd don't both resolve to the same newest file.
const inferByCwd = (cwd: string, taken: Set<string>): { sessionId: string; jsonlPath: string } | null => {
  if (!cwd) return null;
  for (const root of PROJECT_ROOTS) {
    const dir = join(root, encodeForRoot(root, cwd));
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const cands = files
      .map((n) => ({ sid: n.slice(0, -6), p: join(dir, n) }))
      .filter((c) => !taken.has(c.sid))
      .map((c) => ({
        ...c,
        m: (() => {
          try {
            return statSync(c.p).mtimeMs;
          } catch {
            return 0;
          }
        })(),
      }))
      .sort((a, b) => b.m - a.m);
    const top = cands[0];
    if (top) return { sessionId: top.sid, jsonlPath: top.p };
  }
  return null;
};

// Extract the last ~3 user/assistant text turns from a transcript as a one-line
// "what is this session doing" preview. Reads only the file tail (bounded), so
// huge multi-MB transcripts don't get slurped fully into memory.
const TAIL_BYTES = 64 * 1024;
const summarize = (jsonlPath: string): string => {
  if (!existsSync(jsonlPath)) return "(新会话 · 暂无对话)";
  let fd: number | undefined;
  try {
    const size = statSync(jsonlPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(jsonlPath, "r");
    const read = readSync(fd, buf, 0, len, start);
    const lines = buf.subarray(0, read).toString("utf8").split("\n").filter((l) => l.trim());
    const turns: string[] = [];
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = (row.message ?? {}) as Record<string, unknown>;
      const role = (msg.role ?? row.role) as string | undefined;
      if (role !== "user" && role !== "assistant") continue;
      if (row.isMeta) continue;
      const c = msg.content ?? row.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c))
        text = c
          .filter((b): b is { type: string; text?: string } => !!b && (b as { type?: string }).type === "text")
          .map((b) => b.text || "")
          .join(" ");
      text = text
        .replace(/<(system-reminder|command-[^>]*|local-command-[^>]*)>[\s\S]*?<\/\1>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) turns.push(`${role === "user" ? "你" : "AI"}: ${text.slice(0, 80)}`);
    }
    return turns.slice(-3).join(" | ") || "(暂无对话)";
  } catch {
    return "(无法读取对话)";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
};

// Build pane_pid → {paneId, session}. We map the *pane's* root pid; the claude
// worker is a descendant, so we walk its ppid chain up to find a matching pane.
const tmuxPaneIndex = async (): Promise<Map<number, PaneOwner>> => {
  const r = await runTmux(["list-panes", "-a", "-F", "#{pane_pid}|#{pane_id}|#{session_name}"]);
  const idx = new Map<number, PaneOwner>();
  if (!r.ok) return idx;
  for (const line of r.stdout.split("\n")) {
    const [panePid, paneId, session] = line.split("|");
    const pid = parseInt(panePid ?? "", 10);
    if (Number.isInteger(pid) && paneId) idx.set(pid, { paneId, session: session ?? "" });
  }
  return idx;
};

// Climb the ppid chain from `pid` until we hit a pid that owns a tmux pane.
// Bounded to avoid pathological loops.
const tmuxOwnerOf = (pid: number, paneIdx: Map<number, PaneOwner>): PaneOwner | null => {
  let cur: number | null = pid;
  for (let i = 0; i < 40 && cur != null && cur > 1; i++) {
    const hit = paneIdx.get(cur);
    if (hit) return hit;
    const pp = ppidOf(cur);
    if (pp == null || pp === cur) break;
    cur = pp;
  }
  return null;
};

export const scanClaudeSessions = async (): Promise<SessionInfo[]> => {
  const paneIdx = await tmuxPaneIndex();
  let pids: number[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map((n) => parseInt(n, 10));
  } catch {
    return []; // not Linux / no /proc
  }

  // Collect tmux-hosted claude workers, then collapse to ONE session per pane
  // (a tmux pane runs exactly one claude session; a pane may host several
  // claude processes — shim + worker + nested — which must not each count as
  // a separate session). Per pane: prefer a process carrying an explicit
  // `--session-id`; else fall back to one resume-mode inference by cwd.
  const byPane = new Map<string, { pid: number; owner: PaneOwner; cwd: string; explicitSid: string }>();
  for (const pid of pids) {
    const cmd = cmdlineOf(pid);
    if (!cmd || !looksLikeClaude(cmd)) continue;
    const owner = tmuxOwnerOf(pid, paneIdx);
    if (!owner) continue; // tmux scope
    const explicitSid = sessionIdFromCmd(cmd);
    const prev = byPane.get(owner.paneId);
    if (!prev || (!prev.explicitSid && explicitSid)) {
      byPane.set(owner.paneId, { pid, owner, cwd: cwdOf(pid), explicitSid });
    }
  }

  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  const emit = (sessionId: string, jsonlPath: string, cwd: string, owner: PaneOwner): void => {
    if (!sessionId || !jsonlPath || seen.has(sessionId)) return;
    seen.add(sessionId);
    let lastActivity = 0;
    try {
      lastActivity = statSync(jsonlPath).mtimeMs;
    } catch {
      /* fresh session: no transcript yet */
    }
    out.push({
      sessionId,
      label: labelFor(sessionId),
      cwd,
      jsonlPath,
      tmuxSession: owner.session,
      tmuxPane: owner.paneId,
      lastActivity,
      summary: summarize(jsonlPath),
    });
  };

  const panes = Array.from(byPane.values());
  // Pass 1: explicit `--session-id` — exact, no ambiguity. Seeds `seen` so
  // resume inference in pass 2 can't re-claim these ids. A freshly-spawned
  // session may not have written its jsonl yet — fall back to the expected
  // path so it still appears (summary reads as a new/empty session).
  for (const w of panes) {
    if (!w.explicitSid) continue;
    const jsonlPath = findJsonl(w.explicitSid) || expectedJsonl(w.cwd, w.explicitSid);
    if (jsonlPath) emit(w.explicitSid, jsonlPath, w.cwd, w.owner);
  }
  // Pass 2: resume-mode (`-r`/`--resume`, no id) — infer via cwd→newest jsonl,
  // skipping any session already claimed in pass 1.
  for (const w of panes) {
    if (w.explicitSid) continue;
    const inf = inferByCwd(w.cwd, seen);
    if (inf) emit(inf.sessionId, inf.jsonlPath, w.cwd, w.owner);
  }

  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out;
};
