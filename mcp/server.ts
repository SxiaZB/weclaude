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

// claude encodes a project's cwd into a dir name by replacing each `/` AND `.`
// with `-`. `/Users/foo/.bar` → `-Users-foo--bar` (double dash from the dot).
const encodeProjectDir = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");

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

// cd — bind a per-chat project cwd in the daemon's mirror store. Doesn't
// move the live claude (cwd is set at pane spawn time); instead writes to
// `pendingCwd` and the next /new (or /clear that's upgraded into /new)
// respawns the pane in the new path. Tell the user to send /new (or
// /clear) for it to take effect.
server.registerTool(
  "cd",
  {
    title: "Bind project path to current chat",
    description:
      "Persist a project cwd binding for the WeCom chat that mirrors this Claude session. The change takes effect on the next /new (or /clear, which auto-upgrades to /new when the path differs). Use absolute paths (or paths starting with ~).",
    inputSchema: {
      cwd: z.string().describe("Absolute project path, e.g. /Users/foo/projects/bar. ~ is expanded."),
      target: z
        .string()
        .optional()
        .describe(
          'Optional target override. "vid:<userid>" / "chatid:<chatid>" / raw "user:<id>"/"chat:<id>". Empty → derive from this Claude session.',
        ),
    },
  },
  async ({ cwd, target }) => {
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? "";
    const normalizedTarget = normalizeTarget(target);
    const resp = await fetch(`${DAEMON_BASE}/mirror/cwd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        ...(normalizedTarget ? { target: normalizedTarget } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; reason?: string; target?: string; runningCwd?: string; pendingCwd?: string };
    if (!j.ok) return fail(`cd failed: ${j.reason ?? "unknown"}`);
    return ok({
      ok: true,
      target: j.target,
      runningCwd: j.runningCwd,
      pendingCwd: j.pendingCwd,
      hint: "Send /new (or /clear) in WeCom to apply the new path.",
    });
  },
);

// 企业微信 doc / smartsheet / contact MCP 桥接。把 daemon 远端的 MCP 转发
// 给本地 Claude: list_tools 列工具, call_tool 调用 (创建文档 / 写表格 / 读
// 内容)。category 当前可选: "doc" | "smartsheet" | "contact"。
// 大模型先调 list_tools 看可用方法和入参 schema, 再 call_tool。
server.registerTool(
  "wecom_doc_list_tools",
  {
    title: "List WeCom doc/smartsheet tools",
    description:
      "List available WeCom MCP tools for a given category. Categories: 'doc' (online documents), 'smartsheet' (smart sheets), 'contact'. Returns tool names + JSON Schema. Call this BEFORE wecom_doc_call to discover method names and required arguments.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid that owns the resulting docs. Optional — daemon falls back to config.wedoc.requesterUserId or defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, requesterUserId }) => {
    const resp = await fetch(`${DAEMON_BASE}/wedoc/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, ...(requesterUserId ? { requesterUserId } : {}) }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    return j.ok ? ok(j.result) : fail(`wecom_doc_list_tools failed: ${j.error ?? `http ${resp.status}`}`);
  },
);

server.registerTool(
  "wecom_doc_call",
  {
    title: "Call WeCom doc/smartsheet tool",
    description:
      "Invoke a specific WeCom MCP tool (after discovering it via wecom_doc_list_tools). Typical flow: list tools for 'doc' → pick a method like 'doc_create' → call it with args matching its inputSchema. Daily quota: 20 docs per requesterUserId.",
    inputSchema: {
      category: z.string().describe("MCP category: 'doc' | 'smartsheet' | 'contact'."),
      method: z.string().describe("Tool name from wecom_doc_list_tools (e.g. 'doc_create', 'smartsheet_add_records')."),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("JSON object matching the tool's inputSchema. Empty object if the tool takes no params."),
      requesterUserId: z
        .string()
        .optional()
        .describe(
          "WeCom userid acting as document owner. Optional — daemon falls back to config / defaultChat. 'user:xxx' prefix accepted.",
        ),
    },
  },
  async ({ category, method, args, requesterUserId }) => {
    const resp = await fetch(`${DAEMON_BASE}/wedoc/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category,
        method,
        args: args ?? {},
        ...(requesterUserId ? { requesterUserId } : {}),
      }),
    });
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: unknown };
    return j.ok ? ok(j.result) : fail(`wecom_doc_call failed: ${j.error ?? `http ${resp.status}`}`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
