// Mirror-mode bridge.
//
// Strategy: a running interactive `claude` exposes no local IPC. Its only
// shared surface is the append-only transcript at
//   ~/.claude/projects/<encoded(cwd)>/<session-id>.jsonl
// So:
//   • Inbound (WeCom → claude): spawn `claude --resume <sid> -p <text>` —
//     writes a new user/assistant turn into the SAME jsonl. Serialized per
//     session to avoid concurrent writers stomping each other.
//   • Outbound (claude → WeCom): tail that jsonl from the current EOF; every
//     new `assistant` line gets pushed to a configured WeCom chat.
//
// Caveat: the user shouldn't be hammering the same session in their local TTY
// while a `--resume` injection is in flight; Claude Code locks aren't strict.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, openSync, readSync, closeSync, type FSWatcher } from "node:fs";
import { join, dirname } from "node:path";
import type { WSClient, WsFrame, WsFrameHeaders, EventMessageWith, TemplateCard, TemplateCardEventData } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import type { MirrorStore } from "./mirror-store.js";
import { spawnTmuxClaude } from "./spawn-tmux.js";
import { recordTool, recordToolResult, recordTurnStart, recordTurnItem, recordTurnUsage, recordTurnClose, recordCloseOpenTurns, buildDetailUrl } from "./detail.js";
import type { TurnUsage } from "./detail.js";

// Same PATH augmentation logic as cc-bridge: launchd / systemd start the daemon
// with a stripped PATH that often lacks nvm / homebrew, breaking spawn(claudeBin).
const NODE_BIN_DIR = dirname(process.execPath);
const augmentedPath = (orig: string | undefined): string => {
  const extras = [
    NODE_BIN_DIR,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
  ].filter(Boolean);
  const seen = new Set<string>();
  return [orig ?? "", ...extras]
    .flatMap((p) => p.split(":"))
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(":");
};

// Claude Code encodes a project's cwd into a directory name by replacing each
// `/` AND `.` with `-`. Absolute path `/Users/foo/.bar` → `-Users-foo--bar`
// (note the double dash from the dot). Missing the dot rule sends the tail
// to a non-existent dir → ENOENT → silent pane→chat dropout.
const encodeProjectDir = (absCwd: string): string => absCwd.replace(/[/.]/g, "-");

// Pull the bound session's actual project cwd from its transcript head. Each
// jsonl line carries a `cwd` field; the encoded directory name is lossy (both
// `/` and `.` collapse to `-`) so it can't be reversed — reading the file is
// the only faithful path. Used as the middle tier in attach()'s cwd resolution
// so /wrc-attached sessions reflect their real project in /pwd, /clear, /new,
// instead of falling back to the global cfg.wrc.cwd.
const readCwdFromJsonl = (path: string): string => {
  try {
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    if (size === 0) return "";
    const fd = openSync(path, "r");
    const cap = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { cwd?: unknown };
        if (typeof j.cwd === "string" && j.cwd.trim()) return j.cwd.trim();
      } catch { /* partial / non-JSON line — skip */ }
    }
  } catch { /* unreadable — fall through */ }
  return "";
};

interface ResolvedSession {
  sessionId: string;
  jsonlPath: string;
}

// Newest-mtime *.jsonl in the encoded project dir for `cwd`. A `/clear` (or a
// native `/new`) rotation always leaves a fresh jsonl here, so this is how the
// mirror re-finds the live session after a rotation it didn't itself record —
// used by resolveSession's auto-pick and by restoreFromStore's heal path.
const latestJsonlForCwd = (cfg: Config, cwd: string): ResolvedSession | undefined => {
  const projectDir = join(expandHome(cfg.wrc.mirror.projectsDir), encodeProjectDir(expandHome(cwd)));
  if (!existsSync(projectDir)) return undefined;
  const top = readdirSync(projectDir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ name: n, mtime: statSync(join(projectDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!top) return undefined;
  return { sessionId: top.name.replace(/\.jsonl$/, ""), jsonlPath: join(projectDir, top.name) };
};

// Locate a transcript by sessionId across every sibling project dir under the
// projects root. Claude Code's EnterWorktree/ExitWorktree relocate the SAME-sid
// jsonl between <cwd> and <cwd>/.claude/worktrees/<name> — each cwd encodes to
// its own project dir, so the path moves but the sid doesn't. It's a rename
// (byte prefix preserved), so a tail can follow it with a continuous offset.
// Newest-mtime wins if a stale sibling lingers.
const findJsonlBySid = (projectsRoot: string, sid: string): string | undefined => {
  const sidFile = `${sid}.jsonl`;
  try {
    return readdirSync(projectsRoot)
      .flatMap((d) => {
        const p = join(projectsRoot, d, sidFile);
        try { return [{ p, m: statSync(p).mtimeMs }]; } catch { return []; }
      })
      .sort((a, b) => b.m - a.m)[0]?.p;
  } catch {
    return undefined;
  }
};

// True if `path` holds at least one real (non-meta, non-sidechain) user line —
// i.e. it's a live session, not an empty just-touched jsonl. Bounded head read.
const jsonlHasUserLine = (path: string): boolean => {
  try {
    const size = statSync(path).size;
    const cap = Math.min(size, 256 * 1024);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(cap);
    readSync(fd, buf, 0, cap, 0);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as TranscriptLine;
        if (j.type === "user" && !j.isMeta && !j.isSidechain) return true;
      } catch { /* partial line */ }
    }
  } catch { /* unreadable */ }
  return false;
};

// Search a jsonl's tail for a just-injected message fingerprint; return the
// byte offset of the START of the line containing it, or undefined. Used to
// rebind onto a same-dir fork that swallowed our inject (see armSilentForkRebind)
// — matching the exact text is what makes cross-session rebind safe when many
// sessions share one project dir. Bounded tail read (the inject is near EOF).
const findInjectOffset = (path: string, fp: string): number | undefined => {
  try {
    const size = statSync(path).size;
    const readLen = Math.min(size, 256 * 1024);
    const start = size - readLen;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(readLen);
    try { readSync(fd, buf, 0, readLen, start); } finally { closeSync(fd); }
    const chunk = buf.toString("utf8");
    const idx = chunk.lastIndexOf(fp);
    if (idx === -1) return undefined;
    const lineStart = chunk.lastIndexOf("\n", idx) + 1; // -1 → 0 (chunk head)
    return start + Buffer.byteLength(chunk.slice(0, lineStart), "utf8");
  } catch { return undefined; }
};

// Newest-mtime *.jsonl WITH user content in cwd's encoded project dir. The
// content gate skips an empty just-touched file so we bind the real session.
// Reliable for worktree dirs (one session lives there); restore + the drift
// follower only consult it on cross-dir moves, where that assumption holds.
const liveSessionForCwd = (projectsDir: string, cwd: string): ResolvedSession | undefined => {
  const dir = join(projectsDir, encodeProjectDir(expandHome(cwd)));
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { return undefined; }
  const ranked = names
    .flatMap((n) => { const p = join(dir, n); try { return [{ p, sid: n.replace(/\.jsonl$/, ""), m: statSync(p).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.m - a.m);
  for (const c of ranked) if (jsonlHasUserLine(c.p)) return { sessionId: c.sid, jsonlPath: c.p };
  return undefined;
};

const resolveSession = (cfg: Config, log: Logger): ResolvedSession | undefined => {
  const cwd = expandHome(cfg.wrc.cwd);
  const projectDir = join(expandHome(cfg.wrc.mirror.projectsDir), encodeProjectDir(cwd));
  if (!existsSync(projectDir)) {
    log.error({ projectDir }, "mirror: project dir not found (no claude session ever ran in cwd?)");
    return undefined;
  }
  const pinned = cfg.wrc.mirror.sessionId.trim();
  if (pinned) {
    const p = join(projectDir, `${pinned}.jsonl`);
    if (!existsSync(p)) {
      log.error({ p }, "mirror: pinned sessionId jsonl missing");
      return undefined;
    }
    return { sessionId: pinned, jsonlPath: p };
  }
  const top = latestJsonlForCwd(cfg, cwd);
  if (!top) {
    log.error({ projectDir }, "mirror: no .jsonl in project dir");
    return undefined;
  }
  return top;
};

// ── Tail logic ────────────────────────────────────────────────────────
interface TailDeps {
  jsonlPath: string;
  log: Logger;
  includeUser: boolean;
  includeTools: boolean;
  includeToolResults: boolean;
  toolResultMaxChars: number;
  toolUseInlineMaxChars: number;
  isOwnInject: (text: string) => boolean;
  /** True when this assistant text was already pushed early from a pane capture
   *  (pre-card preamble). CC flushes a tool-terminated turn to the jsonl only
   *  after the tool resolves, so the tail re-emits text we already mirrored;
   *  suppress that one echo. One-shot — a genuine later re-say still streams. */
  isOwnAssistantSend?: (text: string) => boolean;
  onItem: (item: RenderItem) => void;
  /** Build a click-to-detail URL for a tool_use id; returns "" when disabled
   *  (cfg.daemon.detailLinksInMirror=false) so the tail can skip wrapping the
   *  bubble in a markdown link. */
  detailUrlFor: (toolUseId: string) => string;
  /** Originating session/target for the detail page header. */
  sessionId: string;
  target: string;
  /** Override the initial read offset. Default: current EOF (or 0 if missing).
   *  Used by /clear migration to replay the freshly-rotated jsonl from start —
   *  the user line dedupes via isOwnInject, assistant lines stream normally. */
  startOffset?: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string; tool_name?: string }>;
}

interface TranscriptLine {
  type?: string;
  /** Present on `type:"system"` lines — e.g. "local_command" for slash-command
   *  invocation records. */
  subtype?: string;
  /** Top-level content for `type:"system"` lines (distinct from message.content
   *  used on user/assistant lines). Slash-command invocation lands here as
   *  `<command-name>/foo</command-name>...`. */
  content?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    /** Anthropic Messages API stop_reason — present on assistant turns. We
     *  treat `end_turn` / `stop_sequence` / `max_tokens` as "turn truly done"
     *  signals to immediately finalize the live WeCom bubble (so it's
     *  quotable without waiting for the next inbound or the 6-min hard
     *  timeout). `tool_use` is NOT terminal — more turns will follow. */
    stop_reason?: string;
    /** Model name (e.g. "claude-4.7-opus") on assistant lines. Extracted into
     *  turn store so the detail page can display it as a muted chip. */
    model?: string;
    /** Per-API-call usage snapshot on assistant lines. Each assistant line has
     *  its own independent counts; a multi-tool turn spans several lines and
     *  needs field-level accumulation in the turn store. */
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      service_tier?: string;
    };
  };
  isMeta?: boolean;
  isSidechain?: boolean;
}

const stripPrincipalPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

// Claude Code wraps slash-command invocations into the user message as
//   <command-message>name</command-message>
//   <command-name>/name</command-name>
//   <command-args>...</command-args>
// plus assorted <local-command-stdout>, <local-command-caveat>,
// <system-reminder> blocks. Rendering those raw to WeCom is pure noise.
//
// Strategy: extract /cmd + args into a single styled line; strip the rest.
// Returns "" when the message is purely meta — caller filters.
const SLASH_TAG_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const SLASH_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const META_TAG_RE = /<(command-message|command-name|command-args|local-command-stdout|local-command-caveat|system-reminder|task-notification)>[\s\S]*?<\/\1>/g;
const TASK_NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;

// Background task completion notification (Claude Code emits these into the
// user channel when a backgrounded Bash/Agent task finishes). Render the
// summary + status as a single styled line; drop the noisy tool-use-id /
// output-file fields.
const renderTaskNotification = (block: string): string => {
  const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
  const status = block.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() ?? "";
  const icon = status === "completed" ? "✅" : status === "failed" || status === "error" ? "❌" : "🏁";
  return `${icon} ${summary || `后台任务 ${status || "完成"}`}`;
};

const cleanUserText = (raw: string): string => {
  const nameMatch = raw.match(SLASH_TAG_RE);
  const slashCmd = nameMatch?.[1]?.trim() ?? "";
  const argsMatch = raw.match(SLASH_ARGS_RE);
  const slashArgs = argsMatch?.[1]?.trim() ?? "";
  const stripped = raw.replace(META_TAG_RE, "").trim();
  if (slashCmd) {
    const head = `\`${slashCmd}${slashArgs ? ` ${slashArgs}` : ""}\``;
    return stripped ? `${head}\n${stripped}` : head;
  }
  return stripped;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…(+${s.length - max})`;

const renderToolInput = (input: unknown): string => {
  try {
    const json = JSON.stringify(input ?? {}, null, 0);
    return truncate(json, 600);
  } catch {
    return "{}";
  }
};

const extractToolResultText = (block: ContentBlock): string => {
  const c = block.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (typeof b?.text === "string" ? b.text : b?.tool_name ? `→ ${b.tool_name}` : ""))
    .filter(Boolean)
    .join("\n");
};

// detail 页用的存储上限 — 远大于聊天气泡的 toolResultMaxChars(默认 400),
// 确保点开"详情"能看到工具调用的完整 result, 不再受气泡截断的影响。
const DETAIL_RESULT_MAX = 64 * 1024;

// Tagged render output: items append in-order into the live replyStream. Tool
// items render as plain body lines; the full input/result is carried out
// of band on the item so the caller can register them for click-to-detail.
type RenderItem =
  | { kind: "text"; body: string; final?: boolean }
  // CLI-side user line (not a WeCom inject). Marks a turn boundary that did
  // NOT originate from the still-open WeCom liveStream — onItem uses this to
  // finalize the prior bubble so the new conversation gets its own bubble.
  | { kind: "user_text"; body: string }
  // Skill stdout (e.g. /model). Always emitted as a standalone bubble — bypasses
  // deferred-state filtering so the user sees /model output even when no
  // assistant turn is active.
  | { kind: "skill_output"; body: string }
  | {
      kind: "tool_use";
      body: string;
      // calls.length === 1 是普通工具调用; > 1 是同一 assistant 行里连续相同
      // tool name 的批量调用 (e.g. 并行 3 个 Bash) 聚合后的结果。
      calls: Array<{ toolUseId: string; name: string; input: unknown }>;
    }
  | { kind: "tool_result"; body: string; toolUseId: string; full: string }
  // Assistant turn truly ended (stop_reason ∈ {end_turn, stop_sequence,
  // max_tokens}). Emitted AFTER any text/tool_use items from the same line so
  // onItem can finalize the bubble once the content has been appended. Pure
  // signal — no body to render.
  | { kind: "turn_end" }
  // Per-assistant-line usage snapshot (model + token counts). Consumed only in
  // brief mode where it's fed into the turn store for aggregate chip display.
  // Non-brief onItem drops it silently — no bubble, no stream side effect.
  | { kind: "turn_usage"; model?: string; usage: TurnUsage };

const oneLineSummary = (s: string, max = 40): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
};

// WeCom's markdown sanitizer strips HTML-like `<...>` runs even inside inline
// code spans — so a Bash command containing `<<'EOF'` (heredoc), `<file>`,
// `<noreply@x>` etc. silently swallows the rest of the line plus the closing
// backtick, eating subsequent items. A literal backtick inside `compact` also
// closes the surrounding inline-code prematurely; `[`/`]` break the
// enclosing `[text](url)` link by re-anchoring the text span.
// Replace with full-width / similar glyphs: visually close, harmless to the
// renderer. Applied to the user-controlled part only — surrounding markdown
// structure (the wrapping ``…``, `[…](…)` and `> ↩ ` prefix) stays literal.
const safeForMarkdown = (s: string): string =>
  s
    .replace(/`/g, "ʼ")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    // \( \) is LaTeX inline-math in WeCom desktop renderer → contents render
    // italic and the link span breaks. Keep the backslash for fidelity, swap
    // to full-width parens so the math tokenizer no longer recognizes it.
    // (\[ \] is already neutralized above by the [/] replacement.)
    .replace(/\\\(/g, "\\（")
    .replace(/\\\)/g, "\\）");

const renderToolInputCompact = (input: unknown, max: number): string => {
  // Heuristic: prefer command/file_path/pattern-like keys for the inline summary.
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return oneLineSummary(pick, max);
  }
  return oneLineSummary(renderToolInput(input), max);
};

// 渲染一组同名 tool_use:
//   • 单次  → `🔧 [Name compact](url)`            (与原行为一致)
//   • 多次  → 聚合为一个 markdown 块:
//       🔧 Name × N
//       [• compact1](url1)
//       [• compact2](url2)
// 多次的每条仍是独立 link, 各自指向自己的 detail URL。
const renderToolUseGroupBody = (
  calls: Array<{ toolUseId: string; name: string; input: unknown }>,
  deps: TailDeps,
): string => {
  const renderOne = (c: { toolUseId: string; input: unknown }): { compact: string; url: string } => ({
    compact: safeForMarkdown(renderToolInputCompact(c.input, deps.toolUseInlineMaxChars)),
    url: deps.detailUrlFor(c.toolUseId),
  });
  if (calls.length === 1) {
    const c = calls[0]!;
    const { compact, url } = renderOne(c);
    return url ? `🔧 [${c.name} ${compact}](${url})` : `🔧 ${c.name} ${compact}`;
  }
  const header = `🔧 ${calls[0]!.name} × ${calls.length}`;
  const lines = calls.map((c) => {
    const { compact, url } = renderOne(c);
    return url ? `[• ${compact}](${url})` : `• ${compact}`;
  });
  return [header, ...lines].join("\n");
};



// Render one transcript line into tagged items. Caller decides batching.
const renderLine = (raw: string, deps: TailDeps): RenderItem[] => {
  let line: TranscriptLine;
  try {
    line = JSON.parse(raw) as TranscriptLine;
  } catch {
    return [];
  }
  if (line.isMeta || line.isSidechain) return [];

  const out: RenderItem[] = [];

  if (line.type === "user") {
    const c = line.message?.content;
    if (typeof c === "string") {
      // Skill/system feedback (e.g. `/model`'s "Set model to …", background
      // task completions) is emitted REGARDLESS of includeUser — it's system
      // output, not the user's own chatter, so the includeUser=false default
      // (which suppresses echoing user lines) must not swallow it.
      // Match against raw content BEFORE cleanUserText strips the tag.
      const stdoutMatch = c.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (stdoutMatch && stdoutMatch[1]) {
        const skillOutput = stdoutMatch[1].replace(/\[[0-9;]*m/g, "").trim();
        if (skillOutput) {
          out.push({ kind: "skill_output", body: `⚙️ ${skillOutput}` });
        }
        return out;
      }

      // Background task completion — strip the raw tag soup and render
      // a single styled line.
      const taskMatch = c.match(TASK_NOTIF_RE);
      if (taskMatch && taskMatch[1]) {
        out.push({ kind: "skill_output", body: renderTaskNotification(taskMatch[1]) });
        return out;
      }

      if (!deps.includeUser) return [];

      const text = cleanUserText(c);
      if (!text) return []; // pure slash-command meta / stdout — drop
      if (deps.isOwnInject(text)) return []; // dedupe WeCom→CLI echo
      const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
      out.push({ kind: "user_text", body: quoted });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const raw = extractToolResultText(b);
        if (!raw) continue;
        const toolUseId = b.tool_use_id ?? "";
        // 始终把完整 result 落 detail 库 — 与 includeToolResults(气泡推送开关)解耦,
        // 否则关掉气泡时点"详情"看不到 result。
        if (toolUseId) recordToolResult(toolUseId, truncate(raw, DETAIL_RESULT_MAX));
        if (!deps.includeToolResults) continue;
        const full = truncate(raw, deps.toolResultMaxChars);
        const compact = safeForMarkdown(oneLineSummary(full, 40));
        const url = deps.detailUrlFor(toolUseId);
        out.push({
          kind: "tool_result",
          toolUseId,
          full,
          body: url ? `[↩ ${compact}](${url})` : `↩ ${compact}`,
        });
      }
    }
    return out;
  }

  if (line.type === "assistant") {
    const blocks = line.message?.content;
    if (!Array.isArray(blocks)) return [];
    // Mark text items emitted from a terminal-stop_reason line as `final`.
    // Per Anthropic protocol, a line with stop_reason ∈ {end_turn, stop_sequence,
    // max_tokens} contains only text blocks (tool_use → stop_reason="tool_use"),
    // so these texts ARE the agent's final answer for the turn. Downstream uses
    // `final` to decide bubble splits — mid-turn text appends; only final text
    // after tools peels out into its own standalone (preview = real answer).
    const sr = line.message?.stop_reason;
    const isFinal = sr === "end_turn" || sr === "stop_sequence" || sr === "max_tokens";
    let pending: Array<{ toolUseId: string; name: string; input: unknown }> = [];
    const flushPending = (): void => {
      if (pending.length === 0) return;
      const calls = pending;
      pending = [];
      // 每个 tool_use 都要单独 recordTool, 这样点击-查看-详情可以按 id 命中。
      for (const c of calls) {
        if (c.toolUseId) {
          recordTool({
            id: c.toolUseId,
            toolName: c.name,
            toolInput: c.input,
            sessionId: deps.sessionId,
            target: deps.target,
          });
        }
      }
      out.push({
        kind: "tool_use",
        calls,
        body: renderToolUseGroupBody(calls, deps),
      });
    };
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        flushPending();
        const t = b.text.trim();
        if (t && !deps.isOwnAssistantSend?.(t)) out.push({ kind: "text", body: t, final: isFinal });
      } else if (b?.type === "tool_use" && deps.includeTools) {
        const name = b.name ?? "tool";
        const toolUseId = b.id ?? "";
        // 同名扩展当前 group; 不同名先 flush 再起新组。
        if (pending.length > 0 && pending[0]!.name !== name) flushPending();
        pending.push({ toolUseId, name, input: b.input });
      }
      // thinking blocks intentionally skipped
    }
    flushPending();
    // Emit per-line usage snapshot BEFORE turn_end so brief store gets the last
    // increment before the turn closes. Non-brief onItem drops it silently.
    const u = line.message?.usage;
    if (u) {
      const model = typeof line.message?.model === "string" ? line.message.model : undefined;
      out.push({
        kind: "turn_usage",
        model,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          serviceTier: u.service_tier,
          calls: 1,
        },
      });
    }
    // Terminal stop_reason → emit turn_end so onItem closes the live bubble.
    // `tool_use` is intentionally excluded — more turns will follow once the
    // tool result lands; finalizing now would split a single logical reply.
    if (isFinal) out.push({ kind: "turn_end" });
    return out;
  }

  // Slash-command records for TUI-only commands land here as `type:"system"`,
  // `subtype:"local_command"` — the invocation itself and, if present, a
  // sibling `<local-command-stdout>` line carrying the rendered panel.
  //   • /context (2.1.139+): dumps the full panel as ANSI-decorated text.
  //   • /model on Claude Code 2.1.139 still lands under `type:"user"`, so this
  //     branch is currently /context-focused; other future TUI-only commands
  //     that follow the same shape will fall through the same anchoring.
  if (line.type === "system" && line.subtype === "local_command" && typeof line.content === "string") {
    const stdout = line.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1] ?? "";
    if (!stdout.trim()) return []; // pure invocation record or empty stdout
    const cleaned = stripAnsi(stdout);
    const anchored = anchorSkillOutput(cleaned);
    if (!anchored) return [];
    // Fenced code block so WeCom renders the aligned /context panel monospaced
    // (the bar-chart columns only line up in a fixed-width bubble).
    return [{ kind: "skill_output", body: "⚙️\n```\n" + anchored + "\n```" }];
  }

  return [];
};

// Greedy line-wise packing — never cuts mid-line, so a `[text](url)` link
// (always emitted as a single line) is never bisected. A single oversized
// line falls back to char-slicing for that line only.
const splitChunks = (s: string, max: number): string[] => {
  if (s.length <= max) return [s];
  const out: string[] = [];
  let cur = "";
  const flush = (): void => { if (cur) { out.push(cur); cur = ""; } };
  for (const line of s.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
      continue;
    }
    const next = cur ? cur + "\n" + line : line;
    if (next.length > max) { flush(); cur = line; } else { cur = next; }
  }
  flush();
  return out;
};

interface TailHandle {
  stop: () => void;
  /** Synchronously pull and emit any newly-appended jsonl lines. fs.watch
   *  usually fires fast enough but the approval card path needs a hard barrier
   *  before sending: callers can force the tail to catch up so any pending
   *  assistant text is queued onto the mirror's outbound paths first. */
  drain: () => void;
}

export const startMirrorTail = (deps: TailDeps): TailHandle => {
  const { log } = deps;

  // A single logical tail follows ONE sessionId whose transcript file may move
  // between sibling project dirs — Claude Code's EnterWorktree/ExitWorktree
  // rename <sid>.jsonl into/out of <cwd>/.claude/worktrees/<name>, each cwd
  // encoding to its own project dir. We keep a candidate path list (seeded with
  // the attach-time path, grown lazily by sid on first miss) and ONE shared
  // offset. Because the move is a rename (byte prefix preserved), the offset
  // stays continuous across enter→work→exit: no re-dump, no missed lines, and
  // switching back to the original path just resumes on the same offset.
  const projectsRoot = dirname(dirname(deps.jsonlPath));
  const candidates: string[] = [deps.jsonlPath];

  // Newest-mtime candidate that currently exists (the move can briefly leave a
  // stale sibling behind under copy-then-delete semantics; the destination wins).
  const existing = (): string | undefined =>
    candidates
      .flatMap((p) => { try { return [{ p, m: statSync(p).mtimeMs }]; } catch { return []; } })
      .sort((a, b) => b.m - a.m)[0]?.p;

  // Live path: a known candidate if one exists; else the file relocated — find
  // it by sid and cache so subsequent round-trips are a pure stat pick (no rescan).
  const resolveLive = (): string | undefined => {
    const known = existing();
    if (known) return known;
    const found = findJsonlBySid(projectsRoot, deps.sessionId);
    if (found && !candidates.includes(found)) candidates.push(found);
    return existing();
  };

  // Start at EOF — don't re-emit history. File may not exist yet (auto-spawn
  // path: claude doesn't create the jsonl until it processes the first input);
  // start at 0 in that case so we capture everything once it appears.
  // Caller-provided startOffset wins (used by /clear migration to replay the
  // already-written user line + any early assistant lines from offset 0).
  let offset = deps.startOffset !== undefined
    ? deps.startOffset
    : (() => { const p = resolveLive(); return p ? statSync(p).size : 0; })();
  let buffer = "";
  let stopped = false;

  // fs.watch binds one path; re-arm it on the live path whenever the file
  // relocates. The 1s poll is the correctness floor either way.
  let watcher: FSWatcher | undefined;
  let watchedPath = "";
  const armWatch = (path: string): void => {
    if (path === watchedPath) return;
    watcher?.close();
    watchedPath = path;
    try {
      watcher = watch(path, { persistent: false }, () => drain());
    } catch (e) {
      watcher = undefined;
      log.warn({ err: (e as Error).message }, "fs.watch failed; relying on poll");
    }
  };

  const drain = (): void => {
    if (stopped) return;
    const jsonlPath = resolveLive();
    if (!jsonlPath) return;
    armWatch(jsonlPath);
    let size: number;
    try {
      size = statSync(jsonlPath).size;
    } catch {
      return;
    }
    if (size < offset) {
      // file truncated/rotated — reset to new EOF
      offset = size;
      buffer = "";
      return;
    }
    if (size === offset) return;
    const fd = openSync(jsonlPath, "r");
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = size;
      buffer += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      for (const item of renderLine(line, deps)) deps.onItem(item);
    }
  };

  const live0 = resolveLive();
  if (live0) armWatch(live0);
  const poll = setInterval(drain, 1000);

  log.info({ jsonlPath: deps.jsonlPath, startOffset: offset }, "mirror tail started");

  return {
    stop: () => {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
    drain,
  };
};

// ── Inject (WeCom → claude) ───────────────────────────────────────────
// Two strategies:
//  • spawn  — `claude --resume <sid> -p <text>`. Writes a turn into the jsonl,
//             but the live interactive TTY claude (a different process) won't
//             observe it. Outbound tail still picks it up → user sees response
//             in WeCom only.
//  • tmux   — paste into the live TTY via tmux. Indistinguishable from the
//             user typing; claude processes normally → response visible in BOTH
//             the CLI and (via outbound tail) WeCom. Required for true mirror.
interface InjectArgs {
  text: string;
  /** Image absolute paths. injectViaTmux pumps each via clipboard+Ctrl+V before
   *  the text paste; injectViaSpawn prepends `@<path>` to text. */
  images?: string[];
  cfg: Config;
  log: Logger;
  sessionId: string;
  /** tmux pane (e.g. `%5`) auto-discovered from caller's $TMUX_PANE at attach time. Empty → spawn-mode inject (writes to jsonl only, not the live TTY). */
  tmuxTarget?: string;
  /** Set when this inject runs immediately after a `claude --resume` respawn:
   *  the TUI is still loading the transcript and bracketed-paste end can take
   *  several extra seconds to be processed, so the verifier uses extended
   *  timeouts. False (default) keeps warm-pane behavior untouched. */
  freshSpawn?: boolean;
}

// Run a tmux subcommand, capturing stdout/stderr. Local helper to avoid
// pulling spawn-tmux's runTmux into the bridge module graph.
const tmuxRun = (args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const p = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", (e) => resolve({ ok: false, stdout: "", stderr: e.message }));
    p.on("close", (code) => resolve({ ok: code === 0, stdout: out, stderr: err }));
  });

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Stable JSON: sort object keys recursively. Used to fingerprint a tool_use's
// `input` so the hook-side and the jsonl-side compute the same signature even
// when the model emits keys in arbitrary order.
const stableStringify = (v: unknown): string => {
  if (v === null || v === undefined) return JSON.stringify(v);
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
};
const toolUseSig = (name: string, input: unknown): string => `${name}|${stableStringify(input)}`;
const RECENT_SIGS_MAX = 64;

// macOS clipboard image inject. Claude Code's TUI handles Ctrl+V by reading the
// system clipboard for image data and attaching it as an image content block in
// the next user turn — no Read tool call, no permission prompt. To trigger that
// path we (a) put image bytes onto the clipboard with the right AppleScript
// pasteboard class, (b) send a literal C-v keystroke to the live tmux pane.
//
// Pasteboard class per source format:
//   .png         → «class PNGf»
//   .jpg/.jpeg   → JPEG picture
//   .gif         → «class GIFf»
//   .tiff/.tif   → «class TIFF»
// Anything else (webp/heic/...) we transcode to PNG via `sips` first; sips ships
// with macOS so no extra dep. Files are cached next to the original; cleanup is
// left to the inbox dir's regular eviction.
const PB_CLASS_BY_EXT: Record<string, string> = {
  png: "«class PNGf»",
  jpg: "JPEG picture",
  jpeg: "JPEG picture",
  gif: "«class GIFf»",
  tif: "«class TIFF»",
  tiff: "«class TIFF»",
};

const runProc = (cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    p.on("error", (e) => resolve({ ok: false, stderr: e.message }));
    p.on("close", (code) => resolve({ ok: code === 0, stderr: err }));
  });

const setMacClipboardImage = async (imgPath: string): Promise<{ ok: boolean; reason?: string }> => {
  const ext = (imgPath.split(".").pop() ?? "").toLowerCase();
  let pbClass = PB_CLASS_BY_EXT[ext];
  let pathToUse = imgPath;
  if (!pbClass) {
    // Transcode to PNG so AppleScript can pull it onto the pasteboard.
    const tmp = `${imgPath}.cb.png`;
    const r = await runProc("sips", ["-s", "format", "png", imgPath, "--out", tmp]);
    if (!r.ok) return { ok: false, reason: `sips ${ext}→png failed: ${r.stderr.slice(-200)}` };
    pathToUse = tmp;
    pbClass = "«class PNGf»";
  }
  // POSIX path quoting: backslash-escape `\` and `"` for AppleScript string literal.
  const escaped = pathToUse.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `set the clipboard to (read POSIX file "${escaped}" as ${pbClass})`;
  const r = await runProc("osascript", ["-e", script]);
  if (!r.ok) return { ok: false, reason: `osascript: ${r.stderr.slice(-200)}` };
  return { ok: true };
};

// Pane fingerprint for verifying paste/submit. `rows` controls how far back
// from the bottom to capture: a wide window (12) for paste-landed (lenient,
// catches wrapped content / hint lines), a narrow window (5) for input-box-
// cleared. The narrow window matters after `/clear`: the buffer is almost
// empty, so claude's echo of the just-submitted message sits directly above
// the input box and would otherwise re-trigger the fingerprint, falsely
// flagging "Enter not honored".
const capturePaneTail = async (target: string, rows = 12): Promise<string> => {
  const r = await tmuxRun(["capture-pane", "-t", target, "-p", "-S", `-${rows}`]);
  return r.ok ? r.stdout : "";
};

// Strip ANSI SGR + CSI + OSC sequences so a slash-command stdout is safely
// embeddable in a WeCom bubble. We don't try to preserve color — text only.
const stripAnsi = (s: string): string =>
  s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "");

// Trim slash-command stdout to the useful section. TUI panels prepend a run
// of leading whitespace / bar-chart glyph rows before the human-readable
// title; we anchor at the first title line and drop everything above. The
// anchors here are the known /context titles — extend when new commands
// route through this branch.
const SKILL_ANCHORS = ["Context Usage"];
const anchorSkillOutput = (raw: string): string => {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => SKILL_ANCHORS.some((a) => l.includes(a)));
  const sliced = idx >= 0 ? lines.slice(idx) : lines;
  return sliced.join("\n").replace(/^\s+|\s+$/g, "");
};

// How far back to capture when recovering a pre-card preamble. Preambles before
// AskUserQuestion/ExitPlanMode are short; 40 rows covers wrap + the pending
// tool/picker below it without dragging in the previous turn.
const PANE_PREAMBLE_ROWS = 40;
const BULLET = "⏺"; // ⏺ — Claude Code's assistant/tool bullet
// Indented lines that are tool-execution summaries, not prose wrap. Filtered out
// when they sandwich between prose and the pending tool.
const TOOL_SUMMARY_RE =
  /^(⎿|… ?\+?\d|Ran |Read |Wrote |Edited |Listed |Searched |Found |Fetched |Called |Committed |Pushed |Pulled |Rebased |Staged |Updated )/u;
// After `⏺ `: a tool call (`Bash(…`) or a collapsed summary → not prose.
const isToolBullet = (afterBullet: string): boolean =>
  /^[A-Za-z_][\w.-]*\(/u.test(afterBullet) || TOOL_SUMMARY_RE.test(afterBullet);

// Pull the most recent assistant PROSE block out of a Claude Code TUI capture —
// the "why" that precedes a pending approval tool. CC renders prose as
// `⏺ <text>` + 2-space-indented wrapped lines; tool calls as `⏺ Name(…)` and
// summaries as indented `Ran…/Read…/⎿…`. Walk up from the bottom past the
// pending tool region to the last prose bullet, then collect its block.
// Best-effort: returns "" when nothing confident is found (caller sends the
// card alone — status-quo, no regression).
const extractPaneAssistantTail = (pane: string): string => {
  const lines = pane.replace(/[\s﻿]+$/u, "").split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!;
    if (/^❯\s+\S/u.test(ln)) return ""; // a user-message echo above → no preamble between it and here
    // note: the empty input-box prompt (`❯ ` + NBSP, nothing after) is NOT a boundary — skip it
    if (ln.startsWith(BULLET + " ")) {
      if (!isToolBullet(ln.slice(2).trimStart())) { start = i; break; }
      // tool bullet (the gating tool) — keep scanning up for the prose above it
    }
  }
  if (start === -1) return "";
  const out: string[] = [lines[start]!.slice(2).trimStart()];
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.trim() === "") { out.push(""); continue; }
    if (ln.startsWith(BULLET)) break;        // next block starts
    if (!/^\s{2}\S/u.test(ln)) break;        // not a 2-space continuation
    if (/[│┌┐└┘├┤┬┴┼◯○●☐☑▪▸▹]/u.test(ln)) break; // picker/table chrome
    const body = ln.trimStart();
    if (TOOL_SUMMARY_RE.test(body)) continue; // sandwiched tool summary
    out.push(body);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  const text = out.join("\n").trim();
  return text.length >= 12 ? text : "";
};

// Two fingerprints, derived from different ends of `text`:
//   headFp — first 8 non-ws chars; used for "did paste land" against a wide
//     window because long pastes wrap and the head sits near the top of the
//     input box, possibly outside a tight tail capture.
//   tailFp — last 8 non-ws chars; sits right above the cursor (bottom of the
//     input box). Used for "did input box clear" against a narrow window:
//     after Enter, claude echoes the user message ABOVE the input box, so a
//     wide capture stays "dirty" forever; a tight 5-row capture sees only
//     the input box itself, which DOES clear.
const fingerprints = (text: string): { headFp: string; tailFp: string } => {
  const stripped = text.replace(/\s+/gu, "").trim();
  return { headFp: stripped.slice(0, 8), tailFp: stripped.slice(-8) };
};

// Self-verifying inject. The cold-spawn race we guard against: paste lands
// but the trailing Enter is eaten while the TUI is still initializing, so
// the prompt sits typed-but-unsent. Strategy:
//   1. paste; wide-window poll for headFp → paste reached the input box.
//   2. settle; send Enter.
//   3. narrow-window poll (last 5 rows = just the input box, NOT the echo
//      above) for tailFp absence → submit was honored.
//   4. on stuck-after-Enter, retry Enter once with extra settle.
const injectViaTmux = async (target: string, text: string, images: string[], log: Logger, freshSpawn: boolean): Promise<{ ok: boolean; reason?: string; uncertain?: boolean }> => {
  log.info({ target, len: text.length, images: images.length, freshSpawn }, "mirror inject (tmux)");

  // Pump images first via clipboard+C-v so each one is attached as a separate
  // image content block. Each C-v needs a brief settle for Claude Code's TUI
  // to read the clipboard before the next overwrite. Fresh spawn extends.
  const IMG_SETTLE_MS = freshSpawn ? 700 : 350;
  for (const imgPath of images) {
    const cb = await setMacClipboardImage(imgPath);
    if (!cb.ok) {
      log.warn({ imgPath, reason: cb.reason }, "mirror inject: clipboard set failed, skipping image");
      continue;
    }
    const cv = await tmuxRun(["send-keys", "-t", target, "C-v"]);
    if (!cv.ok) return { ok: false, reason: `tmux send-keys C-v failed: ${cv.stderr.slice(-200)}` };
    await sleepMs(IMG_SETTLE_MS);
  }

  // Image-only message: TUI input box now holds the attached images; press
  // Enter and we're done. No fingerprint to verify (the input itself is binary
  // image refs, not text).
  if (!text) {
    if (images.length === 0) return { ok: true };
    const e = await tmuxRun(["send-keys", "-t", target, "Enter"]);
    return e.ok ? { ok: true } : { ok: false, reason: `tmux send-keys Enter failed: ${e.stderr.slice(-200)}` };
  }

  // Warm pane: tight timings, low latency. Fresh spawn (claude --resume just
  // started, transcript still loading): extended timings — bracketed-paste
  // end can take 4-7s to be honored on a cold TUI. Only the fresh-spawn path
  // pays the latency cost.
  const PASTE_VERIFY_MS = freshSpawn ? 6000 : 2500;
  const POST_PASTE_SETTLE_MS = freshSpawn ? 1500 : 400;
  const POST_PASTE_SETTLE_FALLBACK_MS = freshSpawn ? 2500 : 700;
  const CLEARED_TIMEOUT_MS = freshSpawn ? 4000 : 1500;
  const RETRY_SETTLE_MS = freshSpawn ? 1500 : 800;

  const loadAndPaste = async (): Promise<{ ok: boolean; reason?: string }> => {
    const loaded = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const loader = spawn("tmux", ["load-buffer", "-"], { stdio: ["pipe", "ignore", "pipe"] });
      let lerr = "";
      loader.stderr?.on("data", (c: Buffer) => (lerr += c.toString("utf8")));
      loader.on("error", (e) => resolve({ ok: false, reason: `tmux not found: ${e.message}` }));
      loader.on("close", (code) => {
        if (code !== 0) resolve({ ok: false, reason: `tmux load-buffer exit ${code}: ${lerr.slice(-200)}` });
        else resolve({ ok: true });
      });
      loader.stdin?.end(text);
    });
    if (!loaded.ok) return loaded;
    const pasted = await tmuxRun(["paste-buffer", "-p", "-d", "-t", target]);
    if (!pasted.ok) return { ok: false, reason: `tmux paste-buffer failed: ${pasted.stderr.slice(-200)}` };
    return { ok: true };
  };

  let r = await loadAndPaste();
  if (!r.ok) return r;

  const { headFp, tailFp } = fingerprints(text);
  const POLL_MS = 100;
  const stripWs = (s: string): string => s.replace(/\s+/gu, "");

  // Wide window catches a wrapped paste's head whether it's row -3 or row -10.
  const sawHead = async (timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const pane = await capturePaneTail(target, 12);
      if (headFp && stripWs(pane).includes(headFp)) return true;
      await sleepMs(POLL_MS);
    }
    return false;
  };

  // Narrow window = just the input box. tailFp is the chars next to the
  // cursor, so it's always inside this window pre-submit and gone post-submit.
  const inputBoxStillHasTail = async (): Promise<boolean> => {
    const pane = await capturePaneTail(target, 5);
    return Boolean(tailFp) && stripWs(pane).includes(tailFp);
  };

  let pasteSeen = await sawHead(PASTE_VERIFY_MS);
  if (!pasteSeen) {
    // Paste fired before the TUI was reading — re-paste once after a back-off.
    log.warn({ target, headFp }, "mirror inject: paste headFp not seen, re-pasting");
    await sleepMs(RETRY_SETTLE_MS);
    r = await loadAndPaste();
    if (!r.ok) return r;
    pasteSeen = await sawHead(PASTE_VERIFY_MS);
  }

  // Bracketed-paste end + TUI catch-up. Warm pane: 400ms is invisible.
  // Fresh respawn: 1500ms+ — claude --resume is still loading the transcript.
  await sleepMs(pasteSeen ? POST_PASTE_SETTLE_MS : POST_PASTE_SETTLE_FALLBACK_MS);

  const sendEnter = async (): Promise<{ ok: boolean; reason?: string }> => {
    const e = await tmuxRun(["send-keys", "-t", target, "Enter"]);
    return e.ok ? { ok: true } : { ok: false, reason: `tmux send-keys failed: ${e.stderr.slice(-200)}` };
  };
  const waitForCleared = async (timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleepMs(POLL_MS);
      if (!(await inputBoxStillHasTail())) return true;
    }
    return false;
  };

  const e1 = await sendEnter();
  if (!e1.ok) return e1;
  if (!pasteSeen) log.warn({ target }, "mirror inject: submitted without paste verification (capture-pane lag)");
  if (!tailFp) return { ok: true }; // empty/whitespace text — nothing to verify

  if (await waitForCleared(CLEARED_TIMEOUT_MS)) return { ok: true };

  // Input box still holds our tail — Enter was eaten (cold TUI) or the
  // bracketed-paste end hadn't been processed yet. One retry with extra
  // settle. We keep this to ONE retry to bound damage if our cleared-check
  // is wrong (would otherwise spam Enters into a real conversation).
  log.warn({ target, tailFp }, "mirror inject: input box still has text after Enter, retrying once");
  await sleepMs(RETRY_SETTLE_MS);
  const e2 = await sendEnter();
  if (!e2.ok) return e2;
  if (await waitForCleared(CLEARED_TIMEOUT_MS)) return { ok: true };

  // freshSpawn fallback: claude --resume can take longer than our budget to
  // process bracketed-paste end. The Enter was sent twice; if it lands later,
  // claude will process the prompt and the user gets their reply. Trust it
  // rather than reporting a hard failure that the user actually got served.
  //
  // Warm-pane path also trusts: in practice tmux Enter is reliable once the
  // pane exists, and the verifier has structural false-positive risk —
  // tailFp (last 8 non-ws chars) can match the echo line directly above the
  // input box when it falls within the 5-row capture window. Surfacing
  // `[mirror] ✗` to the user when the prompt actually landed is worse than
  // accepting an extra no-op Enter on the rare true-stuck case.
  log.warn({ target, tailFp, freshSpawn }, "mirror inject: clear not observed, trusting submit");
  // Input box still held our text after two Enters. Usually the prompt landed
  // late (verifier false-positive), but it can also mean the target session is
  // busy / not consuming input (e.g. running a long task, or context full) —
  // the user's message would then silently go nowhere. Flag it uncertain so the
  // caller can hint the user, without reporting a hard failure.
  return { ok: true, uncertain: true, reason: "目标会话可能正忙或未消费输入(回车后输入框未清空)" };
};

const injectViaSpawn = (args: InjectArgs): Promise<{ ok: boolean; reason?: string }> => {
  const { text, images = [], cfg, log, sessionId } = args;
  // Spawn-mode (no live TTY) can't do clipboard+C-v — fall back to `@<path>`,
  // which Claude parses at submit time and inlines as image content blocks
  // without a model-decided Read tool turn.
  const refs = images.map((p) => `@${p}`).join("\n");
  const finalText = refs ? (text ? `${refs}\n${text}` : refs) : text;
  const cliArgs = [
    "-p",
    finalText,
    "--resume",
    sessionId,
    "--output-format",
    "stream-json",
    "--verbose",
    ...cfg.wrc.extraArgs,
  ];
  log.info({ sessionId, claudeBin: cfg.wrc.claudeBin, len: text.length }, "mirror inject");
  return new Promise((resolve) => {
    const proc = spawn(cfg.wrc.claudeBin, cliArgs, {
      cwd: expandHome(cfg.wrc.cwd),
      env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderrTail = "";
    let spawnError: Error | undefined;
    proc.on("error", (err) => {
      spawnError = err;
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1500);
    });
    proc.on("close", (code) => {
      if (spawnError) {
        log.error({ err: spawnError.message }, "mirror spawn error");
        resolve({ ok: false, reason: `spawn ${cfg.wrc.claudeBin}: ${spawnError.message}` });
        return;
      }
      if (code !== 0) {
        log.error({ code, stderrTail: stderrTail.slice(-400) }, "mirror inject non-zero");
        resolve({ ok: false, reason: `claude exited ${code}: ${stderrTail.slice(-300)}` });
        return;
      }
      resolve({ ok: true });
    });
  });
};

const inject = (args: InjectArgs): Promise<{ ok: boolean; reason?: string; uncertain?: boolean }> => {
  const target = (args.tmuxTarget ?? "").trim();
  return target ? injectViaTmux(target, args.text, args.images ?? [], args.log, args.freshSpawn ?? false) : injectViaSpawn(args);
};

// ── Per-session injection queue ───────────────────────────────────────
type Job = () => Promise<void>;
const queues = new Map<string, Promise<void>>();
const enqueue = (key: string, job: Job): Promise<void> => {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job).catch(() => undefined);
  queues.set(
    key,
    next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    }),
  );
  return next;
};

// ── Public bridge API ─────────────────────────────────────────────────
export interface MirrorDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  store: MirrorStore;
}

export interface MirrorDispatchArgs {
  principal: string;
  text: string;
  /** Absolute paths to image files. Tmux mode pumps each via macOS clipboard +
   *  Ctrl+V (matches Claude Code's documented image paste path → image content
   *  block, NO Read tool turn). Spawn-mode falls back to `@<path>` prepended
   *  to text so the headless `claude --resume -p` reads the file at submit. */
  images?: string[];
  frame: WsFrameHeaders;
  streamId: string;
}

export interface AttachArgs {
  sessionId: string;
  jsonlPath: string;
  target?: string; // optional override; falls back to cfg.wrc.mirror.pushChat || cfg.defaultChat
  /** tmux pane (e.g. `%5`); usually auto-discovered from caller's $TMUX_PANE. Empty → spawn-mode inject. */
  tmuxPane?: string;
  /** tmux session name (e.g. `weclaude-xxx`). Persisted so a reload can re-derive a fresh paneId for the same session. */
  tmuxSession?: string;
  /** Cwd the live pane is running in. Persisted so /pwd can show truth and
   *  /clear can detect mismatch. Empty → cfg.wrc.cwd. */
  cwd?: string;
  /** User-requested next cwd (carry-over on re-attach). */
  pendingCwd?: string;
}

export interface AttachResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  jsonlPath?: string;
  target?: string;
}

export interface MirrorBridge {
  dispatch: (args: MirrorDispatchArgs) => Promise<void>;
  shutdown: () => void;
  attach: (args: AttachArgs) => AttachResult;
  status: () => {
    attached: boolean;
    mirrors: Array<{ sessionId: string; jsonlPath: string; target: string }>;
    /** Convenience fields mirroring the first attachment, for back-compat callers. */
    sessionId?: string;
    jsonlPath?: string;
    target?: string;
  };
  /** True if `principal` (e.g. "chat:xxx" / "user:xxx") is currently a mirror target — used by inbound gating to implicitly authorize talkback. */
  hasMirrorTarget: (principal: string) => boolean;
  /** Look up the mirror target (e.g. "chat:xxx") bound to a Claude sessionId. Used by approval to route cards to the originating WeCom chat. */
  targetForSession: (sessionId: string) => string | undefined;
  /** Look up the mirror target bound to a tmux pane id (e.g. "%20"). Pane id is
   *  stable across `/clear` (which rotates sessionId), so MCP tools whose env
   *  sessionId went stale after a clear can still resolve their own chat. */
  targetForPane: (tmuxPane: string) => string | undefined;
  /** Returns full tool detail markdown for a turnId, or undefined if expired/unknown. */
  resolveToolDetail: (turnId: string) => { target: string; markdown: string[] } | undefined;
  /** Approval-click hook: finalize any open liveStream for this Claude sessionId
   *  so subsequent tool_use / tool_result items fall through to the debounced
   *  standalone path instead of growing the same bubble. No-op when no live
   *  stream exists. */
  terminateLiveStream: (sessionId: string) => void;
  /** Pre-card hook: drain any pending assistant text/tool markdown for this
   *  session and await the per-attachment FIFO so the card race never lets the
   *  vote/approval card overtake the "thinking" bubble. Resolves once all
   *  outbound mirror sends queued so far have hit WeCom. No-op when no
   *  attachment exists for the session. When `expect` is provided, polls
   *  `tail.drain()` until the assistant message containing that tool_use is
   *  observed in the jsonl (closes the race where Claude Code's flush trails
   *  the hook fire by tens-to-hundreds of ms). */
  flushBeforeCard: (
    sessionId: string,
    expect?: { toolName: string; toolInput: unknown },
  ) => Promise<void>;
  /** Inject text into an attached mirror without an originating WeCom frame.
   *  Used by `weclaude init` to fire a demo prompt right after auto-spawn so
   *  the user sees the full PreToolUse → approval card → assistant mirror
   *  loop end-to-end. Skips the live-stream/replyStream machinery — the tail
   *  pushes assistant output via the standalone path. */
  injectText: (target: string, text: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Send Esc to the live tmux pane bound to `target` — interrupts whatever
   *  Claude is currently doing (active generation / open prompt). No-op for
   *  spawn-mode attachments (no live TTY to interrupt). */
  interruptPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Send a bare Enter to the live tmux pane bound to `target` — confirms a
   *  prompt / press-enter-to-continue, or submits the input box as-is. No-op
   *  for spawn-mode attachments (no live TTY). */
  submitPane: (target: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Cwd lifecycle for the chat-bound project path. `getCwd` returns
   *  `{ runningCwd, pendingCwd, defaultCwd }` so /pwd can render all three
   *  truthfully. `setPendingCwd` writes the user-requested next cwd into the
   *  store; `clearPendingCwd` is called by the bridge after a /new spawn lands. */
  getCwd: (target: string) => { runningCwd: string; pendingCwd: string; defaultCwd: string };
  setPendingCwd: (target: string, cwd: string) => { ok: boolean; reason?: string; runningCwd: string; pendingCwd: string };
  /** Detach + respawn a target's pane in `cfg.wrc.cwd` or its pendingCwd
   *  override. Used by /new to give the user a fresh claude in the bound
   *  project. Returns the new attachment result. */
  newSession: (target: string, windowName?: string) => Promise<{ ok: boolean; reason?: string; sessionId?: string; cwd?: string }>;
}

interface ToolEntry {
  toolUseId: string;
  name: string;
  input: unknown;
  result?: string;
}

interface ActiveStream {
  turnId: string;
  frame: WsFrameHeaders;
  streamId: string;
  acc: string;
  lastSent: string;
  capped: boolean;
  closed: boolean;
  dead: boolean; // server rejected; subsequent items go to standalone
  flushTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  cardSent: boolean;
  tools: ToolEntry[];
  /** 本流内已追加过 tool_use/tool_result。规则 1: tool 之后的首个 text item
   *  截断当前 stream, 让最终文本回复落到独立 standalone 气泡。 */
  sawTool: boolean;
}

interface AttachState {
  sessionId: string;
  jsonlPath: string;
  target: string;
  /** tmux pane (e.g. `%5`) of the live claude process; auto-discovered from $TMUX_PANE on attach. Empty → fall back to spawn-mode inject. */
  tmuxPane: string;
  /** tmux session name; kept so we can re-derive `tmuxPane` after a daemon reload (pane ids aren't stable across the daemon process). */
  tmuxSession: string;
  /** Cwd the live pane was actually spawned/respawned in (post-expandHome).
   *  Diverges from `pendingCwd` when the user has requested a switch but
   *  hasn't yet hit /new — /clear bridges the gap by upgrading to /new. */
  runningCwd: string;
  /** User-requested next cwd (set via `cd` MCP tool). Applied at
   *  next /new (or /clear → upgraded to /new). Cleared after the spawn. */
  pendingCwd: string;
  tail: TailHandle;
  liveStream?: ActiveStream;
  /** Per-attachment FIFO so standalone pushes from the same mirror stay ordered. */
  standalonePending: Promise<void>;
  /** Debounce buffer for the standalone fallback path. liveStream 活时为 undefined,
   *  fallback 落入时累积 item.body, debounce 窗口结束统一发出, 抑制工具调用刷屏。 */
  standaloneBuf?: { parts: string[]; timer: NodeJS.Timeout };
  /** Set when `/clear` was injected: the next user prompt will land in a fresh
   *  jsonl with a new sessionId. A watcher polls the project dir to migrate
   *  this attachment onto the new file. Cleared once migration completes or
   *  the watcher times out. */
  migrationWatcher?: { cancel: () => void };
  /** Per-turn outbound state machine. undefined ≡ IDLE (no active turn)
   *  / STREAMING (a.liveStream is the source of truth in that phase).
   *  Set on dispatch when outboundDeferMs > 0; cleared on promote/exit. */
  outbound?: OutboundState;
  /** Recent tool_use signatures observed via onItem — `${name}|${stableJSON(input)}`.
   *  flushBeforeCard polls drain() until the to-be-approved tool's sig appears
   *  here, closing the race where the hook fires before Claude Code has
   *  finished flushing the assistant message (with its preceding text) to disk.
   *  Bounded ring; insertion order via Map iteration. */
  recentToolSigs: Map<string, number>;
  /** Brief 模式当前 turn 的 id (由 newTurnId 生成)。空 = 没有活跃 turn。
   *  brief 模式下所有 tool_use / tool_result / 中间 text 只写入 detail store,
   *  不发气泡; final text / turn_end 触发关闭 + finish 消息。 */
  briefTurnId?: string;
  /** Brief turn 的 loading 气泡 —— 起始以 "…" (finish=false) 挂住不关闭。turn 收口
   *  时才定最终内容: 无工具→直接把结论写进这个气泡; 有工具→写详情链接 (结论另发
   *  standalone)。hardTimer 兜底 WeCom ~6min stream 窗口, 到点强制收口。 */
  briefBubble?: { frame: WsFrameHeaders; streamId: string; hardTimer: NodeJS.Timeout; done: boolean };
  /** 本 turn 是否出现过 tool_use —— 决定气泡收口写结论还是写详情链接。 */
  briefHadTool?: boolean;
  /** 本 turn 由 slash 命令 (/context…) 触发 —— 其 skill_output 即答案, 写进气泡而非 standalone。 */
  briefIsSlash?: boolean;
}

// Mirror outbound state machine. See plan: defer stream open by N ms; flush
// buffered items as one standalone if a needs-approval tool_use shows up
// (so it lands BEFORE the approval card); resume with a fresh stream after
// the user clicks. Pure-text turns that complete inside the window collapse
// to a single standalone bubble — no typewriter wasted on a finished reply.
type OutboundState =
  | {
      kind: "deferred";
      buf: RenderItem[];
      frame: WsFrameHeaders;
      streamId: string;
      timer: NodeJS.Timeout;
    }
  | {
      kind: "awaiting_appr";
      frame: WsFrameHeaders;
      streamId: string;
    };

export const startMirror = (deps: MirrorDeps): MirrorBridge => {
  const { cfg, log, client } = deps;
  // Multi-mirror: each (sessionId, target) pair is one Attachment. Same
  // sessionId reattaches → replace. Same target with different sessionId →
  // replace too (one WeCom chat can only show one mirror at a time).
  const bySessionId = new Map<string, AttachState>();
  const byTarget = new Map<string, AttachState>();

  // Ring buffer of recently-injected user texts to suppress WeCom→CLI echo.
  const INJECT_TTL_MS = 60_000;
  const recentInjects: Array<{ text: string; ts: number }> = [];
  const rememberInject = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    recentInjects.push({ text: t, ts: Date.now() });
    // Slash commands land in the jsonl wrapped in <command-name>...</command-name>
    // tags; cleanUserText renders that as `/cmd args` (backticked). Push that
    // form too so the dedupe filter catches the tail's emission — without this,
    // /clear (and any other slash inject) echoes back as a quoted bubble.
    if (t.startsWith("/")) {
      const head = t.split(/\s+/, 1)[0] ?? t;
      const args = t.slice(head.length).trim();
      recentInjects.push({ text: `\`${head}${args ? ` ${args}` : ""}\``, ts: Date.now() });
    }
    if (recentInjects.length > 64) recentInjects.shift();
  };
  const isOwnInject = (text: string): boolean => {
    const now = Date.now();
    const t = text.trim();
    for (let i = recentInjects.length - 1; i >= 0; i--) {
      const e = recentInjects[i]!;
      if (now - e.ts > INJECT_TTL_MS) continue;
      if (e.text === t) return true;
    }
    return false;
  };

  // Assistant prose pushed EARLY from a pane capture (pre-card preamble). The
  // same text lands in the jsonl later — CC flushes a tool-terminated turn only
  // when the tool resolves, i.e. after the card is answered — so the tail would
  // re-send it. Match normalized (ws-stripped) so a wrapped/dedented pane copy
  // equals the clean jsonl text; boundary match covers a pane that only caught
  // part of a long preamble. findAssistantSend peeks (dup-guard for the per-
  // question flushBeforeCard re-calls); isOwnAssistantSend consumes one-shot.
  const recentAssistantSends: Array<{ sig: string; ts: number }> = [];
  const normAssistant = (s: string): string => s.replace(/\s+/gu, "");
  const findAssistantSend = (text: string): number => {
    const sig = normAssistant(text);
    if (sig.length < 12) return -1;
    const cutoff = Date.now() - INJECT_TTL_MS;
    for (let i = recentAssistantSends.length - 1; i >= 0; i--) {
      const e = recentAssistantSends[i]!;
      if (e.ts < cutoff) continue;
      if (sig === e.sig || sig.startsWith(e.sig) || e.sig.startsWith(sig) || sig.endsWith(e.sig) || e.sig.endsWith(sig)) return i;
    }
    return -1;
  };
  const rememberAssistantSend = (text: string): void => {
    const sig = normAssistant(text);
    if (sig.length < 12) return;
    recentAssistantSends.push({ sig, ts: Date.now() });
    if (recentAssistantSends.length > 32) recentAssistantSends.shift();
  };
  const isOwnAssistantSend = (text: string): boolean => {
    const i = findAssistantSend(text);
    if (i === -1) return false;
    recentAssistantSends.splice(i, 1); // one-shot: a genuine later re-say still streams
    return true;
  };

  // ── Typewriter stream lifecycle ────────────────────────────────────
  // WeCom spec: server polls us for stream refreshes for up to 6 min from the
  // original inbound. SDK queues replyStream calls per req_id, sends serially
  // (5s ack timeout each). After 6 min the server stops accepting refreshes.
  // We keep the stream open until either (a) the next inbound supersedes it,
  // (b) the hard cap fires (just under 6 min), (c) server rejects (s.dead),
  // or (d) we hit the byte cap. No idle-based close — claude can sit thinking
  // for >60s mid-turn and we don't want to drop the bubble while it's chewing.
  const FLUSH_MS = 250;
  const HARD_TIMEOUT_MS = 350_000;
  const STREAM_SOFT_CAP = 18_000;
  const TOOL_DETAIL_TTL_MS = 24 * 60 * 60 * 1000;

  // turnId → { tools, target, expiresAt } registry for click-to-detail lookups.
  interface TurnRecord {
    tools: ToolEntry[];
    target: string;
    expiresAt: number;
  }
  const turnRegistry = new Map<string, TurnRecord>();
  const evictTurns = (): void => {
    const now = Date.now();
    for (const [k, v] of turnRegistry) if (v.expiresAt < now) turnRegistry.delete(k);
  };

  const TOOL_DETAIL_PREFIX = "TOOL_DETAIL|";
  const newTurnId = (): string => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const detailCardFor = (s: ActiveStream): TemplateCard | undefined => {
    if (s.tools.length === 0) return undefined;
    return {
      card_type: "button_interaction" as const,
      main_title: { title: "本轮工具调用" },
      sub_title_text: `共 ${s.tools.length} 次调用，点击查看详情`,
      task_id: s.turnId,
      button_list: [{ text: "查看详情", style: 1, key: `${TOOL_DETAIL_PREFIX}${s.turnId}` }],
    };
  };

  const flushStream = async (s: ActiveStream): Promise<void> => {
    s.flushTimer = undefined;
    if (s.closed || s.dead || s.acc === s.lastSent) return;
    const content = s.acc;
    s.lastSent = content;
    try {
      await client.replyStream(s.frame, s.streamId, content || " ", false);
      log.debug({ turnId: s.turnId, len: content.length }, "stream flush ok");
    } catch (e) {
      log.warn({ turnId: s.turnId, err: (e as Error).message }, "stream flush failed; marking dead");
      s.dead = true;
    }
  };
  const scheduleFlush = (s: ActiveStream): void => {
    if (s.flushTimer || s.closed || s.dead) return;
    s.flushTimer = setTimeout(() => void flushStream(s), FLUSH_MS);
  };
  const finalizeStream = async (a: AttachState, s: ActiveStream): Promise<void> => {
    if (s.closed) return;
    s.closed = true;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = undefined; }
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = undefined; }
    if (s.hardTimer) { clearTimeout(s.hardTimer); s.hardTimer = undefined; }
    if (!s.dead) {
      const card = detailCardFor(s);
      try {
        if (card) {
          s.cardSent = true;
          await client.replyStreamWithCard(s.frame, s.streamId, s.acc || " ", true, { templateCard: card });
        } else {
          await client.replyStream(s.frame, s.streamId, s.acc || " ", true);
        }
        log.info({ sessionId: a.sessionId, turnId: s.turnId, accLen: s.acc.length, tools: s.tools.length, withCard: !!card }, "stream finalize");
      } catch (e) {
        log.warn({ sessionId: a.sessionId, turnId: s.turnId, err: (e as Error).message }, "stream finalize failed");
        s.dead = true;
      }
    } else {
      log.info({ sessionId: a.sessionId, turnId: s.turnId, accLen: s.acc.length, tools: s.tools.length }, "stream finalize (dead)");
    }
    if (s.tools.length > 0) {
      turnRegistry.set(s.turnId, {
        tools: s.tools,
        target: a.target,
        expiresAt: Date.now() + TOOL_DETAIL_TTL_MS,
      });
      evictTurns();
    }
    if (a.liveStream === s) a.liveStream = undefined;
  };

  const openStream = (a: AttachState, frame: WsFrameHeaders, streamId: string): ActiveStream => {
    const s: ActiveStream = {
      turnId: newTurnId(),
      frame, streamId,
      acc: "", lastSent: "",
      capped: false, closed: false, dead: false, cardSent: false,
      tools: [], sawTool: false,
    };
    s.hardTimer = setTimeout(() => void finalizeStream(a, s), HARD_TIMEOUT_MS);
    log.info({ sessionId: a.sessionId, turnId: s.turnId, streamId }, "stream open");
    return s;
  };

  // Standalone fallback (no live stream / stream dead). Per-attachment FIFO so
  // pushes from a single mirror stay ordered; different mirrors run in parallel.
  const sendStandalone = (a: AttachState, content: string): void => {
    const chatId = stripPrincipalPrefix(a.target);
    const chunks = splitChunks(content, cfg.wrc.mirror.chunkChars);
    a.standalonePending = a.standalonePending
      .then(async () => {
        for (const c of chunks) {
          try {
            await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: c } });
          } catch (e) {
            log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "standalone push failed");
          }
        }
      })
      .catch(() => undefined);
  };

  // Pre-card preamble recovery. Called right before an approval card when the
  // gating tool_use is NOT yet in the jsonl (mirror mode: CC defers the whole
  // tool-terminated turn's flush until the tool resolves — after the card is
  // answered). The "why" text is therefore only in the live pane; capture it,
  // push it ahead of the card, and remember it so the later jsonl-tailed copy
  // is dropped as a dup. Enqueues on standalonePending, which flushBeforeCard
  // awaits — so the card lands after. Fail-safe: any miss → just the card.
  const sendPanePreamble = async (a: AttachState): Promise<void> => {
    if (!cfg.wrc.mirror.panePreamble || !a.tmuxPane) return;
    try {
      const pane = await capturePaneTail(a.tmuxPane, PANE_PREAMBLE_ROWS);
      const text = extractPaneAssistantTail(pane);
      if (!text || findAssistantSend(text) !== -1) return; // nothing new / already queued
      rememberAssistantSend(text);
      sendStandalone(a, text);
      log.info({ sessionId: a.sessionId, len: text.length }, "flushBeforeCard: pushed pane preamble before card");
    } catch (e) {
      log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "pane preamble capture failed");
    }
  };

  // Debounce 聚合: 仅 standalone 路径用。窗口内 onItem 多次落入 → 合并成单条 markdown。
  // 0 关闭时退化为透传。flushStandalone 也用于 detach 时的 drain。
  const flushStandalone = (a: AttachState): void => {
    const buf = a.standaloneBuf;
    if (!buf) return;
    a.standaloneBuf = undefined;
    sendStandalone(a, buf.parts.join("\n\n"));
  };

  const enqueueStandalone = (a: AttachState, content: string): void => {
    const ms = cfg.wrc.mirror.standaloneDebounceMs;
    if (ms <= 0) {
      sendStandalone(a, content);
      return;
    }
    if (a.standaloneBuf) {
      clearTimeout(a.standaloneBuf.timer);
      a.standaloneBuf.parts.push(content);
      a.standaloneBuf.timer = setTimeout(() => flushStandalone(a), ms);
      return;
    }
    a.standaloneBuf = {
      parts: [content],
      timer: setTimeout(() => flushStandalone(a), ms),
    };
  };

  const recordToolEntry = (s: ActiveStream, item: RenderItem): void => {
    if (item.kind === "tool_use") {
      for (const c of item.calls) {
        s.tools.push({ toolUseId: c.toolUseId, name: c.name, input: c.input });
      }
    } else if (item.kind === "tool_result") {
      // Match by toolUseId; if not found, append a standalone result entry.
      const existing = item.toolUseId
        ? s.tools.find((t) => t.toolUseId === item.toolUseId && t.result === undefined)
        : undefined;
      if (existing) existing.result = item.full;
      else s.tools.push({ toolUseId: item.toolUseId, name: "(result)", input: undefined, result: item.full });
    }
  };

  // ── Outbound deferral (DEFERRED / AWAITING_APPR state machine) ────────
  // 进入 AWAITING_APPR 的唯一触发口是 daemon 真要发卡前调的 flushBeforeCard。
  // 历史上 mirror 这边还做过一次本地 needsApproval 预判直接早闪 standalone, 但那
  // 条路无法预知 hook 会不会被 auto / bypass / 自定义 self-call 放行 — 预判错时
  // 就会出现 standalone 已经发出、随即又新开 stream 的"气泡分裂"。现在去掉,
  // 让 flushBeforeCard 作为单一信号: 发卡的真实路径 → flush as standalone,
  // 不发卡的所有路径 (auto mode、cache、bypass) → deferMs 计时器原地促进到 STREAMING。

  const renderBuf = (buf: RenderItem[]): string =>
    buf.map((i) => ("body" in i ? i.body : "")).filter(Boolean).join("\n\n");

  // Drain any pending standalone debounce so the prior turn's tail content
  // doesn't sandwich into our pre-card flush. Caller already ensured `outbound`
  // points at a deferred slot.
  const flushPendingStandalone = (a: AttachState): void => {
    if (!a.standaloneBuf) return;
    clearTimeout(a.standaloneBuf.timer);
    flushStandalone(a);
  };

  // Path A: a needs-approval tool_use just landed. Aggregate the buffer as one
  // standalone, send it BEFORE the approval card race, transition to AWAITING_APPR.
  const promoteToStandalone = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    clearTimeout(out.timer);
    const md = renderBuf(out.buf);
    a.outbound = { kind: "awaiting_appr", frame: out.frame, streamId: out.streamId };
    flushPendingStandalone(a);
    if (md) sendStandalone(a, md);
    log.info(
      { sessionId: a.sessionId, items: out.buf.length, mdLen: md.length },
      "outbound: DEFERRED → AWAITING_APPR (needs-approval flush)",
    );
  };

  // Path C: turn ended inside the deferral window (fast pure-text reply, or
  // an end-to-end tool turn that happened to fit in the window). The inbound's
  // streamId is already showing a "loading" bubble in WeCom (server polls us
  // for every msg.msgid; we haven't replied to this one) — sending a separate
  // standalone leaves that loading bubble dangling until WeCom's ~6-min
  // server-side timeout. Push the buffered content into the held streamId
  // with finish=true so the bubble fills + closes in one shot.
  //
  // Split mirrors the STREAMING tool→FINAL_text rule: if buf saw a tool AND
  // ends with a run of final-text items, peel that run out into a standalone
  // so the answer gets its own bubble (preview = real answer, not tool noise).
  // Pure-text turn or no trailing final text → no split, all into streamId.
  const exitDeferredAsFinalStream = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    clearTimeout(out.timer);
    const buf = out.buf;
    const sawTool = buf.some((i) => i.kind === "tool_use" || i.kind === "tool_result");
    let bubbleEnd = buf.length;
    if (sawTool) {
      while (bubbleEnd > 0) {
        const it = buf[bubbleEnd - 1]!;
        if (it.kind === "text" && it.final === true) bubbleEnd--;
        else break;
      }
    }
    const bubbleItems = buf.slice(0, bubbleEnd);
    const trailingFinal = buf.slice(bubbleEnd);
    const bubbleMd = renderBuf(bubbleItems);
    const trailingMd = renderBuf(trailingFinal);
    a.outbound = undefined;
    flushPendingStandalone(a);
    void (async () => {
      try {
        await client.replyStream(out.frame, out.streamId, bubbleMd || " ", true);
      } catch (e) {
        log.warn(
          { sessionId: a.sessionId, err: (e as Error).message },
          "exit-deferred finalize failed; falling back to standalone",
        );
        if (bubbleMd) sendStandalone(a, bubbleMd);
      }
      if (trailingMd) sendStandalone(a, trailingMd);
    })();
    log.info(
      { sessionId: a.sessionId, items: buf.length, bubbleLen: bubbleMd.length, trailingLen: trailingMd.length, sawTool },
      "outbound: DEFERRED → IDLE (turn_end, finalized to streamId)",
    );
  };

  // Path B: deferral timer fired without a needs-approval tool. Open a normal
  // stream and replay the buffer through onItem — it'll flow through the
  // STREAMING branch since outbound is now undefined.
  const promoteToStream = (a: AttachState): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    const { buf, frame, streamId } = out;
    a.outbound = undefined;
    const s = openStream(a, frame, streamId);
    a.liveStream = s;
    if (buf.length === 0) {
      // Empty buffer — claude still thinking. Send the "…" ack so the user
      // sees the bubble; subsequent items grow it as today.
      void (async () => {
        try {
          await client.replyStream(frame, streamId, "…", false);
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "stream initial ack failed");
        }
      })();
    }
    log.info(
      { sessionId: a.sessionId, items: buf.length, turnId: s.turnId },
      "outbound: DEFERRED → STREAMING (timer)",
    );
    for (const item of buf) onItem(a, item);
  };

  const enterDeferred = (a: AttachState, frame: WsFrameHeaders, streamId: string): void => {
    // Safety net: if nothing ever arrives (inject stuck, claude crashed, or
    // claude went silent forever), promote-to-stream after 5 min to clean up.
    // The REAL deferral window (cfg.wrc.mirror.outboundDeferMs) is armed by
    // handleDeferredItem when the first tail item lands — measuring from "claude
    // starts producing" not from "dispatch starts", which would otherwise fire
    // during inject latency (typical 1-4s for tmux paste verify) + post-inject
    // thinking gap (often 5-15s for non-trivial prompts) and falsely promote
    // an empty buffer before any tool_use can be evaluated for approval-needs.
    const SAFETY_MS = 5 * 60_000;
    const timer = setTimeout(() => promoteToStream(a), SAFETY_MS);
    a.outbound = { kind: "deferred", buf: [], frame, streamId, timer };
    log.info({ sessionId: a.sessionId, safetyMs: SAFETY_MS }, "outbound: IDLE → DEFERRED (safety net)");
  };

  // Buffer / decide while in DEFERRED. user_text is CLI-side typing (not the
  // WeCom inbound), unrelated to this turn — drop. tool_use triggers Path A
  // when ANY parallel call needs approval. First item arms the short window;
  // subsequent items don't reset (bounded promote delay).
  const handleDeferredItem = (a: AttachState, item: RenderItem): void => {
    const out = a.outbound;
    if (out?.kind !== "deferred") return;
    if (item.kind === "turn_end") {
      exitDeferredAsFinalStream(a);
      return;
    }
    if (item.kind === "user_text") return;
    // Skill outputs (e.g. /model) bypass deferred filtering — emit directly
    // as a standalone bubble so the user sees the result immediately.
    if (item.kind === "skill_output") {
      enqueueStandalone(a, item.body);
      return;
    }
    const wasEmpty = out.buf.length === 0;
    out.buf.push(item);
    if (wasEmpty) {
      // First activity from claude — swap the safety net for the short defer
      // window. flushBeforeCard 会在真要发卡前把 buf 转 AWAITING_APPR; 没卡可发
      // 时这个计时器到点就 promoteToStream, 让 bypass/auto 场景也只走一条 stream。
      clearTimeout(out.timer);
      const deferMs = cfg.wrc.mirror.outboundDeferMs;
      out.timer = setTimeout(() => promoteToStream(a), deferMs);
      log.info({ sessionId: a.sessionId, deferMs, kind: item.kind }, "outbound: first item → short defer armed");
    }
  };

  // ── Brief mode ────────────────────────────────────────────────────────
  // 每个 turn 挂一条 loading 气泡 (起始 "…" finish=false, 不立刻关掉)。收口时:
  //   • 无工具 → 直接把 Claude 最终文本 (或 slash 命令的 skill_output) 写进这条气泡。
  //   • 有工具 → 气泡收成 "✴️ 详情链接", 最终文本另发一条 standalone。
  // 其它所有 item 只写入 turn detail store。
  const briefDetailLink = (turnId: string): string =>
    `✴️ [View turn details](${buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, turnId)})`;

  // 收口 loading 气泡: finish=true 写入最终内容, 只生效一次。发送失败则退回 standalone。
  const finishBriefBubble = async (a: AttachState, content: string): Promise<void> => {
    const b = a.briefBubble;
    if (!b || b.done) return;
    b.done = true;
    clearTimeout(b.hardTimer);
    a.briefBubble = undefined;
    try {
      await client.replyStream(b.frame, b.streamId, content || " ", true);
    } catch (e) {
      log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "brief: bubble finish failed; standalone fallback");
      if (content.trim()) sendStandalone(a, content);
    }
  };

  const startBriefTurn = async (a: AttachState, frame: WsFrameHeaders, streamId: string, isSlash = false, userQuery = ""): Promise<void> => {
    if (a.briefTurnId) closeBriefTurn(a); // 上一 turn 未收尾, 强制关掉再开新的
    const turnId = newTurnId();
    a.briefTurnId = turnId;
    a.briefHadTool = false;
    a.briefIsSlash = isSlash;
    recordTurnStart({ id: turnId, target: a.target, sessionId: a.sessionId, userQuery: userQuery.trim() || undefined });
    // hardTimer 兜底: turn 若无 final text / turn_end 收口 (卡死/漏收), 到点仍收气泡。
    const hardTimer = setTimeout(
      () => void finishBriefBubble(a, a.briefHadTool ? briefDetailLink(turnId) : " "),
      HARD_TIMEOUT_MS,
    );
    a.briefBubble = { frame, streamId, hardTimer, done: false };
    try {
      await client.replyStream(frame, streamId, "…", false); // 挂住 loading 气泡, 不关闭
    } catch (e) {
      log.warn({ sessionId: a.sessionId, turnId, err: (e as Error).message }, "brief: turn ack failed");
    }
    log.info({ sessionId: a.sessionId, turnId, isSlash }, "brief: turn started");
  };

  // 本轮一旦出现工具调用 / tool_result / 非 final 文本, 就说明这不是"一句话答完"的
  // 简单 turn —— 立刻把 loading 气泡收成详情链接, 用户马上能点进去看实时刷新的时间线,
  // 不必等 turn 收口 (旧逻辑 URL 只在 closeBriefTurn 才写, 刷新太慢)。收链接即视作
  // briefHadTool, 最终结论照常另发 standalone; closeBriefTurn 见气泡已 done 会跳过。
  const earlyLinkBubble = (a: AttachState): void => {
    if (!a.briefTurnId || !a.briefBubble || a.briefBubble.done) return;
    a.briefHadTool = true;
    void finishBriefBubble(a, briefDetailLink(a.briefTurnId));
  };

  const closeBriefTurn = (a: AttachState): void => {
    if (!a.briefTurnId) return;
    // 气泡还开着 (有工具的 turn: final text 只发了 standalone, 气泡留到这里收链接;
    // 或空 turn 无 final text) —— 收口: 有工具写详情链接, 否则空占位。
    if (a.briefBubble && !a.briefBubble.done) {
      void finishBriefBubble(a, a.briefHadTool ? briefDetailLink(a.briefTurnId) : " ");
    }
    recordTurnClose(a.briefTurnId);
    log.info({ sessionId: a.sessionId, turnId: a.briefTurnId }, "brief: turn closed");
    a.briefTurnId = undefined;
    a.briefHadTool = false;
    a.briefIsSlash = false;
  };

  // Route one RenderItem into the turn store. final text 会额外作为 standalone 发群。
  const handleBriefItem = (a: AttachState, item: RenderItem): void => {
    const turnId = a.briefTurnId;
    if (!turnId) return;
    const now = Date.now();
    if (item.kind === "tool_use") {
      a.briefHadTool = true; // 有工具 → 气泡收口写详情链接, 结论另发 standalone
      earlyLinkBubble(a);    // 立刻推详情链接, 不等 turn 收口
      for (const c of item.calls) {
        // 也走单卡 detail record — turn 页里 tool_use 段可点开链到独立详情 (以后有需要时)。
        if (c.toolUseId) {
          recordTool({
            id: c.toolUseId,
            toolName: c.name,
            toolInput: c.input,
            sessionId: a.sessionId,
            target: a.target,
          });
        }
        recordTurnItem(turnId, {
          t: "tool_use",
          toolUseId: c.toolUseId,
          toolName: c.name,
          toolInput: c.input,
          ts: now,
        });
      }
      return;
    }
    if (item.kind === "tool_result") {
      earlyLinkBubble(a);
      recordTurnItem(turnId, { t: "tool_result", toolUseId: item.toolUseId, body: item.full, ts: now });
      return;
    }
    if (item.kind === "text") {
      recordTurnItem(turnId, { t: "text", body: item.body, ts: now, final: item.final === true });
      if (item.final !== true) earlyLinkBubble(a); // 非 final 中间输出 → 立刻推链接
      if (item.final === true) {
        // 收口结论: 无工具 → 直接写进 loading 气泡 (一条消息搞定); 有工具 → 气泡留给
        // closeBriefTurn 收详情链接, 结论另发 standalone。本轮 closeBriefTurn 仍由
        // turn_end 触发 (等尾随 turn_usage 落库); 此前遗留未关闭的 turn 借这次一并收尾。
        if (a.briefHadTool) sendStandalone(a, item.body);
        else void finishBriefBubble(a, item.body);
        recordCloseOpenTurns(a.target, turnId);
      }
      return;
    }
    if (item.kind === "turn_end") {
      closeBriefTurn(a);
      return;
    }
    if (item.kind === "turn_usage") {
      recordTurnUsage(turnId, { model: item.model, usage: item.usage });
      return;
    }
    if (item.kind === "skill_output") {
      recordTurnItem(turnId, { t: "text", body: item.body, ts: now });
      // slash 命令 (/context…) 的 skill_output 即本轮答案 (无 final text 收口) —— 写进
      // loading 气泡。非 slash 场景的 skill_output (task 通知等) 是中间反馈, 照旧 standalone。
      if (a.briefIsSlash && !a.briefHadTool && a.briefBubble && !a.briefBubble.done) {
        void finishBriefBubble(a, item.body);
      } else {
        sendStandalone(a, item.body);
      }
      return;
    }
    // user_text (CLI 侧输入) 在 brief 下丢弃 — turn 视角不需要展示。
  };

  const onItem = (a: AttachState, item: RenderItem): void => {
    // Record tool_use signatures unconditionally (before any state branching),
    // so flushBeforeCard's poll-drain can detect that the to-be-approved tool
    // is now persisted in the jsonl regardless of DEFERRED/STREAMING/IDLE.
    if (item.kind === "tool_use") {
      for (const c of item.calls) {
        const sig = toolUseSig(c.name, c.input);
        a.recentToolSigs.delete(sig); // re-insert at tail to keep recency order
        a.recentToolSigs.set(sig, Date.now());
        while (a.recentToolSigs.size > RECENT_SIGS_MAX) {
          const oldest = a.recentToolSigs.keys().next().value;
          if (oldest === undefined) break;
          a.recentToolSigs.delete(oldest);
        }
      }
    }
    // Usage snapshots never flow into WeCom bubbles — brief 分支下 handleBriefItem
    // 会把它写进 turn store, 非 brief 下直接吞掉, 保持 onItem 主流程只处理有渲染
    // 输出的 item 类型。
    if (item.kind === "turn_usage" && !(cfg.wrc.mirror.brief && a.briefTurnId)) {
      return;
    }
    // Brief mode 短路: 所有正常流/deferral/awaiting 全跳过, 只写入 turn store,
    // 唯一发到群里的是 turn 结束时的 finish text (下文 handleBriefItem 处理)。
    if (cfg.wrc.mirror.brief && a.briefTurnId) {
      handleBriefItem(a, item);
      return;
    }
    // 到这里已经过了 brief 分支; turn_usage 若还残留(brief=false 走上面早退,
    // brief && briefTurnId 走 handleBriefItem), 逻辑上不可能, 兜底再吞一次让 TS
    // 收窄类型 —— 下方 append/standalone 分支只处理带 body 的 item。
    if (item.kind === "turn_usage") return;
    // Brief mode 短路: 所有正常流/deferral/awaiting 全跳过, 只写入 turn store,
    // 唯一发到群里的是 turn 结束时的 finish text (下文 handleBriefItem 处理)。
    if (cfg.wrc.mirror.brief && a.briefTurnId) {
      handleBriefItem(a, item);
      return;
    }
    if (a.outbound?.kind === "deferred") {
      handleDeferredItem(a, item);
      return;
    }
    // AWAITING_APPR 兜底: needsApproval 是 mirror 这一侧的预判, hook (pre-tool-use.sh)
    // 那边在 permission_mode=auto/bypassPermissions/dontAsk 时直接放行, daemon 根本
    // 收不到 /approve, 也就永远不会有 card 点击 → onApproved 永远不触发 → AWAITING_APPR
    // 卡住, 后续 tool/text 全走 standalone fallback。这里只要看到任何新 item 到达就
    // 说明 claude 已继续执行 (hook 必然已返回 / 根本没拦), 把状态提升回 STREAMING,
    // 复用原 frame/streamId 让本轮回到打字机气泡。
    if (a.outbound?.kind === "awaiting_appr") {
      const { frame, streamId } = a.outbound;
      a.outbound = undefined;
      const s = openStream(a, frame, streamId);
      a.liveStream = s;
      log.info(
        { sessionId: a.sessionId, kind: item.kind, turnId: s.turnId },
        "outbound: AWAITING_APPR → STREAMING (hook bypassed, item arrived)",
      );
    }
    // Skill outputs (e.g. /model) always emit as standalone — never append to
    // an active stream so the result is independently visible.
    if (item.kind === "skill_output") {
      enqueueStandalone(a, item.body);
      return;
    }
    // Assistant turn truly ended (stop_reason terminal). Finalize the live
    // bubble synchronously so it becomes quotable in WeCom without waiting
    // for the next inbound or the 6-min hard timeout. No body to append.
    if (item.kind === "turn_end") {
      if (a.liveStream && !a.liveStream.closed) {
        log.debug({ sessionId: a.sessionId, turnId: a.liveStream.turnId }, "turn_end → finalize");
        void finalizeStream(a, a.liveStream);
      }
      return;
    }
    // CLI-side user line marks a turn boundary that did NOT come from WeCom.
    // Close any open WeCom liveStream first so the new conversation gets its
    // own bubble — otherwise the user's CLI exchange silently mutates the
    // previous WeCom bubble (still within its 6min update window) and is
    // invisible on the chat side.
    if (item.kind === "user_text" && a.liveStream && !a.liveStream.closed) {
      void finalizeStream(a, a.liveStream);
    }
    const s = a.liveStream;
    if (s && !s.closed && !s.dead && !s.capped) {
      // 规则 1: tool→FINAL_text 截断。仅当 text 是本 turn 的终态文本(line
      // stop_reason ∈ end_turn/stop_sequence/max_tokens)且本流已出现过 tool
      // 时, 把"最终答复"切到独立 standalone — WeCom 消息列表预览看到的就是答
      // 案而不是中间 tool 噪声。中间过程的 text(final=false)保持 append, 多
      // 轮 think→tool→think 不再被切碎。
      if (item.kind === "text" && s.sawTool && item.final === true) {
        void finalizeStream(a, s);
        enqueueStandalone(a, item.body);
        return;
      }
      const sep = s.acc ? "\n\n" : "";
      const next = s.acc + sep + item.body;
      if (next.length > STREAM_SOFT_CAP) {
        s.acc = `${s.acc}${sep}…(超出 stream 容量上限，详情见"查看详情")`;
        s.capped = true;
      } else {
        s.acc = next;
      }
      if (item.kind !== "text") {
        recordToolEntry(s, item);
        s.sawTool = true;
      }
      log.debug({ sessionId: a.sessionId, turnId: s.turnId, kind: item.kind, accLen: s.acc.length }, "stream append");
      scheduleFlush(s);
      return;
    }
    log.info({ sessionId: a.sessionId, kind: item.kind, hasLive: !!s, closed: s?.closed, dead: s?.dead, capped: s?.capped }, "fallback standalone");
    enqueueStandalone(a, item.body);
  };

  const resolveTarget = (override?: string): string =>
    sanitizeId(override?.trim() || cfg.wrc.mirror.pushChat.trim() || cfg.defaultChat.trim());

  // Detach an attachment: finalize any live stream, stop the tail, drop from indexes.
  const detach = (a: AttachState, reason: string): void => {
    if (a.migrationWatcher) { a.migrationWatcher.cancel(); a.migrationWatcher = undefined; }
    if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
    a.outbound = undefined;
    if (a.briefTurnId) closeBriefTurn(a);
    if (a.liveStream && !a.liveStream.closed) void finalizeStream(a, a.liveStream);
    if (a.standaloneBuf) { clearTimeout(a.standaloneBuf.timer); flushStandalone(a); }
    a.tail.stop();
    bySessionId.delete(a.sessionId);
    if (byTarget.get(a.target) === a) byTarget.delete(a.target);
    log.info({ sessionId: a.sessionId, target: a.target, reason }, "mirror detached");
  };

  // Click-to-detail URL for a tool_use id. Cached on the bridge so both
  // attach() and migrateAttachment() share the same closure. Returns ""
  // when disabled in config — renderLine then drops the markdown wrapping.
  const detailUrlFor = (id: string): string =>
    cfg.daemon.detailLinksInMirror && id
      ? buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id)
      : "";

  const attach = ({ sessionId, jsonlPath, target: targetOverride, tmuxPane, tmuxSession, cwd, pendingCwd }: AttachArgs): AttachResult => {
    const target = resolveTarget(targetOverride);
    if (!target) return { ok: false, reason: "no target chat (set wrc.mirror.pushChat or defaultChat, or pass target)" };
    // Note: jsonlPath may not exist yet on the auto-spawn path — claude only
    // creates its transcript after the first user input. The tail tolerates a
    // missing file (existsSync gate at start, try/catch in drain) and the 1s
    // poll picks it up the moment claude writes the first line.
    // Replace any existing attach with the same sessionId or same target. The
    // sessionId clash is the "/wrc again from same window" case; the target
    // clash is "different window steals my WeCom chat" — both end the previous.
    const prevBySid = bySessionId.get(sessionId);
    if (prevBySid) detach(prevBySid, "sessionId reattach");
    const prevByTarget = byTarget.get(target);
    // Carry over pending request only when caller didn't explicitly say
    // otherwise. `undefined` (omitted) → carry from prev (re-attach case);
    // `""` → explicit clear (newSession just consumed it); `"/foo"` → set.
    const carryPending = pendingCwd !== undefined ? pendingCwd : (prevByTarget?.pendingCwd ?? "");
    if (prevByTarget) detach(prevByTarget, "target reassigned");
    // Build the attachment first so the tail's onItem closure can capture it.
    const a: AttachState = {
      sessionId,
      jsonlPath,
      target,
      tmuxPane: (tmuxPane ?? "").trim(),
      tmuxSession: (tmuxSession ?? "").trim(),
      // Explicit cwd (spawn path) wins; otherwise derive from jsonl head so
      // /wrc attaches inherit the bound session's real project dir instead of
      // collapsing to cfg.wrc.cwd (which would mislabel /pwd, /clear, /new).
      runningCwd: expandHome(((cwd ?? "").trim()) || readCwdFromJsonl(jsonlPath) || cfg.wrc.cwd),
      pendingCwd: carryPending,
      tail: { stop: () => undefined, drain: () => undefined }, // placeholder; replaced below
      standalonePending: Promise.resolve(),
      recentToolSigs: new Map(),
    };
    a.tail = startMirrorTail({
      jsonlPath,
      log: log.child({ sub: "tail", sessionId }),
      includeUser: cfg.wrc.mirror.includeUser,
      includeTools: cfg.wrc.mirror.includeTools,
      includeToolResults: cfg.wrc.mirror.includeToolResults,
      toolResultMaxChars: cfg.wrc.mirror.toolResultMaxChars,
      toolUseInlineMaxChars: cfg.wrc.mirror.toolUseInlineMaxChars,
      isOwnInject,
      isOwnAssistantSend,
      onItem: (item) => onItem(a, item),
      detailUrlFor,
      sessionId,
      target,
    });
    bySessionId.set(sessionId, a);
    byTarget.set(target, a);
    deps.store.set(target, {
      sessionId,
      jsonlPath,
      tmuxSession: a.tmuxSession || undefined,
      tmuxPane: a.tmuxPane || undefined,
      cwd: a.runningCwd || undefined,
      pendingCwd: a.pendingCwd || undefined,
    });
    log.info({ sessionId, jsonlPath, target, tmuxSession: a.tmuxSession, runningCwd: a.runningCwd, pendingCwd: a.pendingCwd, mirrors: bySessionId.size }, "mirror attached");
    return { ok: true, sessionId, jsonlPath, target };
  };

  // ── Persistence: restore-from-store (lazy + boot) ────────────────────
  const tmuxRun = (args: string[]): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const p = spawn("tmux", args, {
        env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      p.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
      p.on("error", () => resolve({ code: null, stdout: "" }));
      p.on("close", (code) => resolve({ code, stdout: out }));
    });

  // Verify a paneId still exists. `display-message -t <paneId>` succeeds iff
  // the pane is alive — and tmux pane ids monotonically increment within a
  // server lifetime, so a freed id will not be silently reused. We don't need
  // the session name, which matters because /wrc attaches capture only $TMUX_PANE.
  const tmuxPaneAlive = async (paneId: string): Promise<boolean> => {
    if (!paneId) return false;
    const r = await tmuxRun(["display-message", "-p", "-t", paneId, "#{pane_id}"]);
    return r.code === 0 && r.stdout.trim() === paneId;
  };

  // Re-attach a stored binding for `principal`. Returns the resulting state, or
  // undefined if the on-disk transcript is gone (in which case the entry is
  // dropped so the next inbound flows through /new auto-spawn).
  const restoreFromStore = async (principal: string): Promise<AttachState | undefined> => {
    const rec = deps.store.get(principal);
    if (!rec) return undefined;
    let jsonlAbs = expandHome(rec.jsonlPath);
    if (!existsSync(jsonlAbs)) {
      // First: the SAME-sid transcript may have merely relocated to a sibling
      // project dir (Claude Code EnterWorktree/ExitWorktree moved it while the
      // daemon was down). Re-home onto it WITHOUT changing the sessionId — the
      // tail then follows it natively. Must precede the latestJsonlForCwd heal,
      // which would otherwise grab whatever session is newest in the original
      // cwd's dir (usually a *different* chat) and cross-wire the mirror.
      const projectsRoot = expandHome(cfg.wrc.mirror.projectsDir);
      const relocated = findJsonlBySid(projectsRoot, rec.sessionId);
      if (relocated) {
        log.info({ principal, sessionId: rec.sessionId, from: rec.jsonlPath, to: relocated }, "mirror restore: sid relocated (worktree), re-homed");
        rec.jsonlPath = relocated;
        jsonlAbs = relocated;
        deps.store.set(principal, rec);
      } else {
        // Recorded session rotated out from under us — a `/clear` or native `/new`
        // the daemon didn't record (e.g. it restarted while the /clear migration
        // watcher was still open). The rotation left a newer jsonl in the same
        // project dir; heal onto it instead of dropping the binding, else the
        // chat silently loses all further responses. Fail-closed drop only when
        // the project dir is truly empty.
        const healed = latestJsonlForCwd(cfg, rec.cwd || cfg.wrc.cwd);
        if (!healed) {
          log.warn({ principal, jsonlPath: rec.jsonlPath }, "mirror restore: jsonl missing and no sibling, dropping entry");
          deps.store.drop(principal);
          return undefined;
        }
        log.warn({ principal, from: rec.sessionId, to: healed.sessionId }, "mirror restore: recorded jsonl gone, healed to latest in project dir");
        rec.sessionId = healed.sessionId;
        rec.jsonlPath = healed.jsonlPath;
        jsonlAbs = healed.jsonlPath;
        deps.store.set(principal, rec);
      }
    }
    // Prefer the stored pane id and validate via display-message. Pane ids
    // (`%N`) are monotonic per tmux server lifetime, so they're stable across
    // daemon reloads as long as the tmux server didn't restart. With the
    // shared `weclaude` session hosting many chats, listing panes by session
    // name would mis-route to whichever window happens to be first — never
    // do that. If the stored pane is dead, leave tmuxPane empty and let
    // dispatch's respawn check reincarnate via `claude --resume <sid>`.
    const storedPane = (rec.tmuxPane ?? "").trim();
    const livePane = storedPane && (await tmuxPaneAlive(storedPane)) ? storedPane : "";

    // Pane-cwd worktree re-home: the stored jsonl can EXIST yet be stale because
    // the live pane entered/selected a git worktree, switching it to a DIFFERENT
    // sessionId in a sibling project dir. Trust the pane's real cwd — if its
    // project dir differs and holds a live session under another sid, bind that.
    // Without this, two chats whose panes diverged into worktrees but still
    // carry the old shared sid collide in bySessionId (attach → replace) and one
    // is silently detached; that detached chat then never mirrors again. Runs at
    // boot; the 3s drift follower maintains it thereafter.
    if (livePane) {
      const cwdRes = await tmuxRun(["display-message", "-p", "-t", livePane, "#{pane_current_path}"]);
      const paneCwd = cwdRes.stdout.trim();
      if (paneCwd) {
        const projectsRoot = expandHome(cfg.wrc.mirror.projectsDir);
        const paneDir = join(projectsRoot, encodeProjectDir(expandHome(paneCwd)));
        if (paneDir !== dirname(jsonlAbs)) {
          const live = liveSessionForCwd(projectsRoot, paneCwd);
          if (live && live.sessionId !== rec.sessionId) {
            log.info({ principal, from: rec.sessionId, to: live.sessionId, paneCwd }, "mirror restore: pane in worktree, re-homed to live session");
            rec.sessionId = live.sessionId;
            rec.jsonlPath = live.jsonlPath;
            jsonlAbs = live.jsonlPath;
            rec.cwd = expandHome(paneCwd);
            deps.store.set(principal, rec);
          }
        }
      }
    }

    const r = attach({
      sessionId: rec.sessionId,
      jsonlPath: jsonlAbs,
      target: principal,
      tmuxPane: livePane,
      tmuxSession: rec.tmuxSession ?? "",
      cwd: rec.cwd,
      pendingCwd: rec.pendingCwd,
    });
    if (!r.ok) {
      log.warn({ principal, reason: r.reason }, "mirror restore: re-attach failed");
      return undefined;
    }
    log.info({ principal, sessionId: rec.sessionId, livePane: livePane || "(spawn-mode)" }, "mirror restored from store");
    return byTarget.get(principal);
  };


  // We re-attach lazily on demand too (see restoreFromStore in dispatch /
  // hasMirrorTarget), but eager boot-restore makes outbound (tail → push) work
  // even before any inbound arrives — e.g. claude finishes a long-running
  // background task and writes assistant content to the jsonl while idle.
  const persisted = deps.store.all();
  const persistedKeys = Object.keys(persisted);
  if (persistedKeys.length > 0) {
    for (const principal of persistedKeys) {
      void restoreFromStore(principal);
    }
  } else if (cfg.wrc.mirror.sessionId.trim()) {
    // Pinned-sessionId fallback: only honor when the store is empty (otherwise
    // the persisted bindings already cover the right sessions).
    const resolved = resolveSession(cfg, log);
    if (resolved) {
      const r = attach({ sessionId: resolved.sessionId, jsonlPath: resolved.jsonlPath });
      if (!r.ok) log.warn({ reason: r.reason }, "mirror: pinned auto-attach skipped");
    }
  } else {
    log.info("mirror: no persisted attachments and no pinned sessionId — waiting for /new or /mirror/attach");
  }

  // Render full tool details for a finalized turn into one-or-more markdown
  // chunks (split at chunkChars boundaries).
  const renderToolDetails = (tools: ToolEntry[]): string[] => {
    const parts: string[] = [];
    let i = 0;
    for (const t of tools) {
      i += 1;
      const inputJson = t.input === undefined
        ? "(no input)"
        : (() => {
            try { return JSON.stringify(t.input, null, 2); } catch { return "(unrenderable)"; }
          })();
      const result = t.result ?? "(no result captured)";
      parts.push(
        `### ${i}. 🔧 ${t.name}\n\n**input**\n\`\`\`json\n${truncate(inputJson, 4000)}\n\`\`\`\n\n**result**\n\`\`\`\n${truncate(result, 4000)}\n\`\`\``,
      );
    }
    const merged = parts.join("\n\n---\n\n");
    return splitChunks(merged, cfg.wrc.mirror.chunkChars);
  };

  const resolveToolDetail = (turnId: string): { target: string; markdown: string[] } | undefined => {
    evictTurns();
    const r = turnRegistry.get(turnId);
    if (!r) return undefined;
    return { target: r.target, markdown: renderToolDetails(r.tools) };
  };

  // ── /clear → session migration ──────────────────────────────────────
  // After `/clear` claude rotates to a fresh sessionId on the very next user
  // input. Detect the rotation by watching the project dir for a new .jsonl
  // that didn't exist at /clear time and contains a non-empty user line, then
  // re-target this attachment onto it.
  const isClearCommand = (text: string): boolean => {
    const t = text.trim();
    return t === "/clear" || t.startsWith("/clear ") || t.startsWith("/clear\n");
  };

  const listJsonls = (dir: string): Set<string> => {
    try {
      return new Set(readdirSync(dir).filter((n) => n.endsWith(".jsonl")));
    } catch {
      return new Set();
    }
  };

  // Post-/clear identification: claude rotates the session IMMEDIATELY on
  // /clear (not on next user input as the original design assumed) and writes
  // the `/clear` command itself as the first non-meta user line of the brand-
  // new jsonl. Match that signature to (a) confirm the file is a /clear-rotated
  // child, (b) avoid mis-migrating onto an unrelated jsonl that some other
  // claude process happened to create on the same cwd in our window.
  const SLASH_CLEAR_USER_RE = /<command-name>\s*\/clear\s*<\/command-name>/;
  const jsonlIsPostClearChild = (path: string): boolean => {
    try {
      const fd = openSync(path, "r");
      const size = statSync(path).size;
      const cap = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(cap);
      readSync(fd, buf, 0, cap, 0);
      closeSync(fd);
      const text = buf.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as TranscriptLine;
          if (j.type !== "user" || j.isMeta || j.isSidechain) continue;
          const c = j.message?.content;
          // First non-meta user line decides: /clear → match; anything else → reject.
          return typeof c === "string" && SLASH_CLEAR_USER_RE.test(c);
        } catch { /* partial line */ }
      }
    } catch { /* unreadable */ }
    return false;
  };

  // First non-meta user-line uuid of a transcript. A freshly resume-forked
  // child (`claude --resume <sid>` interactive) is seeded with a copy of the
  // parent transcript, so it carries a real user line the instant it appears —
  // this distinguishes it from an empty just-touched jsonl. (We can't reuse the
  // /clear signature: a resume fork's first user line is the actual prompt, not
  // `/clear`.) Returns undefined for empty/garbled files.
  const firstUserUuid = (path: string): string | undefined => {
    try {
      const fd = openSync(path, "r");
      const size = statSync(path).size;
      const cap = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(cap);
      readSync(fd, buf, 0, cap, 0);
      closeSync(fd);
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as TranscriptLine;
          if (j.type === "user" && !j.isMeta && !j.isSidechain && typeof j.uuid === "string") return j.uuid;
        } catch { /* partial line */ }
      }
    } catch { /* unreadable */ }
    return undefined;
  };

  // startOffset semantics differ by caller: /clear passes 0 to replay the
  // freshly-rotated jsonl (only holds the /clear line + new content); resume
  // migration omits it (→ tail from EOF) because the fork file is seeded with
  // the FULL prior transcript and replaying from 0 would re-dump it to WeCom.
  const migrateAttachment = (a: AttachState, newSessionId: string, newJsonlPath: string, startOffset?: number): void => {
    const oldSessionId = a.sessionId;
    const oldJsonlPath = a.jsonlPath;
    a.tail.stop();
    bySessionId.delete(oldSessionId);
    a.sessionId = newSessionId;
    a.jsonlPath = newJsonlPath;
    bySessionId.set(newSessionId, a);
    a.tail = startMirrorTail({
      jsonlPath: newJsonlPath,
      log: log.child({ sub: "tail", sessionId: newSessionId }),
      includeUser: cfg.wrc.mirror.includeUser,
      includeTools: cfg.wrc.mirror.includeTools,
      includeToolResults: cfg.wrc.mirror.includeToolResults,
      toolResultMaxChars: cfg.wrc.mirror.toolResultMaxChars,
      toolUseInlineMaxChars: cfg.wrc.mirror.toolUseInlineMaxChars,
      isOwnInject,
      isOwnAssistantSend,
      onItem: (item) => onItem(a, item),
      detailUrlFor,
      sessionId: newSessionId,
      target: a.target,
      startOffset,
    });
    deps.store.set(a.target, {
      sessionId: newSessionId,
      jsonlPath: newJsonlPath,
      tmuxSession: a.tmuxSession || undefined,
      tmuxPane: a.tmuxPane || undefined,
      cwd: a.runningCwd || undefined,
      pendingCwd: a.pendingCwd || undefined,
    });
    log.info({ target: a.target, oldSessionId, newSessionId, oldJsonlPath, newJsonlPath, startOffset }, "mirror migrated session");
  };

  // Watch the project dir for a new jsonl (not in `baseline`) that satisfies
  // `isChild`, then re-bind the attachment onto it. Used by both /clear
  // (predicate = first user line is /clear; replay from 0) and dead-pane resume
  // (predicate = file has real user content; tail from EOF — the fork is seeded
  // with full history). `startOffset` flows through to migrateAttachment.
  const startMigrationWatcher = (
    a: AttachState,
    baseline: Set<string>,
    isChild: (path: string) => boolean,
    startOffset?: number,
  ): void => {
    if (a.migrationWatcher) a.migrationWatcher.cancel(); // re-armed (e.g. /clear twice, or respawn during a pending watch)
    const projectDir = dirname(a.jsonlPath);
    // baseline is captured by the caller BEFORE inject/respawn runs — claude
    // creates the rotated/forked jsonl while processing it, so a baseline taken
    // here (post-inject) would already include it and migration would never fire.
    const POLL_MS = 500;
    const TIMEOUT_MS = 5 * 60_000; // generous: user may take a while to type
    const t0 = Date.now();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
      if (stopped) return;
      if (Date.now() - t0 > TIMEOUT_MS) {
        log.warn({ target: a.target, sessionId: a.sessionId }, "mirror migration: timeout, giving up");
        a.migrationWatcher = undefined;
        return;
      }
      const current = listJsonls(projectDir);
      const candidates: string[] = [];
      for (const name of current) if (!baseline.has(name)) candidates.push(name);
      // Pick newest-mtime candidate that has user content. Older candidates
      // without content stay in the running until they accrue — never aborts.
      const ranked = candidates
        .map((n) => ({ n, mtime: (() => { try { return statSync(join(projectDir, n)).mtimeMs; } catch { return 0; } })() }))
        .sort((x, y) => y.mtime - x.mtime);
      for (const c of ranked) {
        const p = join(projectDir, c.n);
        if (isChild(p)) {
          stopped = true;
          a.migrationWatcher = undefined;
          const newSid = c.n.replace(/\.jsonl$/, "");
          if (newSid !== a.sessionId) migrateAttachment(a, newSid, p, startOffset);
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };

    a.migrationWatcher = {
      cancel: () => { stopped = true; if (timer) clearTimeout(timer); },
    };
    log.info({ target: a.target, sessionId: a.sessionId, projectDir, baselineCount: baseline.size }, "mirror migration: watcher armed");
    timer = setTimeout(tick, POLL_MS);
  };

  // A user who runs /clear (or restarts claude) directly in the live TUI forks
  // the pane onto a NEW sid in the SAME project dir — invisible to both watchers
  // above (startMigrationWatcher wants a daemon-injected new file; followPaneDrift
  // wants a cross-dir move). The tail then sits on the dead old jsonl and the "…"
  // bubble never updates. After every inject, if the bound jsonl stays silent
  // while a same-dir sibling swallowed our exact injected text, rebind onto it —
  // replaying from our message so the response is mirrored. Fingerprint match on
  // the injected text is what keeps this from mis-migrating across the many
  // sessions that legitimately share one project dir.
  const armSilentForkRebind = (a: AttachState, text: string): void => {
    if (a.migrationWatcher) return;                 // don't race an in-flight watcher
    const stripped = text.replace(/\s+/gu, "");
    if (stripped.length < 8) return;                // too short to fingerprint safely
    const fp = stripped.slice(0, 40);
    const dir = dirname(a.jsonlPath);
    const boundPath = a.jsonlPath;
    let baseSize = 0; try { baseSize = statSync(boundPath).size; } catch { /* fresh */ }
    const POLL_MS = 700;
    const TIMEOUT_MS = 25_000;
    const t0 = Date.now();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = (): void => {
      if (stopped) return;
      if (Date.now() - t0 > TIMEOUT_MS) { a.migrationWatcher = undefined; return; }
      // Bound jsonl grew → our message landed in the right session; nothing to do.
      try { if (statSync(boundPath).size > baseSize) { a.migrationWatcher = undefined; return; } } catch { /* */ }
      let names: string[] = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* */ }
      const boundName = boundPath.slice(dir.length + 1);
      const ranked = names
        .filter((n) => n !== boundName)
        .map((n) => ({ n, m: (() => { try { return statSync(join(dir, n)).mtimeMs; } catch { return 0; } })() }))
        .sort((x, y) => y.m - x.m);
      for (const c of ranked) {
        const off = findInjectOffset(join(dir, c.n), fp);
        if (off === undefined) continue;
        stopped = true;
        a.migrationWatcher = undefined;
        const newSid = c.n.replace(/\.jsonl$/, "");
        if (newSid !== a.sessionId) {
          log.info({ target: a.target, oldSid: a.sessionId, newSid, off }, "mirror: silent same-dir fork, rebinding onto forked session");
          migrateAttachment(a, newSid, join(dir, c.n), off);
        }
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    a.migrationWatcher = { cancel: () => { stopped = true; if (timer) clearTimeout(timer); } };
    timer = setTimeout(tick, POLL_MS);
  };

  // ── Worktree / session drift follow ─────────────────────────────────
  // An inject isn't the only way the live session under a pane changes:
  // entering OR selecting a git worktree makes Claude Code switch the pane to a
  // DIFFERENT sessionId in a sibling project dir (the worktree cwd encodes to
  // its own dir). That's neither a same-sid rename (findJsonlBySid follows those
  // with a continuous offset) nor an inject-triggered rotation (startMigration-
  // Watcher catches those) — the old jsonl just goes quiet and the mirror tails
  // a dead file. Poll each attached pane's real cwd; when it points at a
  // different project dir whose live session has a different sid, migrate onto
  // it. Tail from EOF (undefined startOffset): the worktree session already
  // carries full history we don't want to re-dump to WeCom.
  const projectsRootDir = expandHome(cfg.wrc.mirror.projectsDir);

  let paneDriftTicking = false;
  const followPaneDrift = async (): Promise<void> => {
    if (paneDriftTicking) return; // skip overlapping ticks (tmux call is async)
    paneDriftTicking = true;
    try {
      const attachments = Array.from(byTarget.values()).filter((a) => a.tmuxPane);
      if (attachments.length === 0) return;
      const r = await tmuxRun(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_current_path}"]);
      if (r.code !== 0) return;
      const paneCwd = new Map<string, string>();
      for (const line of r.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab !== -1) paneCwd.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
      }
      for (const a of attachments) {
        if (a.migrationWatcher) continue;                    // inject-driven migration in flight
        if (a.liveStream && !a.liveStream.closed) continue;  // mid typewriter — don't yank the tail
        const cwd = paneCwd.get(a.tmuxPane);
        if (!cwd) continue;                                   // pane gone
        const paneDir = join(projectsRootDir, encodeProjectDir(expandHome(cwd)));
        if (paneDir === dirname(a.jsonlPath)) continue;       // same project dir — no drift
        const live = liveSessionForCwd(projectsRootDir, cwd);
        if (!live || live.sessionId === a.sessionId) continue; // empty dir, or same-sid rename (tail follows it)
        a.runningCwd = expandHome(cwd);                        // migrateAttachment persists this to store
        log.info({ target: a.target, pane: a.tmuxPane, fromDir: dirname(a.jsonlPath), toDir: paneDir, oldSid: a.sessionId, newSid: live.sessionId }, "mirror: pane drifted (worktree), following live session");
        migrateAttachment(a, live.sessionId, live.jsonlPath);
      }
    } catch (e) {
      log.warn({ err: (e as Error).message }, "pane-drift follow tick failed");
    } finally {
      paneDriftTicking = false;
    }
  };
  const paneDriftTimer = setInterval(() => void followPaneDrift(), 3000);

  // ── Cwd lifecycle ───────────────────────────────────────────────────
  // Per-chat project path. Stored on the attachment (live) and persisted to
  // mirror-attachments.json so /pwd survives reload. `pendingCwd` is the
  // user-requested next cwd — applied only on /new (or /clear when it differs
  // from the running cwd). Decoupling means /pwd can show truth even after
  // the AI sets a new path but the user hasn't /new'd yet.
  const expandedDefaultCwd = expandHome(cfg.wrc.cwd);

  const renderProjectInfo = (target: string): string => {
    const a = byTarget.get(target);
    const rec = a ? undefined : deps.store.get(target);
    const running = (a?.runningCwd?.trim()) || rec?.cwd?.trim() || expandedDefaultCwd;
    const pending = (a?.pendingCwd?.trim()) || rec?.pendingCwd?.trim() || "";
    const lines = [`📂 当前项目: \`${running}\``];
    if (pending && pending !== running) {
      lines.push(`下次切换: \`${pending}\` (使用 /new 或 /clear 生效)`);
    }
    lines.push("> 切换其他项目: 在对话中告诉 AI 调用 `cd` MCP 工具");
    return lines.join("\n");
  };

  const pushProjectInfo = (target: string): void => {
    const md = renderProjectInfo(target);
    const a = byTarget.get(target);
    if (a) {
      sendStandalone(a, md);
      return;
    }
    // No attachment (rare — newSession always re-attaches before pushing).
    // Send via plain sendMessage so the user still gets the info.
    const chatId = stripPrincipalPrefix(target);
    void client
      .sendMessage(chatId, { msgtype: "markdown", markdown: { content: md } })
      .catch((e: unknown) => log.warn({ err: (e as Error).message, target }, "pushProjectInfo (no attach) failed"));
  };

  // /new path: kill the old pane (so we don't leak orphan tmux windows) and
  // spawn a fresh claude in pendingCwd ?? runningCwd ?? default. Returns the
  // new sessionId/cwd so callers can render the user-facing reply.
  const newSession = async (
    target: string,
    windowName?: string,
  ): Promise<{ ok: boolean; reason?: string; sessionId?: string; cwd?: string }> => {
    const prev = byTarget.get(target);
    // Honor persisted cwd/pendingCwd when no live attachment yet — otherwise
    // a fresh-chat /new in a daemon-just-rebooted state would lose the user's
    // bound project. Same precedence as getCwd: live > stored, pending > running.
    const rec = !prev ? deps.store.get(target) : undefined;
    const eff =
      (prev?.pendingCwd?.trim()) ||
      (rec?.pendingCwd?.trim()) ||
      (prev?.runningCwd?.trim()) ||
      (rec?.cwd?.trim()) ||
      expandedDefaultCwd;
    if (prev?.tmuxPane) {
      // Best-effort kill; ignore errors (pane may already be dead).
      void tmuxRun(["kill-pane", "-t", prev.tmuxPane]);
    }
    if (prev) detach(prev, "/new respawn");
    const r = await spawnTmuxClaude({
      cfg,
      log: log.child({ sub: "new-session", target }),
      windowName: windowName ?? target,
      cwdOverride: eff,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const att = attach({
      sessionId: r.sessionId!,
      jsonlPath: r.jsonlPath!,
      target,
      tmuxPane: r.tmuxPane,
      tmuxSession: r.tmuxSession,
      cwd: r.cwd,
      // Explicit "" clears any carried-over pending — it has just been applied.
      pendingCwd: "",
    });
    if (!att.ok) return { ok: false, reason: att.reason };
    pushProjectInfo(target);
    return { ok: true, sessionId: r.sessionId, cwd: r.cwd };
  };

  const getCwd = (target: string): { runningCwd: string; pendingCwd: string; defaultCwd: string } => {
    const a = byTarget.get(target);
    if (a) return { runningCwd: a.runningCwd || expandedDefaultCwd, pendingCwd: a.pendingCwd || "", defaultCwd: expandedDefaultCwd };
    const rec = deps.store.get(target);
    if (rec) return { runningCwd: rec.cwd?.trim() || expandedDefaultCwd, pendingCwd: rec.pendingCwd?.trim() || "", defaultCwd: expandedDefaultCwd };
    return { runningCwd: expandedDefaultCwd, pendingCwd: "", defaultCwd: expandedDefaultCwd };
  };

  const setPendingCwd = (
    target: string,
    cwd: string,
  ): { ok: boolean; reason?: string; runningCwd: string; pendingCwd: string } => {
    const trimmed = (cwd ?? "").trim();
    if (!trimmed) return { ok: false, reason: "empty cwd", runningCwd: "", pendingCwd: "" };
    const expanded = expandHome(trimmed);
    if (!expanded.startsWith("/")) return { ok: false, reason: "cwd must be absolute (or start with ~)", runningCwd: "", pendingCwd: "" };
    const a = byTarget.get(target);
    if (a) {
      a.pendingCwd = expanded;
      deps.store.set(target, {
        sessionId: a.sessionId,
        jsonlPath: a.jsonlPath,
        tmuxSession: a.tmuxSession || undefined,
        tmuxPane: a.tmuxPane || undefined,
        cwd: a.runningCwd || undefined,
        pendingCwd: a.pendingCwd || undefined,
      });
      log.info({ target, runningCwd: a.runningCwd, pendingCwd: a.pendingCwd }, "setPendingCwd (live attach)");
      return { ok: true, runningCwd: a.runningCwd, pendingCwd: a.pendingCwd };
    }
    const rec = deps.store.get(target);
    if (rec) {
      deps.store.set(target, { ...rec, pendingCwd: expanded });
      log.info({ target, runningCwd: rec.cwd, pendingCwd: expanded }, "setPendingCwd (persisted only)");
      return { ok: true, runningCwd: rec.cwd?.trim() || expandedDefaultCwd, pendingCwd: expanded };
    }
    return { ok: false, reason: "no mirror binding for target — send a message in the WeCom chat first", runningCwd: "", pendingCwd: "" };
  };

  return {
    attach,
    status: () => {
      const list = Array.from(bySessionId.values()).map((a) => ({
        sessionId: a.sessionId,
        jsonlPath: a.jsonlPath,
        target: a.target,
      }));
      // Keep a single-attach view for back-compat; first entry wins when there's
      // exactly one mirror, callers iterating `mirrors` get the full picture.
      const first = list[0];
      return first
        ? { attached: true, mirrors: list, sessionId: first.sessionId, jsonlPath: first.jsonlPath, target: first.target }
        : { attached: false, mirrors: [] };
    },
    resolveToolDetail,
    hasMirrorTarget: (principal) => {
      if (byTarget.has(principal)) return true;
      // Lazy: a persisted binding counts as "attached" if its transcript is
      // still on disk. The actual re-attach happens on dispatch (async).
      const rec = deps.store.get(principal);
      if (!rec) return false;
      return existsSync(expandHome(rec.jsonlPath));
    },
    targetForSession: (sessionId) => {
      // Live attach is the fast path. Fall back to scanning persisted store:
      // an MCP tool (e.g. `cd`) called from a claude that isn't mirror-attached
      // would otherwise miss here and silently retarget to defaultChat — that
      // bug stranded pendingCwd on the wrong principal. Store keeps each
      // target's sessionId in sync via migrate/attach/setPendingCwd writes.
      const live = bySessionId.get(sessionId)?.target;
      if (live) return live;
      const all = deps.store.all();
      for (const [target, rec] of Object.entries(all)) {
        if (rec.sessionId === sessionId) return target;
      }
      return undefined;
    },
    targetForPane: (tmuxPane) => {
      const pane = (tmuxPane ?? "").trim();
      if (!pane) return undefined;
      for (const a of bySessionId.values()) {
        if (a.tmuxPane === pane) return a.target;
      }
      for (const [target, rec] of Object.entries(deps.store.all())) {
        if ((rec.tmuxPane ?? "") === pane) return target;
      }
      return undefined;
    },
    terminateLiveStream: (sessionId) => {
      const a = bySessionId.get(sessionId);
      if (!a) return;
      if (a.liveStream && !a.liveStream.closed) {
        log.info({ sessionId, turnId: a.liveStream.turnId }, "approval click — terminating liveStream");
        void finalizeStream(a, a.liveStream);
      }
      // Promote AWAITING_APPR → STREAMING on any approval click (allow / deny /
      // allow_window — claude resumes after each, producing tool_result + text
      // that need a stream destination). If frame is stale (>~6min from inbound),
      // the first flushStream will reject, mark s.dead=true, and subsequent items
      // route to standalone via the existing :1206 fall-through. Self-healing.
      if (a.outbound?.kind === "awaiting_appr") {
        const { frame, streamId } = a.outbound;
        a.outbound = undefined;
        const s = openStream(a, frame, streamId);
        a.liveStream = s;
        log.info({ sessionId, turnId: s.turnId }, "outbound: AWAITING_APPR → STREAMING (approved)");
      }
    },
    // 解决"卡片先于思考过程到达 WeCom"的赛跑: hook 触发的 /approve 直接走
    // client.sendMessage 发卡, 而 mirror 这条管道里同一 turn 的 text/tool_use 还
    // 可能卡在三处 — DEFERRED 的 buf、standaloneBuf 的 3s 防抖、liveStream 的
    // 250ms flush。逐一强制 drain, 再 await standalonePending FIFO, 让发卡前 mirror
    // 已经把"为什么发这张卡"推完。
    flushBeforeCard: async (sessionId, expect) => {
      const a = bySessionId.get(sessionId);
      if (!a) return;
      // 1) fs.watch 通常即时, 但本调用是发卡前最后一道屏障 — 主动拽一次 tail,
      //    把刚落盘的 assistant 行(可能含 text + tool_use)立刻喂给 onItem。
      //    若 caller 给了 expect, 进一步轮询 drain 直到对应 tool_use 落盘 —
      //    Claude Code 的 jsonl 写入相对 hook fire 有 tens-to-hundreds ms 的
      //    异步抖动, 单次 drain 经常抓空, 最终用户先看到卡再看到为什么。
      const expectSig = expect ? toolUseSig(expect.toolName, expect.toolInput) : "";
      if (expectSig) {
        const deadline = Date.now() + cfg.wrc.mirror.flushBeforeCardWaitMs;
        let polls = 0;
        while (Date.now() < deadline) {
          try { a.tail.drain(); } catch (e) { log.warn({ sessionId, err: (e as Error).message }, "flushBeforeCard tail drain failed"); }
          if (a.recentToolSigs.has(expectSig)) break;
          polls++;
          await sleepMs(50);
        }
        if (!a.recentToolSigs.has(expectSig)) {
          log.warn({ sessionId, polls, toolName: expect?.toolName }, "flushBeforeCard wait timed out — sending card without sig confirm");
        } else if (polls > 0) {
          log.info({ sessionId, polls, toolName: expect?.toolName }, "flushBeforeCard waited for tool_use to materialize");
        }
      } else {
        try { a.tail.drain(); } catch (e) { log.warn({ sessionId, err: (e as Error).message }, "flushBeforeCard tail drain failed"); }
      }
      // 1.5) 门控 tool_use 始终没在 jsonl 落盘 → CC 把整条 tool-terminated turn 攒着
      //     等工具 resolve 才 flush(而工具正卡在这张卡上), 前言此刻既不在 jsonl 也
      //     不在 hook 的 transcript_tail 里, 只剩活着的 pane 有。抠出来先推, 稍后
      //     jsonl 落盘 tail 出来的同一条由 isOwnAssistantSend 抑制。
      const sigConfirmed = expectSig !== "" && a.recentToolSigs.has(expectSig);
      if (expect && !sigConfirmed) {
        await sendPanePreamble(a);
      }
      // 2) DEFERRED 状态如果还在 buffering(needsApproval 因任何原因没触发就走到这),
      //    这里手动提升 → 立刻把 buf 当 standalone 推出, 进入 AWAITING_APPR。
      if (a.outbound?.kind === "deferred" && a.outbound.buf.length > 0) {
        promoteToStandalone(a);
      }
      // 3) standalone 防抖里 (3s 默认) 还压着的合并文案 — 强制立刻发。
      if (a.standaloneBuf) {
        clearTimeout(a.standaloneBuf.timer);
        flushStandalone(a);
      }
      // 4) liveStream 半成品: 当前 acc 里有内容但还没 flush 出去 — 同步刷一刀,
      //    保留 stream 不 finalize (后续 tool_result 还要继续 append 同一气泡)。
      const ls = a.liveStream;
      if (ls && !ls.closed && !ls.dead && ls.acc && ls.acc !== ls.lastSent) {
        if (ls.flushTimer) {
          clearTimeout(ls.flushTimer);
          ls.flushTimer = undefined;
        }
        await flushStream(ls);
      }
      // 5) 上面的 sendStandalone 都串在 standalonePending FIFO 上, 等它把 WeCom
      //    投递落地, 才算前奏到位 — 这步是关键, 确保返回时卡片可以安心发。
      try {
        await a.standalonePending;
      } catch {
        // 队列内单条失败已在 sendStandalone 里 warn 过, 这里吞掉, 不阻塞发卡。
      }
    },
    injectText: async (target, text) => {
      const a = byTarget.get(target);
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      if (!text.trim()) return { ok: false, reason: "empty text" };
      // Pre-record so the tail's user-line emission is suppressed by the
      // recentInjects dedupe (otherwise the user sees their own demo prompt
      // echoed back as a quoted bubble).
      rememberInject(text);
      const sid = a.sessionId;
      const paneAlive = a.tmuxPane ? await tmuxPaneAlive(a.tmuxPane) : false;
      if (!paneAlive) {
        log.warn({ target, sessionId: sid, oldPane: a.tmuxPane }, "injectText: pane not alive, respawning");
        // Same resume-fork hazard as dispatch: snapshot before spawn, re-bind
        // onto the forked jsonl once it appears (EOF offset — fork is seeded).
        const resumeBaseline = listJsonls(dirname(a.jsonlPath));
        const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "respawn-init", sessionId: sid }), resumeSessionId: sid, windowName: target, cwdOverride: a.runningCwd });
        if (!r.ok || !r.tmuxPane) return { ok: false, reason: `respawn failed: ${r.reason ?? "unknown"}` };
        a.tmuxPane = r.tmuxPane;
        a.tmuxSession = r.tmuxSession ?? a.tmuxSession;
        if (r.cwd) a.runningCwd = r.cwd;
        deps.store.set(target, { sessionId: sid, jsonlPath: a.jsonlPath, tmuxSession: a.tmuxSession, tmuxPane: a.tmuxPane, cwd: a.runningCwd || undefined, pendingCwd: a.pendingCwd || undefined });
        startMigrationWatcher(a, resumeBaseline, (p) => firstUserUuid(p) !== undefined);
      }
      // freshSpawn: true — the pane was just minted by /mirror/spawn, the TUI
      // is still warming up so the verifier in injectViaTmux needs the slack.
      return await inject({
        text, images: [], cfg, log: log.child({ principal: target, sessionId: sid, sub: "init-demo" }),
        sessionId: sid, tmuxTarget: a.tmuxPane, freshSpawn: true,
      });
    },
    interruptPane: async (target) => {
      const a = byTarget.get(target);
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      if (!a.tmuxPane) return { ok: false, reason: "no live tmux pane (spawn-mode attachment)" };
      const alive = await tmuxPaneAlive(a.tmuxPane);
      if (!alive) return { ok: false, reason: "tmux pane no longer alive" };
      const r = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Escape"]);
      if (r.code !== 0) return { ok: false, reason: `send-keys Escape failed: ${r.stdout.slice(-200) || r.code}` };
      log.info({ target, sessionId: a.sessionId, pane: a.tmuxPane }, "mirror /stop — Esc sent to pane");
      return { ok: true };
    },
    submitPane: async (target) => {
      const a = byTarget.get(target);
      if (!a) return { ok: false, reason: "no mirror attached for target" };
      if (!a.tmuxPane) return { ok: false, reason: "no live tmux pane (spawn-mode attachment)" };
      const alive = await tmuxPaneAlive(a.tmuxPane);
      if (!alive) return { ok: false, reason: "tmux pane no longer alive" };
      const r = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Enter"]);
      if (r.code !== 0) return { ok: false, reason: `send-keys Enter failed: ${r.stdout.slice(-200) || r.code}` };
      log.info({ target, sessionId: a.sessionId, pane: a.tmuxPane }, "mirror /n — Enter sent to pane");
      return { ok: true };
    },
    getCwd,
    setPendingCwd,
    newSession,
    shutdown: () => {
      clearInterval(paneDriftTimer);
      for (const a of bySessionId.values()) {
        if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
        a.outbound = undefined;
        if (a.liveStream && !a.liveStream.closed) void finalizeStream(a, a.liveStream);
        a.tail.stop();
      }
      bySessionId.clear();
      byTarget.clear();
    },
    dispatch: async ({ principal, text, images, frame, streamId }) => {
      // Route by inbound principal — the WeCom chat the user just messaged us
      // from is the same string we registered as `target` on attach. After a
      // daemon reload the in-memory map is empty; restore from the persisted
      // store before giving up so the conversation continues in the prior
      // claude session instead of getting "not attached".
      let a = byTarget.get(principal);
      if (!a) a = await restoreFromStore(principal);
      if (!a) {
        try {
          await client.replyStream(
            frame,
            streamId,
            "[weclaude] wecom remote control not attached — run `/wrc` inside the target Claude session",
            true,
          );
        } catch {
          /* ignore */
        }
        return;
      }
      // Finalize prior live stream (if any) so this new turn renders into its
      // own message bubble. Then open a fresh stream tied to the new frame and
      // ack immediately so WeCom doesn't time out while inject queues.
      const armMigration = isClearCommand(text);
      // `/model <arg>` opens the TUI picker preselected on the match — the
      // switch only lands after a confirm Enter. Bare `/model` is excluded:
      // auto-confirming it would just re-pick the current model.
      const isModelSwitch = /^\/model\s+\S/.test(text.trim());
      // 任意 slash 命令 (/context, /cost, /status…): 产物走 skill_output standalone,
      // 详情链接是纯噪声 —— brief 起 turn 时不推链接。
      const isSlash = /^\/[a-z]/i.test(text.trim());
      // Auto-upgrade /clear → /new when the user has queued a project switch:
      // a plain /clear would only rotate sessionId in the same pane, which sits
      // in the OLD cwd. Killing+respawning is the only way to honor the switch.
      const pending = (a.pendingCwd ?? "").trim();
      if (armMigration && pending && pending !== a.runningCwd) {
        if (a.liveStream && !a.liveStream.closed) await finalizeStream(a, a.liveStream);
        log.info({ target: a.target, runningCwd: a.runningCwd, pendingCwd: pending }, "/clear upgraded to /new (cwd switch)");
        const r = await newSession(a.target, a.target);
        if (!r.ok) {
          try { await client.replyStream(frame, streamId, `[mirror] 切换失败: ${r.reason ?? "unknown"}`, true); } catch { /* ignore */ }
        }
        return;
      }
      // Snapshot the project dir BEFORE inject runs. Claude rotates the session
      // synchronously while processing /clear and writes the rotated jsonl
      // immediately — capturing baseline post-inject would already include it,
      // and the watcher would never see a "new" candidate (the bug this fixes).
      const preClearBaseline = armMigration ? listJsonls(dirname(a.jsonlPath)) : undefined;
      // Drop any prior turn's outbound deferral state — a new dispatch always
      // supersedes whatever was buffered/awaiting. The old frame is dead by our
      // own choice (we won't write to it anymore); the user might still later
      // click an old approval card, but terminateLiveStream will find no
      // matching outbound slot and no-op gracefully.
      if (a.outbound) {
        if (a.outbound.kind === "deferred") clearTimeout(a.outbound.timer);
        a.outbound = undefined;
      }
      // Drain any pending standalone debounce so a prior turn's tail tail
      // doesn't get sandwiched into this turn's pre-card flush (Path A) or
      // race against the new stream's first content (Path B).
      if (a.standaloneBuf) { clearTimeout(a.standaloneBuf.timer); flushStandalone(a); }
      // /clear produces no assistant output; opening a stream would leave a
      // stale "…" + quoted-user bubble in WeCom. Skip the stream entirely on
      // success path; only surface a terse "clean" if inject fails.
      if (a.liveStream && !a.liveStream.closed) {
        await finalizeStream(a, a.liveStream);
      }
      // Three paths from here:
      //  • armMigration → s undefined, no defer (existing /clear behavior)
      //  • outboundDeferMs > 0 → DEFERRED slot; stream opens later via promote
      //  • outboundDeferMs === 0 → eager openStream + "…" ack (legacy behavior)
      const brief = cfg.wrc.mirror.brief && !armMigration;
      const eagerOpen = !armMigration && !brief && cfg.wrc.mirror.outboundDeferMs <= 0;
      const s = eagerOpen ? openStream(a, frame, streamId) : undefined;
      if (s) {
        a.liveStream = s;
        try {
          await client.replyStream(frame, streamId, "…", false);
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "stream initial ack failed");
        }
      }
      if (brief) {
        // 关闭上一 turn (若存在), 起新 turn: 立刻推详情 URL 覆盖 loading 气泡。
        // 后续 onItem 走 handleBriefItem, 不再走 stream / defer 路径。
        await startBriefTurn(a, frame, streamId, isSlash, text);
      } else if (!armMigration && !eagerOpen) {
        enterDeferred(a, frame, streamId);
      }
      const sid = a.sessionId;
      await enqueue(sid, async () => {
        if (s && s.closed) return; // (eager path) superseded by a newer dispatch
        // Always reincarnate when no live pane: covers (a) pane closed between
        // turns, (b) daemon reload restored a binding without a live pane, AND
        // (c) /wrc'd from a non-tmux context (no tmuxSession ever stored) —
        // that last case used to permanently lock the chat into spawn-mode.
        // If respawn fails, fall through to spawn-mode inject for THIS turn
        // but DON'T erase tmuxSession from store — next inbound will retry,
        // making the system self-healing instead of one-failure-permanent.
        const paneAlive = a.tmuxPane ? await tmuxPaneAlive(a.tmuxPane) : false;
        let freshSpawn = false;
        if (!paneAlive) {
          log.warn({ target: a.target, sessionId: sid, oldPane: a.tmuxPane, oldSession: a.tmuxSession }, "mirror: no live tmux pane, respawning");
          // Interactive `claude --resume <sid>` does NOT keep appending to the
          // same <sid>.jsonl — it FORKS to a fresh <newSid>.jsonl seeded with a
          // copy of the transcript. Our tail stays bound to the OLD, now-frozen
          // jsonl, so the chat would go silent after respawn. Snapshot the
          // project dir BEFORE spawn so the fork surfaces as a new file the
          // watcher can re-bind onto. Skip when /clear already owns a watcher
          // for this turn (its migration supersedes the fork).
          const resumeBaseline = !armMigration ? listJsonls(dirname(a.jsonlPath)) : undefined;
          // Respawn in the binding's runningCwd (pendingCwd doesn't apply to a
          // mid-turn reincarnation — only /new and /clear-with-pending swap cwd).
          const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "respawn", sessionId: sid }), resumeSessionId: sid, windowName: a.target, cwdOverride: a.runningCwd });
          if (r.ok && r.tmuxPane && r.tmuxSession) {
            a.tmuxPane = r.tmuxPane;
            a.tmuxSession = r.tmuxSession;
            if (r.cwd) a.runningCwd = r.cwd;
            freshSpawn = true;
            deps.store.set(a.target, {
              sessionId: sid,
              jsonlPath: a.jsonlPath,
              tmuxSession: a.tmuxSession,
              tmuxPane: a.tmuxPane,
              cwd: a.runningCwd || undefined,
              pendingCwd: a.pendingCwd || undefined,
            });
            log.info({ target: a.target, sessionId: sid, newPane: a.tmuxPane, newSession: a.tmuxSession }, "mirror: tmux respawned");
            // Re-bind onto the resume fork once it appears (EOF offset: the fork
            // already holds the full prior transcript — replaying from 0 would
            // re-dump it). If --resume happens to keep the same jsonl, no new
            // file appears, the watcher times out harmlessly, and the existing
            // tail keeps working — safe under either behavior.
            if (resumeBaseline) startMigrationWatcher(a, resumeBaseline, (p) => firstUserUuid(p) !== undefined);
          } else {
            // Drop only the stale pane id; keep tmuxSession (if any) so the
            // store still reflects "user wanted tmux" — next turn retries.
            log.error({ reason: r.reason }, "mirror: tmux respawn failed, this turn falls back to spawn-mode");
            a.tmuxPane = "";
          }
        }
        // Remember BEFORE inject (not after success): a fresh-spawn paste can
        // submit late, after our verifier reports failure. The tail still
        // surfaces the user's text, and without a pre-recorded entry the
        // dedupe filter wouldn't suppress it — user's chat msg gets echoed
        // back as a quoted bubble. Recording up front fixes that.
        rememberInject(text);
        const r = await inject({
          text, images, cfg, log: log.child({ principal, sessionId: sid }),
          sessionId: sid, tmuxTarget: a.tmuxPane, freshSpawn,
        });
        if (!r.ok) {
          if (s) {
            s.acc = s.acc ? `${s.acc}\n\n[mirror] ✗ ${r.reason ?? "failed"}` : `[mirror] ✗ ${r.reason ?? "failed"}`;
            await finalizeStream(a, s);
          } else if (armMigration) {
            // /clear path has no live stream — surface failure as a one-shot
            // terse reply ("clean" per project convention).
            try { await client.replyStream(frame, streamId, "clean", true); } catch { /* ignore */ }
          } else {
            // Deferred path: tear down outbound, surface error as standalone.
            // promote* may have already cleared the slot if a tail item raced
            // ahead of inject completion — in that case just send the error.
            if (a.outbound?.kind === "deferred") clearTimeout(a.outbound.timer);
            a.outbound = undefined;
            sendStandalone(a, `[mirror] ✗ ${r.reason ?? "failed"}`);
          }
          return;
        }
        // Inject "succeeded" but the input box never cleared — the target
        // session may be busy / not consuming input (long task, full context).
        // Hint the user once so a silently-dropped message isn't mistaken for a
        // weclaude bug. Skip on the /clear path (armMigration), which has its
        // own "cleared" feedback below.
        //
        // OFF by default: the clear-check has a structural false-positive (the
        // tailFp can match the message's own echo line just above the input box
        // when it falls in the 5-row capture window), so in the common mirror
        // case this fires on essentially every message even though it landed
        // fine — pure noise. A genuinely dropped message still surfaces as the
        // `[mirror] ✗` hard failure above. Opt back in with
        // WECLAUDE_WARN_UNCERTAIN_INJECT=1 if you want the (noisy) heads-up.
        if (r.uncertain && !armMigration && process.env.WECLAUDE_WARN_UNCERTAIN_INJECT === "1") {
          sendStandalone(a, `[mirror] ⚠️ 消息已发送,但目标会话似乎正忙或未响应(输入框未清空),可能未被处理。可稍后重试,或用 \`/sessions\` 切到其它会话。`);
        }
        // Follow a user-initiated same-dir fork (/clear or manual restart in the
        // live TUI) that would otherwise leave the tail — and the "…" bubble —
        // stuck on the dead old jsonl. /clear via WeCom (armMigration) has its
        // own watcher; skip spawn-mode (no shared pane to fork under us).
        if (!armMigration && a.tmuxPane) armSilentForkRebind(a, text);
        // Confirm the /model picker. Early Enter (before the picker renders)
        // would leave it unconfirmed, so settle first; a late Enter is a
        // harmless no-op in the empty input box. On confirm, claude writes
        // "Set model to …" as <local-command-stdout> — the tail mirrors that
        // back to the chat as a ⚙️ bubble, which IS the readback.
        if (isModelSwitch && a.tmuxPane) {
          await sleepMs(1000);
          const e = await tmuxRun(["send-keys", "-t", a.tmuxPane, "Enter"]);
          if (e.code !== 0) log.warn({ pane: a.tmuxPane, reason: e.stdout.slice(-200) || e.code }, "/model confirm Enter failed — user can send /n manually");
        }
        // /clear was just injected — claude rotates sessionId on the next user
        // input. Arm a watcher to migrate the attachment onto the new jsonl,
        // and surface a standalone "cleared" so the user gets explicit
        // feedback (the skip-stream path otherwise leaves WeCom silent).
        if (armMigration) {
          sendStandalone(a, "cleared");
          pushProjectInfo(a.target);
          startMigrationWatcher(a, preClearBaseline!, jsonlIsPostClearChild, 0);
        }
        // Don't await the stream's lifetime — it stays open until next inbound
        // or hard timeout. Releasing the inject queue here lets the next
        // dispatch start its inject promptly while tail content keeps flowing
        // into the (still-open) stream until superseded.
      });
    },
  };
};

const TOOL_DETAIL_PREFIX_EXT = "TOOL_DETAIL|";

// Install a click-handler for the "查看详情" button. On click, look up the
// turn's tool entries and push them as standalone markdown messages to the
// originating chat.
export const installMirrorEventListener = (
  client: WSClient,
  bridge: MirrorBridge,
  log: Logger,
): void => {
  client.on("event.template_card_event", (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
    const ev = frame.body?.event;
    const key = ev?.event_key ?? "";
    if (!key.startsWith(TOOL_DETAIL_PREFIX_EXT)) return;
    const turnId = key.slice(TOOL_DETAIL_PREFIX_EXT.length);
    const detail = bridge.resolveToolDetail(turnId);
    if (!detail) {
      log.warn({ turnId }, "tool detail expired or unknown");
      return;
    }
    const chatId = detail.target.includes(":") ? detail.target.slice(detail.target.indexOf(":") + 1) : detail.target;
    void (async () => {
      for (const md of detail.markdown) {
        try {
          await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: md } });
        } catch (e) {
          log.warn({ err: (e as Error).message, turnId }, "tool detail push failed");
        }
      }
    })();
  });
};
