// MCP server `weclaude`. Stdio transport. Single tool `wrc` = "wecom remote
// control": attaches the *current* Claude session for WeCom mirror — session
// resolved via CLAUDE_CODE_SESSION_ID env (Claude Code populates this for
// every child process), so multiple windows can each /wrc without trampling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const DAEMON_BASE = process.env.WECLAUDE_DAEMON_BASE ?? "http://127.0.0.1:17890";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const fail = (msg: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: msg }],
});

// claude encodes a project's cwd into a dir name by replacing each `/` with `-`
const encodeProjectDir = (absCwd: string): string => absCwd.replace(/\//g, "-");

const findProjectDir = (cwd: string): string | undefined => {
  const enc = encodeProjectDir(cwd);
  return [
    join(homedir(), ".claude-internal", "projects", enc),
    join(homedir(), ".claude", "projects", enc),
  ].find((p) => existsSync(p));
};

const latestJsonlByMtime = (projectDir: string): string | null => {
  const files = readdirSync(projectDir).filter((n) => n.endsWith(".jsonl"));
  if (files.length === 0) return null;
  return files
    .map((n) => ({ p: join(projectDir, n), m: statSync(join(projectDir, n)).mtimeMs }))
    .reduce((a, b) => (b.m > a.m ? b : a)).p;
};

const resolveCallerSession = ():
  | { sessionId: string; jsonlPath: string }
  | { error: string } => {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const projectDir = findProjectDir(cwd);
  if (!projectDir) return { error: `no claude project dir for cwd ${cwd}` };

  // Primary: env tells us exactly which session invoked us.
  const envSid = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
  if (envSid) {
    const p = join(projectDir, `${envSid}.jsonl`);
    if (existsSync(p)) return { sessionId: envSid, jsonlPath: p };
  }
  // Fallback: most-recently-written jsonl. Imperfect when other Claude windows
  // share the cwd, but the env-var path catches that case.
  const jsonlPath = latestJsonlByMtime(projectDir);
  if (!jsonlPath) return { error: `no .jsonl under ${projectDir}` };
  return { sessionId: basename(jsonlPath, ".jsonl"), jsonlPath };
};

// Resolve the current pane's tmux session name. `tmux display-message -p` runs
// against the tmux server pointed at by $TMUX (set in every process running
// inside tmux), so it returns the session containing *this* pane without us
// needing to pass a target. Returns undefined if not in tmux or query failed.
const detectTmuxSession = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    if (!process.env.TMUX) return resolve(undefined);
    const p = spawn("tmux", ["display-message", "-p", "#{session_name}"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.on("error", () => resolve(undefined));
    p.on("close", (code) => resolve(code === 0 ? out.trim() || undefined : undefined));
  });

const server = new McpServer(
  { name: "weclaude", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

// Accept user-friendly prefixes from the LLM: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
// Pass anything else (already user:/chat:/group:, or empty) through unchanged.
const normalizeTarget = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  if (raw.startsWith("vid:")) return `user:${raw.slice(4)}`;
  if (raw.startsWith("chatid:")) return `chat:${raw.slice(7)}`;
  return raw;
};

server.registerTool(
  "wrc",
  {
    title: "WeCom remote control",
    description: "wecom remote control — attach current Claude session to a WeCom chat for live mirror push",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'Optional push target. Accepts "vid:<userid>" (DM), "chatid:<chatid>" (group), or raw "user:<id>"/"chat:<id>". Empty → use config defaultChat / mirror.pushChat.',
        ),
    },
  },
  async ({ target }) => {
    const r = resolveCallerSession();
    if ("error" in r) return fail(r.error);
    const normalizedTarget = normalizeTarget(target);
    // tmux sets $TMUX_PANE for every process inside a pane (e.g. `%5`); we
    // inherit it through claude → MCP child, so each /wrc auto-picks its own
    // pane without the user touching config. Pane ids are not stable across
    // tmux server restarts, so we also capture the session name — the daemon
    // uses it to re-derive a fresh paneId after reload, and as the "user wants
    // a tmux pane" signal that drives respawn when their pane dies.
    const tmuxPane = process.env.TMUX_PANE?.trim();
    const tmuxSession = tmuxPane ? await detectTmuxSession() : undefined;
    const resp = await fetch(`${DAEMON_BASE}/mirror/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: r.sessionId,
        jsonlPath: r.jsonlPath,
        ...(normalizedTarget ? { target: normalizedTarget } : {}),
        ...(tmuxPane ? { tmuxPane } : {}),
        ...(tmuxSession ? { tmuxSession } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string; target?: string };
    return j.ok
      ? ok({ ok: true, sessionId: r.sessionId, target: j.target })
      : fail(`attach failed: ${j.reason ?? "unknown"}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
