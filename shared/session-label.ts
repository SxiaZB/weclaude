// Stable per-session visual tag. Hash a sessionId to a fixed animal emoji so
// the same Claude session always shows the same icon — on approval cards and
// in the /sessions list — letting the user tell sibling sessions apart when
// several un-mirrored sessions all fall back to the same WeCom chat.
//
// Stateless + deterministic: same sessionId → same emoji across daemon
// restarts, no persistence needed.

const ANIMALS = [
  "🦊", "🐬", "🦄", "🐙", "🦉", "🐢", "🦋", "🐝",
  "🐳", "🦁", "🐯", "🐰", "🦝", "🐼", "🐨", "🦓",
  "🦔", "🦇", "🐧", "🦜", "🦩", "🐸", "🐺", "🦅",
  "🐡", "🦞", "🦗", "🐌", "🦚", "🐲",
];

// FNV-1a — small, fast, good spread for short ascii ids.
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export const labelFor = (sessionId: string): string => {
  if (!sessionId) return "❔";
  return ANIMALS[hash(sessionId) % ANIMALS.length] ?? "❔";
};

// ── Target-key tagging ──────────────────────────────────────────────────
// Daemon-internal target keys are `user:xxx[#tag]` / `chat:xxx[#tag]`. Every
// user-visible artifact bound to a TAGGED session must carry the same visual
// so a chat hosting parallel sessions stays disambiguated:
//   • markdown bubbles → `emoji \`#tag\`` header line  (withTagHeader)
//   • card titles      → `emoji ` badge                 (tagBadge)
// Untagged (default session) passes through unchanged — single-session users
// see no extra glyphs. Emoji is keyed on the TAG STRING, not the sessionId,
// so it survives `/clear` rotations.

/** `#tag` suffix of a target key, "" when untagged. */
export const tagOfKey = (target: string | undefined): string => {
  if (!target) return "";
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(h + 1) : "";
};

/** Drop the `#tag` suffix — collapses a tagged session key to the chat-scoped
 *  base principal (`user:xxx#foo` → `user:xxx`). Everything shared across a
 *  chat's sessions (cwd, peer discovery, graph runs) keys off this. */
export const baseOfKey = (target: string): string => {
  const h = target.indexOf("#");
  return h >= 0 ? target.slice(0, h) : target;
};

/** Compose a session key from a base principal and a tag ("" → default session). */
export const keyOf = (base: string, tag: string): string => (tag ? `${base}#${tag}` : base);

// 出站气泡的头 (`🦊 #fix …` / 未打 tag 的 `🧙 …`) 是可被「引用」的路由信息:
// 群里要跟某个 `#tag` 会话说话,引用它的气泡比手打 tag 快得多。这里做反向解析。
// 头部 emoji 取自固定表 —— 用户消息以这些 emoji 开头且后接 `#tag` 的概率可忽略。
// 分片序号 (`2/5`) 也属于头,一并吃掉 —— 留在 body 里会污染"引用内容是否已在
// 目标 context 里"的比对。
// 头有两种形态,都要认:裸 `🦊 #fix …`,以及 mirror 的 chat-detail 链接形态
// `[🦊 #fix](https://…) …`(无 tag 时是 `[🧙](url)`)。链接里的 URL 若留在 body
// 里,既污染比对又会被当成用户内容贴进 prompt。
// 分片序号 (`2/5`) 与折叠气泡的 `← View chat details` 提示同理,一并算作头。
const HEAD_EMOJI = [...ANIMALS, "🧙", "❔"];
const EMO = `(?:${HEAD_EMOJI.join("|")})`;
const TAG_PART = `(?:\\s+#([\\p{L}\\p{N}_-]{1,32}))?`;
const HEADER_RE = new RegExp(
  `^(?:\\[${EMO}${TAG_PART}\\]\\([^)]*\\)|${EMO}${TAG_PART})` +
    `(?:\\s+\\d+/\\d+)?(?:\\s*←\\s*View chat details)?(?![\\p{L}\\p{N}_-])\\s*`,
  "u",
);

/** 反解一条出站气泡的 `emoji #tag` 头,返回 tag 与剥头后的正文。
 *  `fromBot=false` 表示这不是 wezard 发的,body 原样返回。 */
export const parseTagHeader = (text: string): { fromBot: boolean; tag: string; body: string } => {
  const t = text.trim();
  const m = HEADER_RE.exec(t);
  return m
    ? { fromBot: true, tag: m[1] ?? m[2] ?? "", body: t.slice(m[0].length) }
    : { fromBot: false, tag: "", body: t };
};

/** Trailing-space emoji badge for card titles; "" for untagged targets. */
export const tagBadge = (target: string | undefined): string => {
  const tag = tagOfKey(target);
  return tag ? `${labelFor(tag)} ` : "🧙 ";
};

/** Prefix markdown content with the `emoji \`#tag\`` header; identity when untagged.
 *  `seq` ("2/5") marks one piece of a split push — it rides in the same header
 *  line so every chunk of a long reply is attributable on its own, and shows
 *  alone when the session is untagged. */
export const withTagHeader = (target: string | undefined, content: string, seq?: string): string => {
  const tag = tagOfKey(target);
  const head = [tag ? `${labelFor(tag)} #${tag}` : "🧙", seq ?? ""].filter(Boolean).join(" ");
  return `${head} ${content}`;
};
