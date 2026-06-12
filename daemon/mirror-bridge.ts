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
import { recordTool, recordToolResult, buildDetailUrl } from "./detail.js";

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
// `/` with `-`. Absolute path `/Users/foo/bar` → `-Users-foo-bar`.
const encodeProjectDir = (absCwd: string): string => absCwd.replace(/\//g, "-");

interface ResolvedSession {
  sessionId: string;
  jsonlPath: string;
}

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
  // auto-pick latest
  const candidates = readdirSync(projectDir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ name: n, mtime: statSync(join(projectDir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    log.error({ projectDir }, "mirror: no .jsonl in project dir");
    return undefined;
  }
  const top = candidates[0]!;
  return {
    sessionId: top.name.replace(/\.jsonl$/, ""),
    jsonlPath: join(projectDir, top.name),
  };
};

// ── Tail logic ────────────────────────────────────────────────────────
interface TailDeps {
  jsonlPath: string;
  log: Logger;
  includeUser: boolean;
  includeTools: boolean;
  includeToolResults: boolean;
  toolResultMaxChars: number;
  isOwnInject: (text: string) => boolean;
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
  uuid?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
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
const META_TAG_RE = /<(command-message|command-name|command-args|local-command-stdout|local-command-caveat|system-reminder)>[\s\S]*?<\/\1>/g;

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

const renderToolResultFull = (block: ContentBlock, max: number): string => {
  const c = block.content;
  if (typeof c === "string") return truncate(c, max);
  if (!Array.isArray(c)) return "";
  return truncate(
    c.map((b) => (typeof b?.text === "string" ? b.text : b?.tool_name ? `→ ${b.tool_name}` : ""))
      .filter(Boolean)
      .join("\n"),
    max,
  );
};

// Tagged render output: items append in-order into the live replyStream. Tool
// items render as plain body lines; the full input/result is carried out
// of band on the item so the caller can register them for click-to-detail.
type RenderItem =
  | { kind: "text"; body: string }
  // CLI-side user line (not a WeCom inject). Marks a turn boundary that did
  // NOT originate from the still-open WeCom liveStream — onItem uses this to
  // finalize the prior bubble so the new conversation gets its own bubble.
  | { kind: "user_text"; body: string }
  | { kind: "tool_use"; body: string; toolUseId: string; name: string; input: unknown }
  | { kind: "tool_result"; body: string; toolUseId: string; full: string };

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
    .replace(/\]/g, "］");

const renderToolInputCompact = (input: unknown): string => {
  // Heuristic: prefer command/file_path/pattern-like keys for the inline summary.
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt;
    if (typeof pick === "string") return oneLineSummary(pick);
  }
  return oneLineSummary(renderToolInput(input));
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
      if (!deps.includeUser) return [];
      const text = cleanUserText(c);
      if (!text) return []; // pure slash-command meta / stdout — drop
      if (deps.isOwnInject(text)) return []; // dedupe WeCom→CLI echo
      const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
      out.push({ kind: "user_text", body: quoted });
    } else if (Array.isArray(c) && deps.includeToolResults) {
      for (const b of c) {
        if (b?.type === "tool_result") {
          const full = renderToolResultFull(b, deps.toolResultMaxChars);
          if (!full) continue;
          const compact = safeForMarkdown(oneLineSummary(full, 40));
          const toolUseId = b.tool_use_id ?? "";
          // Persist the result onto the matching tool record so the detail
          // page renders both input and result. recordTool may not have run
          // yet if tool_use is in a not-yet-flushed assistant line, so the
          // result is also kept on the RenderItem for the in-stream "查看详情"
          // card fallback.
          if (toolUseId) recordToolResult(toolUseId, full);
          const url = deps.detailUrlFor(toolUseId);
          out.push({
            kind: "tool_result",
            toolUseId,
            full,
            body: url ? `[↩ ${compact}](${url})` : `↩ ${compact}`,
          });
        }
      }
    }
    return out;
  }

  if (line.type === "assistant") {
    const blocks = line.message?.content;
    if (!Array.isArray(blocks)) return [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") {
        const t = b.text.trim();
        if (t) out.push({ kind: "text", body: t });
      } else if (b?.type === "tool_use" && deps.includeTools) {
        const name = b.name ?? "tool";
        const compact = safeForMarkdown(renderToolInputCompact(b.input));
        const toolUseId = b.id ?? "";
        // Persist the tool record so the click-to-detail page can render
        // before the matching tool_result arrives — the detail HTML shows
        // a "running…" placeholder until recordToolResult fills it in.
        if (toolUseId) {
          recordTool({
            id: toolUseId,
            toolName: name,
            toolInput: b.input,
            sessionId: deps.sessionId,
            target: deps.target,
          });
        }
        const url = deps.detailUrlFor(toolUseId);
        out.push({
          kind: "tool_use",
          toolUseId,
          name,
          input: b.input,
          body: url ? `[🔧 ${name} ${compact}](${url})` : `🔧 ${name} ${compact}`,
        });
      }
      // thinking blocks intentionally skipped
    }
    return out;
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
}

export const startMirrorTail = (deps: TailDeps): TailHandle => {
  const { jsonlPath, log } = deps;

  // Start at EOF — don't re-emit history. File may not exist yet (auto-spawn
  // path: claude doesn't create the jsonl until it processes the first input);
  // start at 0 in that case so we capture everything once it appears.
  // Caller-provided startOffset wins (used by /clear migration to replay the
  // already-written user line + any early assistant lines from offset 0).
  let offset = deps.startOffset !== undefined
    ? deps.startOffset
    : existsSync(jsonlPath) ? statSync(jsonlPath).size : 0;
  let buffer = "";
  let stopped = false;

  const drain = (): void => {
    if (stopped) return;
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

  // fs.watch fires on append on macOS/Linux. We also poll on a slow timer as
  // belt-and-suspenders for editors/filesystems that drop events.
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(jsonlPath, { persistent: false }, () => drain());
  } catch (e) {
    log.warn({ err: (e as Error).message }, "fs.watch failed; relying on poll");
  }
  const poll = setInterval(drain, 1000);

  log.info({ jsonlPath, startOffset: offset }, "mirror tail started");

  return {
    stop: () => {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
    },
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
const injectViaTmux = async (target: string, text: string, images: string[], log: Logger, freshSpawn: boolean): Promise<{ ok: boolean; reason?: string }> => {
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
  return { ok: true };
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

const inject = (args: InjectArgs): Promise<{ ok: boolean; reason?: string }> => {
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
  /** Returns full tool detail markdown for a turnId, or undefined if expired/unknown. */
  resolveToolDetail: (turnId: string) => { target: string; markdown: string[] } | undefined;
  /** Approval-click hook: finalize any open liveStream for this Claude sessionId
   *  so subsequent tool_use / tool_result items fall through to the debounced
   *  standalone path instead of growing the same bubble. No-op when no live
   *  stream exists. */
  terminateLiveStream: (sessionId: string) => void;
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
  /** 最后一段连续的助手文本：text 块累加，tool_use/tool_result 重置。
   *  finalize 后单独补发一条 markdown,  覆盖 WeCom 会话列表对 stream 消息硬编码的 "…" 预览。 */
  lastText: string;
}

interface AttachState {
  sessionId: string;
  jsonlPath: string;
  target: string;
  /** tmux pane (e.g. `%5`) of the live claude process; auto-discovered from $TMUX_PANE on attach. Empty → fall back to spawn-mode inject. */
  tmuxPane: string;
  /** tmux session name; kept so we can re-derive `tmuxPane` after a daemon reload (pane ids aren't stable across the daemon process). */
  tmuxSession: string;
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
}

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
    // 会话列表对 stream 类型消息硬编码 "…" 预览，仅"发新消息"能覆盖。
    // 仅当本轮真有工具调用时才补发——纯文本回复 stream 已自带可读预览，免得多一条冗余气泡。
    if (!s.dead && s.tools.length > 0 && s.lastText) {
      const chatId = stripPrincipalPrefix(a.target);
      try {
        await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: s.lastText } });
      } catch (e) {
        log.warn({ sessionId: a.sessionId, turnId: s.turnId, err: (e as Error).message }, "preview push failed");
      }
    }
    if (a.liveStream === s) a.liveStream = undefined;
  };

  const openStream = (a: AttachState, frame: WsFrameHeaders, streamId: string): ActiveStream => {
    const s: ActiveStream = {
      turnId: newTurnId(),
      frame, streamId,
      acc: "", lastSent: "",
      capped: false, closed: false, dead: false, cardSent: false,
      tools: [],
      lastText: "",
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
      s.tools.push({ toolUseId: item.toolUseId, name: item.name, input: item.input });
    } else if (item.kind === "tool_result") {
      // Match by toolUseId; if not found, append a standalone result entry.
      const existing = item.toolUseId
        ? s.tools.find((t) => t.toolUseId === item.toolUseId && t.result === undefined)
        : undefined;
      if (existing) existing.result = item.full;
      else s.tools.push({ toolUseId: item.toolUseId, name: "(result)", input: undefined, result: item.full });
    }
  };

  const onItem = (a: AttachState, item: RenderItem): void => {
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
      const sep = s.acc ? "\n\n" : "";
      const next = s.acc + sep + item.body;
      if (next.length > STREAM_SOFT_CAP) {
        s.acc = `${s.acc}${sep}…(超出 stream 容量上限，详情见"查看详情")`;
        s.capped = true;
      } else {
        s.acc = next;
      }
      if (item.kind === "text") {
        s.lastText = (s.lastText ? `${s.lastText}\n\n` : "") + item.body;
      } else if (item.kind === "tool_use" || item.kind === "tool_result") {
        s.lastText = "";
      }
      if (item.kind !== "text") recordToolEntry(s, item);
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

  const attach = ({ sessionId, jsonlPath, target: targetOverride, tmuxPane, tmuxSession }: AttachArgs): AttachResult => {
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
    if (prevByTarget) detach(prevByTarget, "target reassigned");
    // Build the attachment first so the tail's onItem closure can capture it.
    const a: AttachState = {
      sessionId,
      jsonlPath,
      target,
      tmuxPane: (tmuxPane ?? "").trim(),
      tmuxSession: (tmuxSession ?? "").trim(),
      tail: { stop: () => undefined }, // placeholder; replaced below
      standalonePending: Promise.resolve(),
    };
    a.tail = startMirrorTail({
      jsonlPath,
      log: log.child({ sub: "tail", sessionId }),
      includeUser: cfg.wrc.mirror.includeUser,
      includeTools: cfg.wrc.mirror.includeTools,
      includeToolResults: cfg.wrc.mirror.includeToolResults,
      toolResultMaxChars: cfg.wrc.mirror.toolResultMaxChars,
      isOwnInject,
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
    });
    log.info({ sessionId, jsonlPath, target, tmuxSession: a.tmuxSession, mirrors: bySessionId.size }, "mirror attached");
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
    const jsonlAbs = expandHome(rec.jsonlPath);
    if (!existsSync(jsonlAbs)) {
      log.warn({ principal, jsonlPath: rec.jsonlPath }, "mirror restore: jsonl missing, dropping entry");
      deps.store.drop(principal);
      return undefined;
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
    const r = attach({
      sessionId: rec.sessionId,
      jsonlPath: jsonlAbs,
      target: principal,
      tmuxPane: livePane,
      tmuxSession: rec.tmuxSession ?? "",
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

  const migrateAttachment = (a: AttachState, newSessionId: string, newJsonlPath: string): void => {
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
      isOwnInject,
      onItem: (item) => onItem(a, item),
      detailUrlFor,
      sessionId: newSessionId,
      target: a.target,
      // Replay from the very start: by the time we migrate, the new jsonl
      // already holds the rotated user line and possibly early assistant
      // lines. Without this the tail would start at EOF and silently drop
      // them, leaving the WeCom stream stuck at "…".
      startOffset: 0,
    });
    deps.store.set(a.target, {
      sessionId: newSessionId,
      jsonlPath: newJsonlPath,
      tmuxSession: a.tmuxSession || undefined,
      tmuxPane: a.tmuxPane || undefined,
    });
    log.info({ target: a.target, oldSessionId, newSessionId, oldJsonlPath, newJsonlPath }, "mirror migrated post-/clear");
  };

  const startMigrationWatcher = (a: AttachState, baseline: Set<string>): void => {
    if (a.migrationWatcher) a.migrationWatcher.cancel(); // /clear sent twice in a row
    const projectDir = dirname(a.jsonlPath);
    // baseline is captured by the caller BEFORE inject runs — claude creates
    // the rotated jsonl synchronously while processing /clear, so a baseline
    // taken here (post-inject) would already include it and migration would
    // never fire.
    const POLL_MS = 500;
    const TIMEOUT_MS = 5 * 60_000; // generous: user may take a while to type
    const t0 = Date.now();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const tick = (): void => {
      if (stopped) return;
      if (Date.now() - t0 > TIMEOUT_MS) {
        log.warn({ target: a.target, sessionId: a.sessionId }, "mirror /clear migration: timeout, giving up");
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
        if (jsonlIsPostClearChild(p)) {
          stopped = true;
          a.migrationWatcher = undefined;
          const newSid = c.n.replace(/\.jsonl$/, "");
          if (newSid !== a.sessionId) migrateAttachment(a, newSid, p);
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };

    a.migrationWatcher = {
      cancel: () => { stopped = true; if (timer) clearTimeout(timer); },
    };
    log.info({ target: a.target, sessionId: a.sessionId, projectDir, baselineCount: baseline.size }, "mirror /clear migration: watcher armed");
    timer = setTimeout(tick, POLL_MS);
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
    targetForSession: (sessionId) => bySessionId.get(sessionId)?.target,
    terminateLiveStream: (sessionId) => {
      const a = bySessionId.get(sessionId);
      if (a?.liveStream && !a.liveStream.closed) {
        log.info({ sessionId, turnId: a.liveStream.turnId }, "approval click — terminating liveStream");
        void finalizeStream(a, a.liveStream);
      }
    },
    shutdown: () => {
      for (const a of bySessionId.values()) {
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
      // Snapshot the project dir BEFORE inject runs. Claude rotates the session
      // synchronously while processing /clear and writes the rotated jsonl
      // immediately — capturing baseline post-inject would already include it,
      // and the watcher would never see a "new" candidate (the bug this fixes).
      const preClearBaseline = armMigration ? listJsonls(dirname(a.jsonlPath)) : undefined;
      // /clear produces no assistant output; opening a stream would leave a
      // stale "…" + quoted-user bubble in WeCom. Skip the stream entirely on
      // success path; only surface a terse "clean" if inject fails.
      if (a.liveStream && !a.liveStream.closed) {
        await finalizeStream(a, a.liveStream);
      }
      const s = armMigration ? undefined : openStream(a, frame, streamId);
      if (s) {
        a.liveStream = s;
        try {
          await client.replyStream(frame, streamId, "…", false);
        } catch (e) {
          log.warn({ sessionId: a.sessionId, err: (e as Error).message }, "stream initial ack failed");
        }
      }
      const sid = a.sessionId;
      await enqueue(sid, async () => {
        if (s && s.closed) return; // superseded by a newer dispatch
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
          const r = await spawnTmuxClaude({ cfg, log: log.child({ sub: "respawn", sessionId: sid }), resumeSessionId: sid, windowName: a.target });
          if (r.ok && r.tmuxPane && r.tmuxSession) {
            a.tmuxPane = r.tmuxPane;
            a.tmuxSession = r.tmuxSession;
            freshSpawn = true;
            deps.store.set(a.target, {
              sessionId: sid,
              jsonlPath: a.jsonlPath,
              tmuxSession: a.tmuxSession,
              tmuxPane: a.tmuxPane,
            });
            log.info({ target: a.target, sessionId: sid, newPane: a.tmuxPane, newSession: a.tmuxSession }, "mirror: tmux respawned");
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
          } else {
            // /clear path has no live stream — surface failure as a one-shot
            // terse reply ("clean" per project convention).
            try { await client.replyStream(frame, streamId, "clean", true); } catch { /* ignore */ }
          }
          return;
        }
        // /clear was just injected — claude rotates sessionId on the next user
        // input. Arm a watcher to migrate the attachment onto the new jsonl,
        // and surface a standalone "cleared" so the user gets explicit
        // feedback (the skip-stream path otherwise leaves WeCom silent).
        if (armMigration) {
          sendStandalone(a, "cleared");
          startMigrationWatcher(a, preClearBaseline!);
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
