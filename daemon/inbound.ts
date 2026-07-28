// Inbound text router. Hands the message off to either the headless CC bridge
// (mode=headless) or the mirror bridge (mode=mirror).
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, BaseMessage, QuoteContent } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import type { Bridge } from "./cc-bridge.js";
import type { MirrorBridge } from "./mirror-bridge.js";
import type { PeerInfo } from "./peers.js";
import { expandHome, sanitizeId } from "../shared/paths.js";
import type { CliBackendName } from "../shared/cli-backends.js";
import { tryConsumeClaim, persistClaim, ackClaim, shouldAutoClaim, ackAutoClaim } from "./claim.js";
import { getLastResponse } from "./last-response.js";
import { scanClaudeSessions, type SessionInfo } from "./session-scan.js";
import { computeUsage, renderUsageReport } from "./usage.js";
import { computeAuditReport } from "./audit.js";
import { syncProjectConfig, renderSyncReport } from "./cfg-sync.js";
import { captureQuota, renderQuotaReport } from "./quota.js";
import { tagOfKey, withTagHeader } from "./session-label.js";
import {
  parseSubscribe,
  parseUnsubscribe,
  parseBroadcast,
  parseDailySchedule,
  parseCancelSchedule,
  isListSchedules,
  isListSubs,
  subscribe,
  unsubscribe,
  addSchedule,
  removeSchedulesByTopic,
  publish,
  renderSubs,
  renderSchedules,
} from "./topics.js";

// Chat-binding key: stable id for "this conversation thread". Used as
// session-map key, mirror target, defaultChat. NOT used for auth.
const chatPrincipal = (msg: BaseMessage): string =>
  msg.chattype === "group" && msg.chatid ? `chat:${msg.chatid}` : `user:${msg.from.userid}`;

// A single chat can host multiple concurrent Claude sessions via `#tag`. The
// session key = base principal + optional `#tag` suffix. Untagged = default
// session (backward-compatible). Tags: [\p{L}\p{N}_-]{1,32}, must be
// space-delimited or edge-of-string so genuine URLs / paths like
// "#L45-foo/bar" survive. Only the FIRST tag in a message is honored — that
// tag is stripped from the forwarded text; any additional #foo tokens flow
// through verbatim (may be actual references in the user's prompt).
const TAG_RE = /(^|\s)#([\p{L}\p{N}_-]{1,32})(?=\s|$)/u;
const parseTag = (text: string): { tag: string; cleaned: string } => {
  const m = TAG_RE.exec(text);
  if (!m) return { tag: "", cleaned: text };
  const tag = m[2] ?? "";
  const before = text.slice(0, m.index);
  const sep = m[1] ?? "";
  const after = text.slice(m.index + m[0].length);
  const cleaned = (before + sep + after).replace(/[ \t]+/g, " ").trim();
  return { tag, cleaned };
};

const sessionKey = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);
const tagOf = tagOfKey;

// Auth principals: any-of test against allowFrom. Tiered — allowing a user
// grants them access in any chat; allowing a group grants every member of
// that group access. DMs collapse to just the sender.
const authPrincipals = (msg: BaseMessage): string[] => {
  const user = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) return [`chat:${msg.chatid}`, user];
  return [user];
};

// "会话id" = chat-binding (session/mirror key); "权限id" = either the group
// OR the sender — allowFrom passes if any one of them is whitelisted.
// Also surfaces per-id 授权状态 + 对应 `weclaude mirror` CLI 参数 (vid:/chatid:),
// so users can copy-paste straight into a terminal to bind a Claude session.
const renderIds = (msg: BaseMessage, cfg: Config): string => {
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  const mark = (id: string): string => (allowed.has(id) ? "✅ 已授权" : "❌ 未授权");
  const sender = `user:${msg.from.userid}`;
  if (msg.chattype === "group" && msg.chatid) {
    const chat = `chat:${msg.chatid}`;
    return [
      `群: \`${chat}\` ${mark(chat)}`,
      `发送者: \`${sender}\` ${mark(sender)}`,
      `(allowFrom 任一通过即可)`,
      `在已有claude会话中绑定本群聊: \`/weclaude:wrc chat:${msg.chatid}\``,
    ].join("\n");
  }
  return [
    `会话id: \`${sender}\` ${mark(sender)}`,
    `在已有claude会话中绑定本单聊: \`/weclaude:wrc user:${msg.from.userid}\``,
  ].join("\n");
};

const isIdCommand = (text: string): boolean => text.trim() === "/id";
const isPwdCommand = (text: string): boolean => text.trim() === "/pwd";
const isCostCommand = (text: string): boolean => text.trim() === "/cost";
// `/audit` or `/audit some-tag`. With a tag, `/audit` re-routes to the
// newest-by-mtime mirror whose target carries `#<tag>` (see resolveAuditMirror);
// without a tag, falls back to the caller's own mirror binding.
const parseAuditCommand = (text: string): { tag: string } | undefined => {
  const m = /^\/audit(?:\s+(.+))?$/u.exec(text.trim());
  return m ? { tag: (m[1] ?? "").trim().replace(/^#/, "") } : undefined;
};

// Resolve /audit target: with an explicit tag → newest-by-mtime mirror whose
// target carries `#<tag>` (regardless of caller). Without a tag → caller's own
// binding. Returns undefined when nothing matches.
interface MirrorRef { sessionId: string; jsonlPath: string; target: string; }
const resolveAuditMirror = (
  mirrors: MirrorRef[],
  tag: string,
  who: string,
  chatWho: string,
): MirrorRef | undefined => {
  if (tag) {
    const wanted = tag.replace(/^#/, "");
    const matches = mirrors.filter((m) => (m.target.split("#")[1] ?? "") === wanted);
    if (matches.length <= 1) return matches[0];
    return matches
      .map((m) => {
        let mt = 0;
        try { mt = statSync(expandHome(m.jsonlPath)).mtimeMs; } catch { /* ignore */ }
        return { m, mt };
      })
      .sort((a, b) => b.mt - a.mt)[0]?.m;
  }
  return mirrors.find((m) => m.target === who || m.target === chatWho);
};
// `/new` optionally names which CLI to launch (`/new codebuddy`). Bare `/new`
// keeps whatever CLI the chat's current session runs — see newSession's inherit
// rule — so naming one is only needed to *switch* backends.
const NEW_RE = /^\/new(?:\s+(claude-internal|claude|codebuddy))?$/i;
const isNewCommand = (text: string): boolean => NEW_RE.test(text.trim());
const cliOfNewCommand = (text: string): CliBackendName | undefined =>
  NEW_RE.exec(text.trim())?.[1]?.toLowerCase() as CliBackendName | undefined;
// `/cfgsync` (alias `/sync`) — reconcile the project's per-CLI config trees.
// Bare form is a dry run; `apply` is the only form that writes.
const CFGSYNC_RE = /^\/(?:cfgsync|sync)(?:\s+(apply))?$/i;
const parseCfgSyncCommand = (text: string): { apply: boolean } | undefined => {
  const m = CFGSYNC_RE.exec(text.trim());
  return m ? { apply: Boolean(m[1]) } : undefined;
};
const isUsageCommand = (text: string): boolean => text.trim() === "/usage";
const isStopCommand = (text: string): boolean => text.trim() === "/stop";
const isEnterCommand = (text: string): boolean => text.trim() === "/n";
const isHelpCommand = (text: string): boolean => /^\/(?:help|\?|h)$/i.test(text.trim());
const isSkillBCommand = (text: string): boolean => text.trim() === "/skill-b";

// Static command reference. Grouped: session control, usage/info, topic
// broadcast (natural-language, zh+en). Anything not matching a command is a
// prompt forwarded to the bound Claude session.
const renderHelp = (): string =>
  [
    "*weclaude 命令*",
    "",
    "▎会话",
    "`/new` 新开会话并绑定本聊天 (沿用当前会话的 CLI)",
    "`/clear` 清空当前会话上下文 (有待切项目时自动升级为 /new)",
    "`/sessions` 列出 live 会话 · `/sessions <emoji|id>` 切换",
    "`/stop` 打断当前生成 (Esc)",
    "`/n` 向 CLI 输入回车 (Enter)",
    "",
    "▎切换 CLI 后端",
    "`/new codebuddy` 用指定 CLI 新开 (claude / claude-internal / codebuddy)",
    "不写则沿用本会话当前的 CLI;新开 `#tag` 会话则继承本聊天的 CLI。",
    "切换后 `/clear`、`/stop`、`--resume` 自愈都仍绑在该 CLI 上。",
    "",
    "▎多会话路由",
    "同一聊天可同时运行多个 claude:消息中任意位置带 `#tag`(如 `#docs 帮我改 README`)",
    "即路由到该标签会话;不带 tag = 默认会话。tagged 会话的回复以 `emoji #tag` 前缀标注。",
    "`/clear #tag`、`/pwd #tag`、`/stop #tag` 等命令同理按 tag 路由。",
    "`#tag` 与 CLI 名可同时写:`/new codebuddy #docs` = 用 codebuddy 开 docs 会话。",
    "",
    "▎多会话协作",
    "`/peers` 列出本聊天的所有会话及忙闲状态",
    "同一聊天内的会话互为 peer,可以互相观察和驱动。直接说人话即可:",
    "「看下 `#fix` 的进展,推动它直到结束」— AI 会读它的终端、注入指令、等它跑完。",
    "「让 `#fix` 和 `#review` 互相迭代到 review 说 LGTM」— AI 会建一个 loop graph,",
    "把多个带 tag 的会话(可各用不同 CLI / 模型)串成流水线并循环驱动。",
    "",
    "▎信息 (免授权)",
    "`/id` 查看会话/权限 id",
    "`/pwd` 当前项目路径",
    "`/usage` 真实订阅额度 %",
    "`/cost` token/成本估算",
    "`/audit` 本会话 token/成本明细 (含 subagent) · `/audit <tag>` 指定标签会话",
    "`/cfgsync` 预演跨 CLI 项目配置同步 · `/cfgsync apply` 执行 (需授权)",
    "`/help` 本帮助",
    "`/skill-b` 广播接口用法 (贴给 Claude)",
    "",
    "▎广播订阅",
    "`订阅 <topic>` · `退订 <topic>`",
    "`广播 <topic> <内容>`",
    "`每天 08:30 广播 <topic> <内容>`",
    "`取消广播 <topic>`",
    "`订阅列表` · `广播列表`",
    "",
    "▎引用 (quote)",
    "引用消息 + 新文字：被引用内容作为上下文前缀附在你的话前。",
    "纯引用不加字：把被引用内容当正文重发 —— 微信会去重相同文本，",
    "这是重新触发同一条命令 (如 `/usage`) 的唯一方式。",
    "",
    "其余文本直接转发给已绑定的 Claude 会话。",
  ].join("\n");

// /skill-b — 回执一段 prompt,告诉 Claude 如何调用本 daemon 的 /publish 广播接口。
// 用围栏代码块包裹便于用户在 WeCom 长按 copy 后贴给上游 Claude。
const renderSkillBroadcast = (): string => [
  "把下面这段贴给 Claude,它就知道怎么广播:",
  "```",
  "本机 daemon 在 127.0.0.1:17890 暴露 POST /publish,用来向已订阅某 topic 的会话广播消息。",
  "",
  "调用示例:",
  "curl -sS -X POST http://127.0.0.1:17890/publish \\",
  "  -H 'Content-Type: application/json' \\",
  "  -d '{\"topic\":\"daily-report\",\"markdown\":\"# 标题\\n正文...\"}'",
  "",
  "请求体:",
  "- topic (必填):订阅表里的 key",
  "- markdown 或 text (二选一):消息内容,markdown 语法",
  "",
  "返回: { ok, topic, sent, failed, subs }。ws_disconnected=true 表示 daemon 与 WeCom WS 断开。",
  "",
  "长消息用 --data-binary @file.json,避免 shell 转义踩坑。",
  "```",
].join("\n");

// /session(s) [arg] — list live Claude sessions, or switch the mirror to one.
// Bare "/sessions" (or "/session") lists; an arg (animal emoji, sessionId, or
// sessionId prefix) switches. Tolerates an optional trailing "s" and any spacing.
const parseSessionsCommand = (text: string): { arg: string } | undefined => {
  const m = /^\/sessions?(?:\s+(.+))?$/u.exec(text.trim());
  if (!m) return undefined;
  return { arg: (m[1] ?? "").trim() };
};

// Render the scanned session list into a WeCom-friendly markdown block. The
// session currently mirrored to this chat's target (if any) is flagged.
const renderSessionsList = (sessions: SessionInfo[], currentSid: string): string => {
  if (sessions.length === 0) return "[weclaude] 未发现正在运行的 Claude 会话";
  // Only annotate the CLI when the list actually spans more than one — with a
  // single backend the tag is pure noise on every row.
  const mixed = new Set(sessions.map((s) => s.cli)).size > 1;
  const lines = sessions.map((s) => {
    const here = s.sessionId === currentSid ? " ⬅️ 当前" : "";
    const dir = s.cwd.replace(/^.*\//, "") || s.cwd || "?";
    const cli = mixed ? ` _(${s.cli})_` : "";
    return `${s.label || "▫️"} \`${s.sessionId.slice(0, 8)}\` ${dir}${cli}${here}`;
  });
  return [
    "[weclaude] 正在运行的会话：",
    ...lines,
    "> 切换：`/sessions <emoji 或 id>`，如 `/sessions 🐼`",
  ].join("\n");
};

// /peers — roster of the sessions living in THIS chat (default + every `#tag`).
// Distinct from /sessions, which sweeps the whole host: peers are the ones an
// agent here can actually collaborate with (shared chat = shared address space).
const isPeersCommand = (text: string): boolean => /^\/(?:peers?|agents?)$/iu.test(text.trim());

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const dirOf = (p: PeerInfo): string => p.cwd.replace(/^.*\//, "") || p.cwd;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// A field with the same value on every row (project dir, CLI backend) is noise
// repeated N times — hoist those into the header and annotate rows only where
// they actually differ. Rows are blank-line separated so a wrapped summary can't
// visually merge into the next peer.
const renderPeers = (peers: PeerInfo[]): string => {
  if (peers.length === 0) return "[weclaude] 本聊天还没有会话。发消息或 `/new` 建一个。";
  const dirs = uniq(peers.map(dirOf));
  const clis = uniq(peers.map((p) => p.cli));
  const shared = [dirs.length === 1 ? dirs[0] : "", clis.length === 1 ? clis[0] : ""].filter(Boolean);
  const rows = peers.flatMap((p) => {
    const name = p.tag ? `#${p.tag}` : "默认";
    const state = !p.paneAlive ? "⚫️ 已关闭" : p.busy ? "🔴 忙" : "🟢 空闲";
    const varies = [dirs.length > 1 ? dirOf(p) : "", clis.length > 1 ? p.cli : ""].filter(Boolean);
    const me = p.self ? " ⬅️ 本会话" : "";
    return [
      `**${p.label} ${name}** ${state}${varies.length ? ` · ${varies.join(" · ")}` : ""}${me}`,
      `　${clip(p.summary, 64)}`,
      "",
    ];
  });
  return [
    `[weclaude] 本聊天的会话 · ${peers.length} 个${shared.length ? ` · ${shared.join(" · ")}` : ""}`,
    "",
    ...rows,
    "> 协作：直接说「看下 #fix 的进展并推动它」，AI 会读它的终端并注入指令",
  ].join("\n");
};

// Match a switch arg against a scanned session: animal emoji label, full
// sessionId, or a ≥6 char sessionId prefix. Returns the session or undefined.
const matchSession = (sessions: SessionInfo[], arg: string): SessionInfo | undefined =>
  sessions.find((s) => s.label === arg) ??
  sessions.find((s) => s.sessionId === arg) ??
  (arg.length >= 6 ? sessions.find((s) => s.sessionId.startsWith(arg)) : undefined);

// Strip any "@<botname>" mention (leading, mid-text, or trailing) so it doesn't
// leak into claude's prompt. WeCom may place the mention anywhere depending on
// where the user typed it.
// Safety: if the text contains more than one "@", it's ambiguous (user likely
// also @'d a file path like "@src/foo.ts"), so leave it untouched rather than
// risk eating the path.
const stripMentions = (text: string): string => {
  const atCount = (text.match(/@/gu) ?? []).length;
  if (atCount !== 1) return text;
  return text.replace(/\s*@\S+\s*/u, " ").replace(/\s+/gu, " ").trim();
};

// DMs can't @ a bot — any "@" the user types is content (e.g. "@src/foo.ts"),
// so we only strip mentions in group chats.
const isGroup = (msg: BaseMessage): boolean => msg.chattype === "group" && !!msg.chatid;
// Always kill "@weclaude" (bot's own name) regardless of chat type / @-count:
// a DM user typing "@weclaude start …" would otherwise leak the mention into
// Claude's prompt and get semantically parsed (e.g. spawning wrc). Word-tail
// guard `(?![A-Za-z0-9_])` keeps identifiers like "@weclaude-foo" intact
// while allowing CJK / punctuation right after.
const stripBotName = (text: string): string =>
  text.replace(/[ \t]*@weclaude(?![A-Za-z0-9_])[ \t]*/giu, " ").replace(/[ \t]{2,}/g, " ").trim();
const maybeStripMentions = (msg: BaseMessage, text: string): string => {
  const cleaned = stripBotName(text);
  return isGroup(msg) ? stripMentions(cleaned) : cleaned;
};

// Render the user's "引用" (quoted message) into a markdown blockquote so the
// claude prompt carries the upstream context. WeCom delivers `quote` as a
// sibling field on the message body — currently we surface text/voice (already
// transcribed) inline; image/mixed-image/file are rendered as a placeholder
// (download would mean an extra round-trip + clipboard paste, which is too
// heavy for a quote — user can always send the file directly if needed).
const quoteToText = (q: QuoteContent): string => {
  if (q.msgtype === "text") return q.text?.content ?? "";
  if (q.msgtype === "voice") return q.voice?.content ?? "";
  if (q.msgtype === "mixed") {
    return (q.mixed?.msg_item ?? [])
      .map((it) => (it.msgtype === "text" ? it.text?.content ?? "" : "[图片]"))
      .filter(Boolean)
      .join(" ");
  }
  if (q.msgtype === "image") return "[图片]";
  if (q.msgtype === "file") return "[文件]";
  return "";
};
const renderQuotePrefix = (q: QuoteContent | undefined): string => {
  if (!q) return "";
  const body = quoteToText(q).trim();
  if (!body) return "";
  // Quote each line so multi-line引用渲染整洁; trailing blank line separates
  // from the user's actual message.
  const quoted = body.split("\n").map((l) => `> ${l}`).join("\n");
  return `> [引用]\n${quoted}\n\n`;
};
// Normalize for self-reply quote dedup: WeCom mangles formatting on its quote
// bubble in unpredictable ways — strips backticks, swaps `-` bullets for `·`,
// re-wraps whitespace, sometimes loses inline markdown. Reduce both sides to
// just letters + digits (Unicode + CJK) and compare on that — robust against
// any punctuation/whitespace/markup churn while keeping content fidelity.
const canonForCompare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, "");

const isLastResponseQuote = (target: string, quoted: string): boolean => {
  const last = getLastResponse(target);
  if (!last || !quoted) return false;
  const a = canonForCompare(last);
  const b = canonForCompare(quoted);
  if (a.length < 4 || b.length < 6) return false; // too short — false-positive risk
  // Substring match (prefix subsumes; suffix covers tool-heavy turns where the
  // tracked `s.acc` interleaves tool entries before the final text). Both
  // sides are canon'd to letters+digits only, so formatting/punctuation drift
  // can't break the match.
  return a.includes(b);
};

const withQuote = (msg: BaseMessage, text: string): string => {
  if (!msg.quote) return text;
  // Drop the quote when the user is replying to weclaude's most recent message
  // in this chat — claude already has that turn in its context, surfacing it
  // again is redundant noise. Older self-quotes still flow through (the user
  // is genuinely pointing back to something earlier).
  const quoted = quoteToText(msg.quote).trim();
  if (isLastResponseQuote(chatPrincipal(msg), quoted)) return text;
  const prefix = renderQuotePrefix(msg.quote);
  return prefix ? `${prefix}${text}` : text;
};

// Effective body for a text message.
// - Normal: strip the bot @mention, attach any quote as a markdown context prefix.
// - Pure-quote re-trigger: when the user adds NO new text and just quotes a
//   message, promote the quoted message to the body (strip its @mention so
//   "@weclaude /usage" → "/usage" hits the command path). WeCom silently dedups
//   identical text sends, so re-quoting the same command is the only way to
//   re-fire it — this makes that work. Self-quotes of weclaude's own last reply
//   are excluded (would echo weclaude's text back as a command).
// Also extracts the leading `#tag` (if any) from the effective body; the
// returned `text` has the tag stripped so command matchers see clean
// "/new"/"/pwd"/etc.
const resolveTextBody = (msg: TextMessage): { text: string; tag: string; promoted: boolean } => {
  const body = maybeStripMentions(msg, msg.text?.content ?? "");
  if (body.trim()) {
    const { tag, cleaned } = parseTag(body);
    return { text: withQuote(msg, cleaned), tag, promoted: false };
  }
  const quoted = msg.quote ? quoteToText(msg.quote).trim() : "";
  if (quoted && !isLastResponseQuote(chatPrincipal(msg), quoted)) {
    const { tag, cleaned } = parseTag(maybeStripMentions(msg, quoted).trim());
    return { text: cleaned, tag, promoted: true };
  }
  return { text: withQuote(msg, body), tag: "", promoted: false };
};

const isAllowed = (cfg: Config, principals: string[]): boolean => {
  if (cfg.wrc.allowFrom.length === 0) return false;
  // Tolerate invisible chars sneaking into hand-edited config (paste artifacts).
  const allowed = new Set(cfg.wrc.allowFrom.map((e) => sanitizeId(e)));
  return principals.some((p) => allowed.has(p));
};

// Mirror mode grants implicit talkback: any chat that's currently a mirror
// target can post back without being in `allowFrom`. The act of /wrc'ing into
// that chat is the authorization signal.
const isMirrorTarget = (bridge: Bridge | MirrorBridge, who: string): boolean =>
  "hasMirrorTarget" in bridge && bridge.hasMirrorTarget(who);

// Sniff extension from magic bytes; falls back to .bin. WeCom doesn't always
// give us a filename for images, and we want claude's Read tool to recognize
// the file (it dispatches on extension).
const sniffExt = (buf: Buffer): string => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) return ".gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (buf.length >= 12 && buf.subarray(4, 12).toString("ascii") === "ftypheic") return ".heic";
  return ".bin";
};

interface DownloadDeps {
  client: WSClient;
  log: Logger;
  inboxDir: string;
}

const downloadToInbox = async (
  deps: DownloadDeps,
  url: string,
  aesKey: string | undefined,
  msgid: string,
  index: number,
): Promise<string | undefined> => {
  try {
    const { buffer, filename } = await deps.client.downloadFile(url, aesKey);
    const ext = filename ? `.${filename.split(".").pop()!}` : sniffExt(buffer);
    const safeName = `${msgid.replace(/[^A-Za-z0-9_-]/g, "_")}_${index}${ext}`;
    mkdirSync(deps.inboxDir, { recursive: true });
    const abs = join(deps.inboxDir, safeName);
    writeFileSync(abs, buffer);
    deps.log.info({ url: url.slice(0, 80), bytes: buffer.length, abs }, "media saved");
    return abs;
  } catch (e) {
    deps.log.error({ err: (e as Error).message }, "media download failed");
    return undefined;
  }
};

export const installInboundRouter = (
  client: WSClient,
  cfg: Config,
  log: Logger,
  bridge: Bridge | MirrorBridge,
  sourcePath: string,
): void => {
  const inboxDir = expandHome(cfg.wrc.mirror.inboxDir);

  // Render /pwd output. Mirror mode reads the live attachment + persisted
  // store via bridge.getCwd; headless mode has no per-chat cwd, so it just
  // shows cfg.wrc.cwd as the global default.
  const renderPwd = (who: string): string => {
    if ("getCwd" in bridge) {
      const { runningCwd, pendingCwd, defaultCwd } = bridge.getCwd(who);
      const lines = [`[weclaude] 📂 当前项目: \`${runningCwd}\``];
      if (pendingCwd && pendingCwd !== runningCwd) {
        lines.push(`下次切换: \`${pendingCwd}\` (使用 /new 或 /clear 生效)`);
      }
      if (runningCwd !== defaultCwd) lines.push(`(默认: \`${defaultCwd}\`)`);
      lines.push("> 切换其他项目: 让 AI 调用 `cd` MCP 工具");
      return lines.join("\n");
    }
    return `[weclaude] 📂 当前项目: \`${expandHome(cfg.wrc.cwd)}\` (headless mode, 全局默认)`;
  };

  // Mirror-only auto-spawn / /new helper. Routes through bridge.newSession
  // which kills the old pane, spawns fresh in pendingCwd ?? runningCwd ??
  // default, attaches, and pushes "📂 当前项目" info to the chat. Returns
  // the user-facing one-line ack. When `who` carries a `#tag` suffix, use
  // the raw tag as the tmux window name so the pane shows readably in the
  // status bar (e.g. `#docs` → window `docs`, not the principal slug).
  const autoSpawnAndAttach = async (who: string, cli?: CliBackendName): Promise<string> => {
    if (!("newSession" in bridge)) return "[weclaude] /new only available in mirror mode";
    const tag = tagOf(who);
    const r = await bridge.newSession(who, tag || who, cli);
    if (!r.ok) return `[weclaude] /new failed: ${r.reason ?? "unknown"}`;
    return `✅ 新会话已建立 \`${r.sessionId}\``;
  };

  // 事件订阅 / 广播命令。授权后调用,不再走 bridge dispatch。返回 true 表示已处理。
  const topicLog = log.child({ mod: "topics" });
  const handleTopicCommand = async (
    frame: WsFrame<BaseMessage>,
    msg: BaseMessage,
    who: string,
    text: string,
  ): Promise<boolean> => {
    // 订阅/广播回执同样按会话 tag 标注 —— `#docs /subs` 的回执必须落在 `#docs`
    // 的视觉通道里, 否则同一聊天并行会话时分不清是谁的回执。
    const reply = async (t: string): Promise<void> => {
      try { await client.replyStream(frame, msg.msgid, withTagHeader(who, t), true); } catch { /* ignore */ }
    };
    const sub = parseSubscribe(text);
    if (sub) {
      const r = subscribe(cfg, sourcePath, sub.topic, who);
      await reply(r.added
        ? `✅ 已订阅 \`${sub.topic}\` (会话: \`${who}\`)`
        : `ℹ️ 已在 \`${sub.topic}\` 订阅列表中`);
      return true;
    }
    const unsub = parseUnsubscribe(text);
    if (unsub) {
      const r = unsubscribe(cfg, sourcePath, unsub.topic, who);
      await reply(r.removed ? `✅ 已退订 \`${unsub.topic}\`` : `ℹ️ 未订阅 \`${unsub.topic}\``);
      return true;
    }
    const daily = parseDailySchedule(text);
    if (daily) {
      addSchedule(cfg, sourcePath, {
        topic: daily.topic,
        hour: daily.hour,
        minute: daily.minute,
        content: daily.content,
        createdBy: who,
        createdAt: Date.now(),
      });
      const hh = String(daily.hour).padStart(2, "0");
      const mm = String(daily.minute).padStart(2, "0");
      const subCount = (cfg.topics.subs[daily.topic] ?? []).length;
      await reply(`✅ 定时已添加: 每天 ${hh}:${mm} 广播 \`${daily.topic}\` (当前 ${subCount} 订阅者)`);
      return true;
    }
    const bcast = parseBroadcast(text);
    if (bcast) {
      const r = await publish(client, cfg, topicLog, bcast.topic, bcast.content);
      await reply(`📣 已广播到 \`${r.topic}\`: 送达 ${r.sent} / ${r.subs.length}${r.failed ? `,失败 ${r.failed}` : ""}`);
      return true;
    }
    const cancel = parseCancelSchedule(text);
    if (cancel) {
      const n = removeSchedulesByTopic(cfg, sourcePath, cancel.topic);
      await reply(n > 0 ? `✅ 已删除 \`${cancel.topic}\` 的 ${n} 条定时` : `ℹ️ \`${cancel.topic}\` 无定时任务`);
      return true;
    }
    if (isListSubs(text)) {
      await reply(renderSubs(cfg, who));
      return true;
    }
    if (isListSchedules(text)) {
      await reply(renderSchedules(cfg));
      return true;
    }
    return false;
  };

  // Prefix user-visible daemon replies with `<emoji> #tag` when the routed
  // session is tagged, so a chat hosting multiple concurrent tagged sessions
  // stays visually disambiguated. Untagged (default) session passes through
  // unchanged. Emoji is derived from the tag string (not sessionId) so it
  // stays stable across /clear cycles.
  const withTagPrefix = withTagHeader;
  const replyText = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string): Promise<void> => {
    try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, text), true); } catch { /* ignore */ }
  };

  // Common gating: claim bootstrap + allowFrom check. Returns true if the
  // caller should stop (claim consumed or message rejected).
  const gate = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, text: string, who: string): Promise<{ stop: boolean }> => {
    const auths = authPrincipals(msg);
    // Bootstrap / allowFrom operations are chat-scoped, not session-scoped;
    // strip any `#tag` suffix so a first-time user typing `hello #foo`
    // still promotes them as `user:xxx` (not `user:xxx#foo`).
    const basePrincipal = chatPrincipal(msg);
    // /id — bypass allowFrom so users can discover their ids before configuring.
    if (isIdCommand(text)) {
      await replyText(frame, msg, who, renderIds(msg, cfg));
      return { stop: true };
    }
    // /help — static command reference. Bypasses allowFrom like /id so a new
    // user can discover the command surface before being authorized.
    if (isHelpCommand(text)) {
      await replyText(frame, msg, who, renderHelp());
      return { stop: true };
    }
    // /pwd — bypass allowFrom too. Read-only project-path lookup.
    if (isPwdCommand(text)) {
      await replyText(frame, msg, who, renderPwd(who));
      return { stop: true };
    }
    // /skill-b — 静态 prompt 回执,教 Claude 调用 /publish 广播接口。纯文本,bypass allowFrom。
    if (isSkillBCommand(text)) {
      await replyText(frame, msg, who, renderSkillBroadcast());
      return { stop: true };
    }
    // /cost — token / cost ESTIMATE pulled from ~/.claude(-internal)?/projects
    // jsonl transcripts (ccusage-style). Read-only, no session state, so it
    // bypasses allowFrom like /id and /pwd. Real subscription %: use /usage.
    if (isCostCommand(text)) {
      let body: string;
      try {
        body = renderUsageReport(computeUsage());
      } catch (e) {
        body = `[weclaude] /cost failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /audit [tag] — per-session cost/token breakdown (main + subagents). We
    // handle it here instead of paste-forwarding to the Claude REPL because
    // (a) tmux paste + Enter is racy for slash commands and often fails to
    // submit, and (b) even when it does, the LLM turn adds 30-40s over what
    // is really just a jsonl read. Read-only, no state — bypasses allowFrom.
    //
    // Tag routing: `/audit <tag>` resolves to the SINGLE most-recently-active
    // mirror whose target carries `#<tag>` (by jsonl mtime), NOT the caller's
    // current session and NOT a sum over all sessions sharing the tag.
    // Untagged form falls back to the caller's own mirror binding.
    const audit = parseAuditCommand(text);
    if (audit) {
      const mirror = "status" in bridge
        ? resolveAuditMirror(bridge.status().mirrors, audit.tag, who, chatPrincipal(msg))
        : undefined;
      let body: string;
      if (!mirror) {
        body = audit.tag
          ? `[weclaude] /audit: 未找到 tag \`${audit.tag}\` 对应的 Claude 会话。`
          : `[weclaude] /audit: 未找到 ${who} 绑定的 Claude 会话。先 \`/new\` 或用 \`weclaude mirror\` 绑定后再试。`;
      } else {
        try {
          body = computeAuditReport({
            sessionId: mirror.sessionId,
            jsonlPath: mirror.jsonlPath,
            tag: audit.tag || undefined,
          });
        } catch (e) {
          body = `[weclaude] /audit failed: ${(e as Error).message}`;
        }
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    if (tryConsumeClaim(text, basePrincipal)) {
      log.info({ who: basePrincipal }, "claim consumed — bootstrapping defaultChat + allowFrom");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "persistClaim failed");
      }
      await ackClaim(client, basePrincipal, log);
      await replyText(frame, msg, who, "✅ done");
      return { stop: true };
    }
    // Auto-claim: empty allowFrom + DM ⇒ first sender becomes super admin.
    // Falls through so the same message is also dispatched as a real prompt —
    // user types "hi" and gets both the promotion ack and the assistant reply.
    const isDm = !(msg.chattype === "group" && msg.chatid);
    if (shouldAutoClaim(cfg, isDm)) {
      log.info({ who: basePrincipal }, "auto-claim — empty allowFrom, first DM sender promoted");
      try { persistClaim(cfg, sourcePath, basePrincipal); } catch (e) {
        log.error({ err: (e as Error).message }, "auto-claim persistClaim failed");
      }
      await ackAutoClaim(client, basePrincipal, log);
      // fall through to dispatch
    }
    if (!isAllowed(cfg, auths) && !isMirrorTarget(bridge, who)) {
      log.warn({ from: who, auths }, "drop: not in allowFrom");
      try {
        await client.replyStream(
          frame,
          msg.msgid,
          `未授权\n${renderIds(msg, cfg)}\n请将上述任一权限id加入 config 的 wrc.allowFrom 数组`,
          true,
        );
      } catch { /* ignore */ }
      return { stop: true };
    }
    // Authorized `/usage` — real subscription rate-limit %, scraped from Claude
    // Code's own `/usage` TUI (/cost can only estimate cost/tokens; the true
    // limit % is server-side). Drives a throwaway isolated pane (~10s) → interim
    // ack, then replace with the result.
    if (isUsageCommand(text)) {
      log.info({ who }, "/usage panel: start");
      try { await client.replyStream(frame, msg.msgid, withTagPrefix(who, "⏳ 正在拉起 /usage 面板查询真实额度…"), false); } catch (e) { log.warn({ err: (e as Error).message }, "/usage: interim ack failed"); }
      let body: string;
      try {
        const report = await captureQuota(cfg, log);
        // Wrap in a fenced code block so WeCom renders the aligned panel in a
        // monospace bubble (columns stay lined up).
        body = "```\n" + renderQuotaReport(report) + "\n```";
        log.info({ who, limits: report.limits.length }, "/usage panel: done");
      } catch (e) {
        body = `[weclaude] /usage failed: ${(e as Error).message}`;
        log.error({ who, err: (e as Error).message }, "/usage panel: failed");
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // Authorized `/new` — spawn a tmux+claude pair and attach it to this chat.
    // Runs BEFORE the mirror-not-attached short-circuit so it works as the
    // very first message from a fresh user. When routed with a `#tag`, the
    // tag becomes both the mirror-store key and the tmux window name.
    if (isNewCommand(text)) {
      const reply = await autoSpawnAndAttach(who, cliOfNewCommand(text));
      await replyText(frame, msg, who, reply);
      return { stop: true };
    }
    // 事件订阅 / 广播 / 定时。授权后即可使用,任意 principal 可对本会话订阅/退订,
    // 广播权限同 allowFrom(已过上面的 auth 门)。命令不进入 bridge dispatch,
    // 用轻量 replyStream 回执。
    const topicHandled = await handleTopicCommand(frame, msg, who, text);
    if (topicHandled) return { stop: true };
    // Authorized `/stop` — Esc the live pane to interrupt whatever Claude is
    // currently doing. Mirror-mode only; bails cleanly when no attachment.
    if (isStopCommand(text)) {
      if (!("interruptPane" in bridge)) {
        await replyText(frame, msg, who, "[weclaude] /stop only available in mirror mode");
      } else {
        const r = await bridge.interruptPane(who);
        await replyText(frame, msg, who, r.ok ? "✅ Esc sent" : `[weclaude] /stop failed: ${r.reason ?? "unknown"}`);
      }
      return { stop: true };
    }
    // Authorized `/n` — send a bare Enter to the live pane. Confirms a prompt /
    // dismisses a "press enter to continue", or submits whatever's already in
    // the input box. Mirror-mode only; bails cleanly when no attachment.
    if (isEnterCommand(text)) {
      if (!("submitPane" in bridge)) {
        await replyText(frame, msg, who, "[weclaude] /n only available in mirror mode");
      } else {
        const r = await bridge.submitPane(who);
        await replyText(frame, msg, who, r.ok ? "✅ Enter sent" : `[weclaude] /n failed: ${r.reason ?? "unknown"}`);
      }
      return { stop: true };
    }
    // /cfgsync [apply] — 3-way merge of the bound project's per-CLI config
    // trees (CLAUDE.md ⇄ CODEBUDDY.md, .claude/{skills,commands,agents} ⇄
    // .codebuddy/...). Writes files, so it sits AFTER the allowFrom gate.
    const cs = parseCfgSyncCommand(text);
    if (cs) {
      const cwd = "getCwd" in bridge ? bridge.getCwd(who).runningCwd : expandHome(cfg.wrc.cwd);
      let body: string;
      try {
        body = renderSyncReport(await syncProjectConfig(cwd, cs.apply));
      } catch (e) {
        body = `[weclaude] /cfgsync failed: ${(e as Error).message}`;
      }
      log.info({ who, cwd, apply: cs.apply }, "/cfgsync");
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /peers — this chat's own session roster (default + `#tag` siblings), with
    // live busy state. Read-only, mirror-mode only.
    if (isPeersCommand(text)) {
      if (!("peers" in bridge)) {
        await replyText(frame, msg, who, "[weclaude] /peers only available in mirror mode");
        return { stop: true };
      }
      let body: string;
      try {
        body = renderPeers(await bridge.peers(who));
      } catch (e) {
        body = `[weclaude] /peers failed: ${(e as Error).message}`;
      }
      await replyText(frame, msg, who, body);
      return { stop: true };
    }
    // /sessions [arg] — list live Claude sessions, or switch the mirror to one.
    // Bare lists; with an arg (emoji / sessionId / ≥6-char prefix) it re-points
    // THIS chat's mirror at the matched session. Reuses the same scan+attach
    // path as the /sessions/switch route so IM and MCP behave identically.
    const sc = parseSessionsCommand(text);
    if (sc) {
      if (!("attach" in bridge)) {
        await replyText(frame, msg, who, "[weclaude] /sessions only available in mirror mode");
        return { stop: true };
      }
      let sessions: SessionInfo[] = [];
      try {
        sessions = await scanClaudeSessions();
      } catch (e) {
        log.error({ err: (e as Error).message }, "/sessions scan failed");
      }
      // Resolve which session is currently mirrored to THIS chat.
      const currentSid = bridge.status().mirrors.find((mm) => mm.target === who)?.sessionId ?? "";
      if (!sc.arg) {
        await replyText(frame, msg, who, renderSessionsList(sessions, currentSid));
        return { stop: true };
      }
      const hit = matchSession(sessions, sc.arg);
      if (!hit) {
        const avail = sessions.map((s) => `${s.label || "▫️"} ${s.sessionId.slice(0, 8)}`).join("、") || "无";
        await replyText(frame, msg, who, `[weclaude] 未找到会话 \`${sc.arg}\`。可用：${avail}`);
        return { stop: true };
      }
      if (hit.sessionId === currentSid) {
        await replyText(frame, msg, who, `[weclaude] 已经在该会话 ${hit.label} \`${hit.sessionId.slice(0, 8)}\``);
        return { stop: true };
      }
      const att = bridge.attach({ sessionId: hit.sessionId, jsonlPath: hit.jsonlPath, target: who, tmuxPane: hit.tmuxPane, tmuxSession: hit.tmuxSession, cwd: hit.cwd });
      await replyText(
        frame, msg, who,
        att.ok
          ? `✅ 已切到 ${hit.label} \`${hit.sessionId.slice(0, 8)}\` (${hit.cwd})`
          : `[weclaude] 切换失败: ${att.reason ?? "unknown"}`,
      );
      return { stop: true };
    }
    // Mirror mode but no Claude session attached for this chat yet. Since the
    // sender is already in allowFrom, we treat that authorization as license
    // to auto-spawn: this inbound becomes both the binding signal and the
    // first prompt — attach, then fall through to dispatch.
    if ("hasMirrorTarget" in bridge && !bridge.hasMirrorTarget(who)) {
      const reply = await autoSpawnAndAttach(who);
      if (!reply.startsWith("✅")) {
        await replyText(frame, msg, who, reply);
        return { stop: true };
      }
      // attached — fall through to dispatch
    }
    return { stop: false };
  };

  const send = async (frame: WsFrame<BaseMessage>, msg: BaseMessage, who: string, text: string, images: string[] = []): Promise<void> => {
    try {
      await bridge.dispatch({ principal: who, text, images, frame, streamId: msg.msgid });
    } catch (e) {
      log.error({ err: (e as Error).message }, "bridge dispatch failed");
      try { await client.replyStream(frame, msg.msgid, withTagHeader(who, `[weclaude] error: ${(e as Error).message}`), true); } catch { /* ignore */ }
    }
  };

  client.on("message.text", async (frame: WsFrame<TextMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    const { text, tag, promoted } = resolveTextBody(msg);
    const who = sessionKey(chatPrincipal(msg), tag);
    log.info({ msgid: msg.msgid, len: text.length, tag, hasQuote: !!msg.quote, promoted }, "rx text");
    const { stop } = await gate(frame, msg, text, who);
    if (stop) return;
    await send(frame, msg, who, text);
  });

  client.on("message.image", async (frame: WsFrame<ImageMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, hasQuote: !!msg.quote }, "rx image");
    // Images carry no text — always route to the chat's default session.
    const who = chatPrincipal(msg);
    const { stop } = await gate(frame, msg, "", who);
    if (stop) return;
    const path = await downloadToInbox({ client, log, inboxDir }, msg.image.url, msg.image.aeskey, msg.msgid, 0);
    if (!path) {
      try { await client.replyStream(frame, msg.msgid, "[weclaude] 图片下载失败", true); } catch { /* ignore */ }
      return;
    }
    // Pass the path through the bridge's `images` channel — mirror mode pumps
    // each via macOS clipboard + Ctrl+V into the live TTY (matches Claude
    // Code's documented image paste flow → image content block, no Read tool
    // turn). Spawn-mode falls back to `@<path>` automatically.
    await send(frame, msg, who, withQuote(msg, ""), [path]);
  });

  client.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
    const msg = frame.body;
    if (!msg) return;
    log.info({ msgid: msg.msgid, items: msg.mixed?.msg_item?.length, hasQuote: !!msg.quote }, "rx mixed");
    // Concatenate all text items to sniff a leading `#tag`, then strip it from
    // the effective body before forwarding to Claude.
    const rawText = (msg.mixed?.msg_item ?? [])
      .filter((it) => it.msgtype === "text")
      .map((it) => (it as { text?: { content?: string } }).text?.content ?? "")
      .join("\n");
    const { tag } = parseTag(maybeStripMentions(msg, rawText));
    const who = sessionKey(chatPrincipal(msg), tag);
    const { stop } = await gate(frame, msg, "", who);
    if (stop) return;
    const texts: string[] = [];
    const images: string[] = [];
    let imgIdx = 0;
    for (const item of msg.mixed?.msg_item ?? []) {
      if (item.msgtype === "text" && item.text?.content) {
        const t = maybeStripMentions(msg, item.text.content);
        if (t) texts.push(t);
      } else if (item.msgtype === "image" && item.image?.url) {
        const path = await downloadToInbox(
          { client, log, inboxDir },
          item.image.url,
          item.image.aeskey,
          msg.msgid,
          imgIdx++,
        );
        if (path) images.push(path);
      }
    }
    if (texts.length === 0 && images.length === 0 && !msg.quote) return;
    // Strip the routing `#tag` from the concatenated body before forwarding —
    // it was consumed by parseTag above; leaving it in would leak into Claude.
    const joined = texts.join("\n");
    const bodyForClaude = tag ? parseTag(joined).cleaned : joined;
    await send(frame, msg, who, withQuote(msg, bodyForClaude), images);
  });

  // template_card_event is handled in approval module; no listener here.
};
