// Approval card build + click event handling. Plugs the PreToolUse hook flow.
import type {
  WSClient,
  WsFrame,
  TemplateCard,
  EventMessage,
  EventMessageWith,
  TemplateCardEventData,
} from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { createPending, getPending, getResolvedSnapshot, resolvePending, resolvePendingsBySession, failPending, type Decision } from "./pending.js";
import {
  cacheGet,
  cachePut,
  cacheKey,
  isAutoWindowActive,
  autoWindowRemainingMs,
  setAutoWindow,
  clearAutoWindow,
  getWindowMeta,
} from "./session-cache.js";
import { redact } from "./redact.js";
import { recordApproval, recordApprovalDecision, buildDetailUrl } from "./detail.js";
import type { Handler } from "./http.js";
import { json, readBody } from "./http.js";

// ── Routing helpers ────────────────────────────────────────────────────
const targetChatId = (principal: string): string => {
  // "user:abc" → "abc" (DM chatid == userid for aibot)
  // "chat:wc..." → "wc..."
  // raw fallthrough
  const i = principal.indexOf(":");
  return i >= 0 ? principal.slice(i + 1) : principal;
};

const pickApprover = (cfg: Config): string | undefined => {
  if (cfg.approval.approvers.length > 0) return cfg.approval.approvers[0];
  if (cfg.defaultChat) return cfg.defaultChat;
  return undefined;
};

// ── Card construction ──────────────────────────────────────────────────
interface CardArgs {
  reqId: string;
  toolName: string;
  toolInput: unknown;
  toolInputStr: string;
  cwd: string;
  sessionShort: string;
  transcriptTail: string;
  windowMinutes: number;
  detailUrl?: string;  // 空则不渲染 jump_list
}

const TRUNC = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const HOME_RE = /^\/Users\/[^/]+/;
const fmtPath = (p: string): string => p.replace(HOME_RE, "~");
const relToCwd = (p: string, cwd: string): string => {
  if (!p) return "";
  if (cwd && p === cwd) return ".";
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return fmtPath(p);
};

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ⏎ ");
const takeFirstLines = (s: string, lines: number, maxChars: number): string =>
  TRUNC(s.split("\n").slice(0, lines).join("\n"), maxChars);

const EDIT_SNIPPET_LEN = 160;
const WRITE_PREVIEW_LINES = 4;
const WRITE_PREVIEW_CHARS = 200;

const SOURCE_BASE = {
  icon_url: "https://wwcdn.weixin.qq.com/node/wework/images/3d-claude-ai-logo.bce0ddae70.jpg",
  desc: "Claude Code",
  desc_color: 0,
};

// Source bar sits ABOVE main_title — only place we can hoist transcript context.
const buildSource = (tail: string): TemplateCard["source"] => {
  const desc = tail ? TRUNC(tail, 80) : SOURCE_BASE.desc;
  return { ...SOURCE_BASE, desc } as TemplateCard["source"];
};

interface Rendered {
  body: string;  // wrapped in quote_area as the parameters block
  desc?: string; // 渲染到 sub_title_text — 跟 quote_area 里的命令/参数体分离
}

const prefixLines = (s: string, prefix: string): string =>
  s.split("\n").map((l) => `${prefix} ${l}`).join("\n");

// Flat key:val summary for unknown tools — never dump raw JSON.
const UNKNOWN_VAL_LEN = 140;
const UNKNOWN_TOTAL_LEN = 480;
const summarizeUnknown = (i: Record<string, unknown>): string => {
  const lines: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(i)) {
    if (total >= UNKNOWN_TOTAL_LEN) { lines.push("…"); break; }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    const line = `${k}: ${TRUNC(oneLine(s), UNKNOWN_VAL_LEN)}`;
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n");
};

const QUOTE_MAX = 600;
const join = (...parts: string[]): string => parts.filter(Boolean).join("\n");

// Render tool input as a multi-line "code-block / quote" body.
const renderInput = (
  toolName: string,
  toolInput: unknown,
  _toolInputStr: string,
  cwd: string,
): Rendered => {
  const i = toolInput as Record<string, unknown> | null;
  if (!i || typeof i !== "object") return { body: "" };

  if (toolName === "Bash") {
    const cmd = typeof i.command === "string" ? i.command : "";
    const desc = typeof i.description === "string" ? i.description : "";
    return { body: TRUNC(cmd, QUOTE_MAX), desc: desc || undefined };
  }
  if (toolName === "Read") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    return { body: TRUNC(fp, QUOTE_MAX) };
  }
  if (toolName === "Write") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const content = typeof i.content === "string" ? i.content : "";
    const lc = content ? content.split("\n").length : 0;
    const preview = takeFirstLines(content, WRITE_PREVIEW_LINES, WRITE_PREVIEW_CHARS);
    return {
      body: TRUNC(join(fp, `✏️ 写入 ${lc} 行`, preview ? prefixLines(preview, "+") : ""), QUOTE_MAX),
    };
  }
  if (toolName === "Edit") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const oldS = TRUNC(typeof i.old_string === "string" ? i.old_string : "", EDIT_SNIPPET_LEN);
    const newS = TRUNC(typeof i.new_string === "string" ? i.new_string : "", EDIT_SNIPPET_LEN);
    return {
      body: TRUNC(join(fp, prefixLines(oldS, "−"), prefixLines(newS, "+")), QUOTE_MAX),
    };
  }
  if (toolName === "MultiEdit") {
    const fp = typeof i.file_path === "string" ? relToCwd(i.file_path, cwd) : "";
    const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
    const first = edits[0] ?? {};
    const oldS = TRUNC(typeof first.old_string === "string" ? first.old_string : "", EDIT_SNIPPET_LEN);
    const newS = TRUNC(typeof first.new_string === "string" ? first.new_string : "", EDIT_SNIPPET_LEN);
    return {
      body: TRUNC(
        join(`${fp}  (✏️ ${edits.length} 处)`, prefixLines(oldS, "−"), prefixLines(newS, "+")),
        QUOTE_MAX,
      ),
    };
  }
  if (toolName === "Agent" || toolName === "Task") {
    const desc = typeof i.description === "string" ? i.description : "";
    const sa = typeof i.subagent_type === "string" ? i.subagent_type : "";
    const prompt = typeof i.prompt === "string" ? i.prompt : "";
    const head = [sa, desc].filter(Boolean).join(": ");
    return { body: TRUNC(prompt, QUOTE_MAX), desc: head || undefined };
  }
  return { body: summarizeUnknown(i) };
};

const quoteArea = (text: string): TemplateCard["quote_area"] =>
  ({ type: 0, quote_text: text } as TemplateCard["quote_area"]);

const MAIN_DESC_MAX = 30;
const mainTitle = (title: string, desc?: string): TemplateCard["main_title"] =>
  desc ? { title, desc: TRUNC(desc, MAIN_DESC_MAX) } : { title };

const dirName = (cwd: string): string => cwd.replace(/^.*\//, "") || cwd;

const detailJumpList = (url?: string): TemplateCard["jump_list"] | undefined =>
  url ? [{ type: 1, title: "🔍 详情", url }] : undefined;

const buildCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`🔐 授权 · ${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [
      { text: "❌", style: 4, key: encodeKey(a.reqId, "deny") },
      { text: "10min", style: 3, key: encodeKey(a.reqId, "allow_window") },
      { text: "✅", style: 4, key: encodeKey(a.reqId, "allow") },
    ],
  };
};

const verbOf = (d: Decision, windowMinutes: number): string => {
  switch (d) {
    case "deny": return "已拒绝";
    case "allow_window": return `${windowMinutes}min会话内全过`;
    case "allow_session": return "本会话通过";
    default: return "已通过";
  }
};

const emojiOf = (d: Decision): string => (d === "deny" ? "❌" : "✅");

// allow_window 仍可点击以取消自动窗口；其余决策为最终态 noop。
const resolvedButton = (
  d: Decision,
  windowMinutes: number,
  reqId: string,
  sessionId: string,
): { text: string; style: number; key: string } => {
  if (d === "allow_window") {
    return {
      text: `${verbOf(d, windowMinutes)}(点击取消)`,
      style: 4,
      key: encodeCancelKey(sessionId),
    };
  }
  return {
    text: `${emojiOf(d)} ${verbOf(d, windowMinutes)}`,
    style: 4,
    key: `noop:${reqId}`,
  };
};

const buildResolvedCard = (
  a: CardArgs & { decision: Decision; by: string; sessionId: string },
): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [resolvedButton(a.decision, a.windowMinutes, a.reqId, a.sessionId)],
  };
};

const buildCancelledCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [
      { text: "已取消自动通过", style: 4, key: `noop:cancelled:${a.reqId}` },
    ],
  };
};

// 已 resolved 的卡再次被点击 — 仅作视觉反馈, 不改变任何状态。
const buildAlreadyResolvedCard = (a: CardArgs): TemplateCard => {
  const r = renderInput(a.toolName, a.toolInput, a.toolInputStr, a.cwd);
  const dir = dirName(a.cwd);
  const tail = oneLine(a.transcriptTail).trim();
  const jl = detailJumpList(a.detailUrl);
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: mainTitle(`${a.toolName} · ${dir}/`, r.desc),
    ...(r.body ? { quote_area: quoteArea(r.body) } : {}),
    ...(jl ? { jump_list: jl } : {}),
    task_id: a.reqId,
    button_list: [{ text: "已经放行", style: 4, key: `noop:${a.reqId}` }],
  };
};

// ── Batch coalescing ───────────────────────────────────────────────────
// 同 session 同 tool 的并发 PreToolUse 在 batchCoalesceMs 窗口内合流为
// 一张卡 — 否则用户被 N 张并发卡轰炸 (典型场景: 模型并发 3 个 Bash)。
// 单成员的批次回落到普通 buildCard, 行为与未启用聚合一致 (仅多 ms 级延迟)。
interface BatchMember {
  reqId: string;
  toolInput: unknown;
  toolInputStr: string;
  cwd: string;
  transcriptTail: string;
}
interface ActiveBatch {
  batchId: string;
  sessionId: string;
  toolName: string;
  approver: string;
  windowMinutes: number;
  members: BatchMember[];
  flushTimer: NodeJS.Timeout;
  flushed: boolean;
}
const activeBatches = new Map<string, ActiveBatch>(); // 仅 collecting 期; flush 后摘除
const batchById = new Map<string, ActiveBatch>();      // 长留, 供 click event 解析
const BATCH_BY_ID_TTL_MS = 30 * 60_000;
const BATCH_BY_ID_MAX = 200;
const evictBatches = (): void => {
  if (batchById.size <= BATCH_BY_ID_MAX) return;
  const cutoff = Date.now() - BATCH_BY_ID_TTL_MS;
  for (const [k, v] of batchById) {
    // members[0].reqId 总在 createPending 之后立刻入批, 用首个 reqId 的
    // pending meta.createdAt 也行; 这里近似用 batchId 后 8 位的时间戳。
    const ts = parseInt(v.batchId.slice(1, 1 + 8), 36);
    if (Number.isFinite(ts) && ts < cutoff) batchById.delete(k);
  }
};
const newBatchId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const batchKeyOf = (sessionId: string, toolName: string): string => `${sessionId}|${toolName}`;

// 单条成员渲染: 展开第 N 项的输入摘要, 单行化以适配批量列表的紧凑布局。
const PER_MEMBER_MAX = 120;
const BATCH_MAX_VISIBLE = 8;
const renderBatchBody = (batch: ActiveBatch): string => {
  const visible = batch.members.slice(0, BATCH_MAX_VISIBLE);
  const lines = visible.map((m, idx) => {
    const r = renderInput(batch.toolName, m.toolInput, m.toolInputStr, m.cwd);
    const flat = r.body ? oneLine(r.body) : "(no input)";
    return `${idx + 1}. ${TRUNC(flat, PER_MEMBER_MAX)}`;
  });
  const overflow = batch.members.length - visible.length;
  if (overflow > 0) lines.push(`…还有 ${overflow} 项`);
  return TRUNC(lines.join("\n"), QUOTE_MAX);
};

const buildBatchCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `🔐 授权 · ${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [
      { text: "❌", style: 4, key: encodeBatchKey(batch.batchId, "deny") },
      { text: "10min", style: 3, key: encodeBatchKey(batch.batchId, "allow_window") },
      { text: "✅", style: 4, key: encodeBatchKey(batch.batchId, "allow") },
    ],
  };
};

const buildBatchResolvedCard = (
  batch: ActiveBatch,
  decision: Decision,
  transcriptTail: string,
): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  const button = decision === "allow_window"
    ? {
        text: `${verbOf(decision, batch.windowMinutes)}(点击取消)`,
        style: 4,
        key: encodeCancelKey(batch.sessionId),
      }
    : {
        text: `${emojiOf(decision)} ${verbOf(decision, batch.windowMinutes)} ×${batch.members.length}`,
        style: 4,
        key: encodeBatchNoopKey(batch.batchId),
      };
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [button],
  };
};

const buildBatchAlreadyResolvedCard = (batch: ActiveBatch, transcriptTail: string): TemplateCard => {
  const dir = dirName(batch.members[0]?.cwd ?? "");
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: `${batch.toolName} ×${batch.members.length} · ${dir}/` },
    quote_area: quoteArea(renderBatchBody(batch)),
    task_id: batch.batchId,
    button_list: [{ text: "已经放行", style: 4, key: encodeBatchNoopKey(batch.batchId) }],
  };
};

const encodeKey = (reqId: string, decision: Decision): string => `${reqId}|${decision}`;
const NOOP_PREFIX = "noop:";
const CANCEL_PREFIX = "cancel_window:";
const BATCH_PREFIX = "B|";
const BATCH_NOOP_PREFIX = "B-noop:";
const encodeCancelKey = (sessionId: string): string => `${CANCEL_PREFIX}${sessionId}`;
const encodeBatchKey = (batchId: string, decision: Decision): string =>
  `${BATCH_PREFIX}${batchId}|${decision}`;
const encodeBatchNoopKey = (batchId: string): string => `${BATCH_NOOP_PREFIX}${batchId}`;
const decodeBatchKey = (key: string): { batchId: string; decision: Decision } | undefined => {
  if (!key.startsWith(BATCH_PREFIX)) return undefined;
  const [batchId, d] = key.slice(BATCH_PREFIX.length).split("|");
  if (!batchId || !d) return undefined;
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "deny") return undefined;
  return { batchId, decision: d };
};
const decodeBatchNoopKey = (key: string): string | undefined =>
  key.startsWith(BATCH_NOOP_PREFIX) ? key.slice(BATCH_NOOP_PREFIX.length) : undefined;
const decodeKey = (
  key: string,
): { reqId?: string; decision?: Decision; cancelSessionId?: string; noopReqId?: string } => {
  if (key.startsWith(NOOP_PREFIX)) {
    // noop:cancelled:<id> 也走这里，noopReqId 取剩余部分作为 task_id 兜底。
    return { noopReqId: key.slice(NOOP_PREFIX.length) };
  }
  if (key.startsWith(CANCEL_PREFIX)) {
    return { cancelSessionId: key.slice(CANCEL_PREFIX.length) };
  }
  const [reqId, d] = key.split("|");
  if (!reqId || !d) return {};
  if (d !== "allow" && d !== "allow_session" && d !== "allow_window" && d !== "deny") return {};
  return { reqId, decision: d };
};

// ── AskUserQuestion 投票卡分支 ─────────────────────────────────────────
// PreToolUse 协议端只能输出 allow/deny/ask, 没有「合成 tool_result」通道。
// 取舍: 用户在 WeCom 选了选项 → 走 deny + 把答案塞进 reason, model 把 reason
// 当作上下文继续推理(CLI 不会弹原生 picker, 流程不被打断);
// 选「🖥️ CLI 处理」哨兵选项 → 返回 ask, CLI 弹原生 picker 由用户本地作答。两路互斥。
// vote_interaction 不支持 button_list (SDK 类型注释明写「button_interaction 类型卡片使用」),
// 微信侧静默吞掉, 所以 cli 入口只能塞进 checkbox option_list 作为哨兵 id。
const ASKQ_PREFIX = "ASKQ|";
const ASKQ_PICKED_PREFIX = "picked:";
const ASKQ_CLI_OPTION_ID = "__cli__";
const ASKQ_NOOP_PREFIX = "askq_noop:";
type AskqAction = "submit";
const encodeAskqKey = (reqId: string): string => `${ASKQ_PREFIX}${reqId}|submit`;
const encodeAskqNoopKey = (reqId: string): string => `${ASKQ_NOOP_PREFIX}${reqId}`;
const decodeAskqKey = (
  key: string,
): { reqId: string; action: AskqAction } | undefined => {
  if (!key.startsWith(ASKQ_PREFIX)) return undefined;
  const [reqId, action] = key.slice(ASKQ_PREFIX.length).split("|");
  if (!reqId || action !== "submit") return undefined;
  return { reqId, action };
};
const decodeAskqNoopKey = (key: string): string | undefined =>
  key.startsWith(ASKQ_NOOP_PREFIX) ? key.slice(ASKQ_NOOP_PREFIX.length) : undefined;

interface AskqOption { label: string; description?: string }
interface AskqQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskqOption[];
}

const parseAskqInput = (i: unknown): AskqQuestion[] | undefined => {
  if (!i || typeof i !== "object") return undefined;
  const qs = (i as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return undefined;
  return qs.map((q): AskqQuestion => {
    const qq = (q ?? {}) as Record<string, unknown>;
    const opts = Array.isArray(qq.options) ? qq.options : [];
    return {
      question: typeof qq.question === "string" ? qq.question : "",
      header: typeof qq.header === "string" ? qq.header : "",
      multiSelect: Boolean(qq.multiSelect),
      options: opts.flatMap((o): AskqOption[] => {
        const oo = (o ?? {}) as Record<string, unknown>;
        return typeof oo.label === "string"
          ? [{
              label: oo.label,
              description: typeof oo.description === "string" ? oo.description : undefined,
            }]
          : [];
      }),
    };
  });
};

const ASKQ_OPTION_TEXT_MAX = 11;
const ASKQ_TITLE_MAX = 26;
const ASKQ_SUB_MAX = 480;

const buildAskqCard = (reqId: string, q: AskqQuestion, transcriptTail: string): TemplateCard => {
  const lines: string[] = [];
  if (q.question) lines.push(q.question);
  q.options.forEach((o, idx) => {
    if (o.description) lines.push(`${idx + 1}. ${o.label} — ${o.description}`);
  });
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "vote_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`🤔 ${q.header || "请选择"}`, ASKQ_TITLE_MAX) },
    sub_title_text: TRUNC(lines.join("\n"), ASKQ_SUB_MAX),
    task_id: reqId,
    checkbox: {
      question_key: "q",
      mode: q.multiSelect ? 1 : 0,
      option_list: [
        ...q.options.map((o, idx) => ({
          id: String(idx),
          text: TRUNC(o.label, ASKQ_OPTION_TEXT_MAX),
        })),
        { id: ASKQ_CLI_OPTION_ID, text: "🖥️ CLI 处理" },
      ],
    },
    submit_button: { text: "提交", key: encodeAskqKey(reqId) },
  } as TemplateCard;
};

type AskqOutcome = { kind: "picked"; picked: number[] } | { kind: "cli" } | { kind: "empty" };

// 投票卡 submit 后渲染的「已回答」卡仍可再次被点击（按钮 key=askq_noop:<id>）。
// 普通 approval 走 resolvedStash + buildAlreadyResolvedCard 那条线 — 但 askq
// 的 meta/outcome 不在那个 stash 里，沿用会被误渲染成「授权 · 已经放行」。
// 单独存一份，TTL 跟 resolvedStash 对齐即可。
interface AskqResolvedSnap { q: AskqQuestion; outcome: AskqOutcome; transcriptTail: string; at: number }
const askqResolvedStash = new Map<string, AskqResolvedSnap>();
const ASKQ_RESOLVED_TTL_MS = 30 * 60_000;
const ASKQ_RESOLVED_MAX = 200;
const stashAskqResolved = (reqId: string, snap: Omit<AskqResolvedSnap, "at">): void => {
  askqResolvedStash.set(reqId, { ...snap, at: Date.now() });
  if (askqResolvedStash.size > ASKQ_RESOLVED_MAX) {
    const cutoff = Date.now() - ASKQ_RESOLVED_TTL_MS;
    for (const [k, v] of askqResolvedStash) if (v.at < cutoff) askqResolvedStash.delete(k);
  }
};
const getAskqResolved = (reqId: string): AskqResolvedSnap | undefined => {
  const e = askqResolvedStash.get(reqId);
  if (!e) return undefined;
  if (Date.now() - e.at > ASKQ_RESOLVED_TTL_MS) { askqResolvedStash.delete(reqId); return undefined; }
  return e;
};

const buildAskqResolvedCard = (
  reqId: string,
  q: AskqQuestion,
  outcome: AskqOutcome,
  transcriptTail: string,
): TemplateCard => {
  const summary = outcome.kind === "cli"
    ? "🖥️ 已转 CLI 处理"
    : outcome.kind === "empty"
      ? "⚠️ 未选择"
      : `✅ ${outcome.picked.map((i) => q.options[i]?.label ?? `#${i}`).join(", ")}`;
  const tail = oneLine(transcriptTail).trim();
  return {
    card_type: "button_interaction",
    source: buildSource(tail),
    main_title: { title: TRUNC(`🤔 ${q.header || "已回答"}`, ASKQ_TITLE_MAX) },
    sub_title_text: TRUNC(q.question, ASKQ_SUB_MAX),
    task_id: reqId,
    button_list: [{ text: TRUNC(summary, 30), style: 4, key: encodeAskqNoopKey(reqId) }],
  };
};

interface AskqHandleArgs {
  cfg: Config;
  log: Logger;
  client: WSClient;
  body: ApproveReq;
  getMirrorTarget?: (sessionId: string) => string | undefined;
}

const handleAskUserQuestion = async ({ cfg, log, client, body, getMirrorTarget }: AskqHandleArgs): Promise<ApproveResp> => {
  const questions = parseAskqInput(body.tool_input);
  if (!questions || questions.length === 0) return { decision: "ask", reason: "askq_unparsable" };
  if (questions.length > 1) return { decision: "ask", reason: "askq_multi_unsupported" };
  const q = questions[0]!;
  if (q.options.length === 0) return { decision: "ask", reason: "askq_no_options" };

  const approver = resolveApprover(cfg, body.session_id, getMirrorTarget);
  if (!approver) return { decision: "ask", reason: "no_approver" };
  if (!client.isConnected) return { decision: "ask", reason: "ws_disconnected" };

  const longPollMs = cfg.approval.longPollSec * 1000;
  // toolInput 存原始 input,事件 listener 通过 getPending 重解析。
  // transcriptTail 一并存进 meta, resolved 卡渲染时复用同一份 source。
  const { reqId, promise } = createPending({
    meta: {
      kind: "generic",
      createdAt: Date.now(),
      toolName: "AskUserQuestion",
      toolInput: body.tool_input,
      cwd: body.cwd,
      sessionId: body.session_id,
      transcriptTail: body.transcript_tail ?? "",
    },
    timeoutMs: longPollMs,
  });

  try {
    await client.sendMessage(targetChatId(approver), {
      msgtype: "template_card",
      template_card: buildAskqCard(reqId, q, body.transcript_tail ?? ""),
    });
    log.info({ reqId, approver }, "askq card sent");
  } catch (e) {
    log.error({ err: (e as Error).message }, "askq send failed");
    resolvePending(reqId, "deny"); // 释放 pending 槽
    return { decision: "ask", reason: `askq_send_fail:${(e as Error).message}` };
  }

  let raw: string;
  try {
    raw = (await promise) as unknown as string;
  } catch {
    return { decision: "ask", reason: "askq_timeout" };
  }

  if (raw === "cli") return { decision: "ask", reason: "askq_cli" };
  if (raw.startsWith(ASKQ_PICKED_PREFIX)) {
    const idxs = raw.slice(ASKQ_PICKED_PREFIX.length)
      .split(",")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < q.options.length);
    if (idxs.length === 0) return { decision: "ask", reason: "askq_empty_pick" };
    const labels = idxs.map((i) => q.options[i]!.label).join(", ");
    return {
      decision: "deny",
      reason: `User answered "${q.header || q.question}" via WeCom: ${labels}`,
    };
  }
  return { decision: "ask", reason: "askq_unknown" };
};

// ── /approve handler ───────────────────────────────────────────────────
interface ApproveReq {
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd?: string;
  transcript_tail?: string;
}

interface ApproveResp {
  decision: "allow" | "deny" | "ask";
  reason?: string;
}

const decisionToHook = (d: Decision): "allow" | "deny" => (d === "deny" ? "deny" : "allow");

const fallback = (cfg: Config, reason: string): ApproveResp => ({
  decision: cfg.approval.fallbackOnError,
  reason,
});

interface ApprovalDeps {
  cfg: Config;
  log: Logger;
  client: WSClient;
  /** Optional: resolve a Claude sessionId to its bound WeCom mirror target (e.g. "chat:xxx").
   *  When set and the request's session has a mirror, the approval card is routed there
   *  instead of cfg.approval.approvers[0] / cfg.defaultChat — keeps the conversation and
   *  its approval prompts in the same WeCom chat. */
  getMirrorTarget?: (sessionId: string) => string | undefined;
}

const resolveApprover = (
  cfg: Config,
  sessionId: string,
  getMirrorTarget?: (sid: string) => string | undefined,
): string | undefined => {
  const mirror = sessionId ? getMirrorTarget?.(sessionId) : undefined;
  return mirror || pickApprover(cfg);
};

export const makeApproveHandler = ({ cfg, log, client, getMirrorTarget }: ApprovalDeps): Handler => {
  const detailUrlFor = (id: string): string =>
    buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id);

  // Flush 一个 batch: 单成员 → 普通卡 (与未启用聚合一致); 多成员 → 批量卡。
  // 发送失败时调用 failPending 让每位成员的 handler 走 fallbackOnError 路径,
  // 与单卡路径上 sendMessage 抛错时的语义一致。
  const flushBatch = async (batch: ActiveBatch): Promise<void> => {
    if (batch.flushed) return;
    batch.flushed = true;
    activeBatches.delete(batchKeyOf(batch.sessionId, batch.toolName));
    const isMulti = batch.members.length > 1;
    const card: TemplateCard = isMulti
      ? buildBatchCard(batch, batch.members[0]?.transcriptTail ?? "")
      : (() => {
          const m = batch.members[0]!;
          return buildCard({
            reqId: m.reqId,
            toolName: batch.toolName,
            toolInput: m.toolInput,
            toolInputStr: m.toolInputStr,
            cwd: m.cwd,
            sessionShort: batch.sessionId ? batch.sessionId.slice(-8) : "?",
            transcriptTail: m.transcriptTail,
            windowMinutes: batch.windowMinutes,
            detailUrl: detailUrlFor(m.reqId),
          });
        })();
    try {
      await client.sendMessage(targetChatId(batch.approver), {
        msgtype: "template_card",
        template_card: card,
      });
      log.info(
        { batchId: batch.batchId, count: batch.members.length, multi: isMulti, approver: batch.approver, tool: batch.toolName },
        "batch flushed",
      );
    } catch (e) {
      log.error({ batchId: batch.batchId, err: (e as Error).message }, "batch send failed");
      const err = new Error(`send_card_fail:${(e as Error).message}`);
      for (const m of batch.members) failPending(m.reqId, err);
      // 单成员 batch 摘除自己的 batchById 条目, 多成员保留 (后续 click 兜底
      // 时 build*Card 期望能找到 batch — 但失败时也没人会点了, 留着也无害)。
      if (!isMulti) batchById.delete(batch.batchId);
    }
  };

  return async (req, res) => {
    if (!cfg.approval.enabled) {
      json(res, 200, { decision: "ask", reason: "approval_disabled" } satisfies ApproveResp);
      return;
    }

    const body = (await readBody(req)) as Partial<ApproveReq>;
    const sessionId = body.session_id ?? "";
    const toolName = body.tool_name ?? "";
    const toolInput = body.tool_input ?? {};
    const cwd = body.cwd ?? "";
    const transcriptTail = body.transcript_tail ?? "";

    if (!toolName) {
      json(res, 400, { decision: "ask", reason: "missing_tool_name" } satisfies ApproveResp);
      return;
    }

    // Matcher: only intercept matching tools — others pass.
    if (!new RegExp(cfg.approval.matcher).test(toolName)) {
      json(res, 200, { decision: "allow", reason: "matcher_skip" } satisfies ApproveResp);
      return;
    }

    // AskUserQuestion 走单独的投票卡分支(deny+reason 注入答案 / ask 转 CLI)。
    if (toolName === "AskUserQuestion") {
      const resp = await handleAskUserQuestion({
        cfg,
        log,
        client,
        getMirrorTarget,
        body: {
          session_id: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          cwd,
          transcript_tail: transcriptTail,
        },
      });
      json(res, 200, resp satisfies ApproveResp);
      return;
    }

    // Auto-approve window: while active for THIS session, requests short-circuit to allow.
    if (isAutoWindowActive(sessionId)) {
      const remainSec = Math.ceil(autoWindowRemainingMs(sessionId) / 1000);
      log.info({ toolName, sessionId, remainSec }, "auto-window allow");
      json(res, 200, {
        decision: "allow",
        reason: `auto_window:${remainSec}s`,
      } satisfies ApproveResp);
      return;
    }

    // Session cache
    const ck = cacheKey(sessionId, toolName, toolInput);
    const cached = cacheGet(ck);
    if (cached) {
      log.info({ ck, cached }, "cache hit");
      json(res, 200, {
        decision: decisionToHook(cached),
        reason: `cached:${cached}`,
      } satisfies ApproveResp);
      return;
    }

    const approver = resolveApprover(cfg, sessionId, getMirrorTarget);
    if (!approver) {
      log.warn("no approver configured");
      json(res, 200, fallback(cfg, "no_approver") satisfies ApproveResp);
      return;
    }
    if (!client.isConnected) {
      log.warn("ws not connected");
      json(res, 200, fallback(cfg, "ws_disconnected") satisfies ApproveResp);
      return;
    }

    // Build pending + card
    const display = cfg.approval.sensitiveArgRedact ? redact(toolInput) : toolInput;
    const toolInputStr = (() => {
      try {
        return JSON.stringify(display, null, 2);
      } catch {
        return String(display);
      }
    })();

    const longPollMs = cfg.approval.longPollSec * 1000;
    const { reqId, promise } = createPending({
      meta: {
        kind: "approval",
        createdAt: Date.now(),
        toolName,
        toolInput: display,
        cwd,
        sessionId,
        transcriptTail,
      },
      timeoutMs: longPollMs,
    });

    recordApproval({
      id: reqId,
      toolName,
      toolInput: display,
      cwd,
      sessionId,
      transcriptTail,
    });

    // Batch coalesce: 同 session 同 tool 的并发请求合流为一张卡。窗口内首位
    // 创建 batch + 计时器, 后续到达者只追加成员, 不发卡。flush 时依据成员数
    // 选择普通 buildCard 或 buildBatchCard。0 = 关闭聚合, 立即 flush。
    const member: BatchMember = { reqId, toolInput: display, toolInputStr, cwd, transcriptTail };
    const bk = batchKeyOf(sessionId, toolName);
    const existing = activeBatches.get(bk);
    if (existing && !existing.flushed) {
      existing.members.push(member);
      log.info({ batchId: existing.batchId, count: existing.members.length, reqId }, "batch joined");
    } else {
      const batch: ActiveBatch = {
        batchId: newBatchId(),
        sessionId,
        toolName,
        approver,
        windowMinutes: cfg.approval.windowMinutes,
        members: [member],
        flushed: false,
        flushTimer: undefined as unknown as NodeJS.Timeout, // set below
      };
      const coalesceMs = cfg.approval.batchCoalesceMs;
      const fire = (): void => void flushBatch(batch);
      batch.flushTimer = coalesceMs > 0 ? setTimeout(fire, coalesceMs) : setImmediate(fire) as unknown as NodeJS.Timeout;
      activeBatches.set(bk, batch);
      batchById.set(batch.batchId, batch);
      evictBatches();
      log.info({ batchId: batch.batchId, reqId, coalesceMs }, "batch opened");
    }

    // Long-poll
    let decision: Decision;
    try {
      decision = await promise;
    } catch (e) {
      log.warn({ err: (e as Error).message, reqId }, "approval timed out");
      json(res, 200, fallback(cfg, "approver_timeout") satisfies ApproveResp);
      return;
    }

    if (decision === "allow_session" && cfg.approval.sessionCacheMinutes > 0) {
      cachePut(ck, decision, cfg.approval.sessionCacheMinutes * 60_000);
    }
    if (decision === "allow_window" && cfg.approval.windowMinutes > 0) {
      setAutoWindow(sessionId, cfg.approval.windowMinutes * 60_000, {
        toolName,
        toolInput: display,
        cwd,
        transcriptTail,
      });
      // 同 turn 并发触发的其它 pending 卡 — 一并放行，免得用户逐个点。
      // 我们没有那些卡的事件 frame, 不能 updateTemplateCard 改文案；
      // 改用一条 markdown 消息回执让用户知道发生了什么。
      const swept = resolvePendingsBySession(sessionId, "allow_window", reqId);
      log.info({ sessionId, minutes: cfg.approval.windowMinutes, swept: swept.length }, "auto-window opened");
      if (swept.length > 0) {
        try {
          const tools = swept
            .map(({ meta }) => meta.toolName)
            .filter((s): s is string => Boolean(s));
          const summary = tools.length > 0 ? tools.join(" / ") : `${swept.length} 个`;
          await client.sendMessage(targetChatId(approver), {
            msgtype: "markdown",
            markdown: { content: `⚡ 已批量自动放行其他 ${swept.length} 个并发请求：${summary}` },
          });
        } catch (e) {
          log.warn({ err: (e as Error).message }, "sweep notice send failed");
        }
      }
    }

    // Resolved-card refresh happens inline in the click listener via
    // `updateTemplateCard` (5-sec window). No follow-up sendMessage here.

    json(res, 200, {
      decision: decisionToHook(decision),
      reason: decision,
    } satisfies ApproveResp);
  };
};

// ── Card click event → resolvePending + update card in place ────────────
export const installApprovalEventListener = (
  client: WSClient,
  log: Logger,
  cfg: Config,
  onApproved?: (sessionId: string) => void,
): void => {
  client.on("event", (frame: WsFrame<EventMessage>) => {
    try {
      log.info({ raw: JSON.stringify(frame.body).slice(0, 1200) }, "raw event frame");
    } catch {
      /* ignore */
    }
  });
  client.on(
    "event.template_card_event",
    async (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
      const ev = frame.body?.event as
        | (TemplateCardEventData & {
            template_card_event?: {
              event_key?: string;
              task_id?: string;
              // 实际 payload 是 XML→JSON 转出来的双层包装,跟 SDK 类型不一致:
              //   selected_items.selected_item[i].option_ids.option_id[j]
              // 同时也兼容 SDK 声明的扁平形态。
              selected_items?:
                | Array<{ question_key?: string; option_ids?: string[] | { option_id?: string[] } }>
                | { selected_item?: Array<{ question_key?: string; option_ids?: { option_id?: string[] } | string[] }> };
            };
          })
        | undefined;
      // SDK d.ts says ev.event_key, but the actual payload nests it under
      // ev.template_card_event.event_key. Fall back across both for safety.
      const key = ev?.template_card_event?.event_key ?? ev?.event_key ?? "";
      // Update 时 task_id 必须跟回调里的一致，否则微信会拒掉更新。
      const cbTaskId = ev?.template_card_event?.task_id ?? ev?.task_id ?? "";

      // ── AskUserQuestion 投票卡: 在普通 approval 解码前先匹配 ASKQ| 前缀。
      const askq = decodeAskqKey(key);
      if (askq) {
        const meta = getPending(askq.reqId);
        const q = parseAskqInput(meta?.toolInput)?.[0];
        // 实际 payload 是 XML→JSON 双层包装, 不能直接 [0].option_ids; 同时
        // 兼容 SDK 文档里那个扁平形态(以防固件升级)。
        const si = ev?.template_card_event?.selected_items;
        const firstItem: { option_ids?: string[] | { option_id?: string[] } } | undefined =
          Array.isArray(si)
            ? si[0]
            : si?.selected_item?.[0];
        const oids = firstItem?.option_ids;
        const rawIds: string[] = Array.isArray(oids)
          ? oids
          : (oids?.option_id ?? []);
        const cliPicked = rawIds.includes(ASKQ_CLI_OPTION_ID);
        const numericIdxs = rawIds
          .filter((s) => s !== ASKQ_CLI_OPTION_ID)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isInteger(n) && n >= 0);
        // CLI 哨兵优先 (即便和其它选项混选,也按转 CLI 处理)。
        const outcome: AskqOutcome = cliPicked
          ? { kind: "cli" }
          : numericIdxs.length === 0
            ? { kind: "empty" }
            : { kind: "picked", picked: numericIdxs };
        const resolved = outcome.kind === "cli"
          ? "cli"
          : `${ASKQ_PICKED_PREFIX}${numericIdxs.join(",")}`;
        const ok = resolvePending(askq.reqId, resolved as never);
        log.info({ reqId: askq.reqId, outcome, ok }, "askq event resolved");
        if (q) {
          // 存一份给后续在 resolved 卡上重复点击 askq_noop 用 — resolvePending
          // 已经把 pending entry 删掉了,不再 stash 这次拿不到原 question。
          stashAskqResolved(askq.reqId, { q, outcome, transcriptTail: meta?.transcriptTail ?? "" });
          try {
            await client.updateTemplateCard(
              frame,
              buildAskqResolvedCard(
                cbTaskId || askq.reqId,
                q,
                outcome,
                meta?.transcriptTail ?? "",
              ),
            );
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId: askq.reqId }, "askq updateTemplateCard failed");
          }
        }
        return;
      }

      const decoded = decodeKey(key);

      const detailUrlFor = (id: string): string =>
        buildDetailUrl(cfg.daemon.detailPublicBase, cfg.daemon.host, cfg.daemon.port, id);

      // Batch 卡分支: 一次性 resolve N 个成员 pending, 单次 update 卡片状态。
      // 必须在普通 decodeKey 分支前匹配 — 否则 batchId 形如 "b...|allow" 也
      // 能被 split("|") 当作 reqId|decision 误解出来。
      const batchDec = decodeBatchKey(key);
      if (batchDec) {
        const batch = batchById.get(batchDec.batchId);
        if (!batch) {
          log.info({ batchId: batchDec.batchId }, "batch click — unknown id, ignored");
          return;
        }
        const by = frame.body?.from?.userid ?? "?";
        let resolved = 0;
        for (const m of batch.members) {
          recordApprovalDecision(m.reqId, batchDec.decision, by);
          if (resolvePending(m.reqId, batchDec.decision)) resolved++;
        }
        // 全部成员都已被先前的 allow_window sweep 拿走 → 渲染「已经放行」形态
        // 而非再画一遍三按钮的 resolved 卡, 跟单卡 swept 路径语义对齐。
        const allSwept = resolved === 0 && batch.members.length > 0;
        log.info({ batchId: batch.batchId, decision: batchDec.decision, resolved, total: batch.members.length, allSwept }, "batch resolved");
        if (resolved > 0) onApproved?.(batch.sessionId);
        try {
          const tail = batch.members[0]?.transcriptTail ?? "";
          const card = allSwept
            ? buildBatchAlreadyResolvedCard(batch, tail)
            : buildBatchResolvedCard(batch, batchDec.decision, tail);
          await client.updateTemplateCard(frame, card);
          log.info({ batchId: batch.batchId, decision: batchDec.decision, allSwept }, "batch card updated in place");
        } catch (e) {
          log.warn({ err: (e as Error).message, batchId: batch.batchId }, "batch updateTemplateCard failed");
        }
        return;
      }

      // Batch-noop: 已 resolved 的批量卡再次被点 — 仅视觉回执。
      const batchNoopId = decodeBatchNoopKey(key);
      if (batchNoopId !== undefined) {
        const batch = batchById.get(batchNoopId);
        if (batch) {
          try {
            await client.updateTemplateCard(
              frame,
              buildBatchAlreadyResolvedCard(batch, batch.members[0]?.transcriptTail ?? ""),
            );
            log.info({ batchId: batchNoopId }, "batch noop click — already-resolved card refreshed");
          } catch (e) {
            log.warn({ err: (e as Error).message, batchId: batchNoopId }, "updateTemplateCard (batch-noop) failed");
          }
        } else {
          log.info({ batchId: batchNoopId }, "batch noop click — batch expired, ignored");
        }
        return;
      }

      // Askq-noop 分支: askq 投票卡 submit 后那张「已回答」卡再次被点。
      // 必须在普通 noop 分支前匹配 — 否则会落到 buildAlreadyResolvedCard
      // 渲染成「授权 · 已经放行」,污染原卡。
      const askqNoopReqId = decodeAskqNoopKey(key);
      if (askqNoopReqId !== undefined) {
        const snap = getAskqResolved(askqNoopReqId);
        if (snap) {
          try {
            await client.updateTemplateCard(
              frame,
              buildAskqResolvedCard(cbTaskId || askqNoopReqId, snap.q, snap.outcome, snap.transcriptTail),
            );
            log.info({ reqId: askqNoopReqId }, "askq noop click — resolved card refreshed");
          } catch (e) {
            log.warn({ err: (e as Error).message, reqId: askqNoopReqId }, "updateTemplateCard (askq-noop) failed");
          }
        } else {
          log.info({ reqId: askqNoopReqId }, "askq noop click — stash expired, ignored");
        }
        return;
      }

      // Noop branch: 卡片已 resolved, 用户再次点击 — 给一次视觉反馈。
      if (decoded.noopReqId !== undefined) {
        const reqId = decoded.noopReqId;
        const snap = getResolvedSnapshot(reqId);
        try {
          await client.updateTemplateCard(
            frame,
            buildAlreadyResolvedCard({
              reqId: cbTaskId || reqId,
              toolName: snap?.meta.toolName ?? "授权",
              toolInput: snap?.meta.toolInput ?? {},
              toolInputStr: "",
              cwd: snap?.meta.cwd ?? "",
              sessionShort: snap?.meta.sessionId ? snap.meta.sessionId.slice(-8) : "?",
              transcriptTail: snap?.meta.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: detailUrlFor(reqId),
            }),
          );
          log.info({ reqId }, "noop click — already-resolved card refreshed");
        } catch (e) {
          log.warn({ err: (e as Error).message, reqId }, "updateTemplateCard (noop) failed");
        }
        return;
      }

      // Cancel branch: resolved allow_window card was clicked again to cancel
      // the auto-approve window for that session. No pending to resolve.
      if (decoded.cancelSessionId) {
        const wmeta = getWindowMeta(decoded.cancelSessionId);
        clearAutoWindow(decoded.cancelSessionId);
        log.info({ sessionId: decoded.cancelSessionId }, "auto-window cancelled by click");
        try {
          await client.updateTemplateCard(
            frame,
            buildCancelledCard({
              reqId: cbTaskId,  // 必须用回调的 task_id，否则微信拒更新
              toolName: wmeta?.toolName ?? "授权",
              toolInput: wmeta?.toolInput ?? {},
              toolInputStr: "",
              cwd: wmeta?.cwd ?? "",
              sessionShort: decoded.cancelSessionId.slice(-8),
              transcriptTail: wmeta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: cbTaskId ? detailUrlFor(cbTaskId) : undefined,
            }),
          );
          log.info({ sessionId: decoded.cancelSessionId, cbTaskId }, "cancel card updated in place");
        } catch (e) {
          log.warn({ err: (e as Error).message }, "updateTemplateCard (cancel) failed");
        }
        return;
      }

      const { reqId, decision } = decoded;
      if (!reqId || !decision) {
        log.info({ key }, "card event ignored (bad key)");
        return;
      }
      // Snapshot meta BEFORE resolve (resolve deletes the entry).
      const livePending = getPending(reqId);
      const ok = resolvePending(reqId, decision);
      // 兜底: 这张卡如果是被 sweep 提前 resolve 掉的"鬼卡", livePending 已经没了
      // (resolvePendingsBySession 删过); 从 resolvedStash 里捞回原始 meta + 真实
      // decision, 渲染成"已自动放行"形态而非 (probe)。
      const snap = livePending ? undefined : getResolvedSnapshot(reqId);
      const meta = livePending ?? snap?.meta;
      const effectiveDecision: Decision = snap?.decision ?? decision;
      const by = frame.body?.from?.userid ?? "?";
      recordApprovalDecision(reqId, snap ? "swept" : effectiveDecision, by);
      if (ok) log.info({ reqId, decision }, "card event resolved");
      else if (snap) log.info({ reqId, snap: snap.decision }, "card event on swept card — rendering snapshot");
      else {
        // meta 完全缺失 (daemon 重启 / stash 过期 / 真探测包)。任何 update 都会用
        // 空字段把原卡覆盖成 "(probe) · /"，比保留原卡更糟。直接放弃 update。
        log.warn({ reqId, decision }, "card event for unknown reqId (probe? expired?) — skipping update to avoid clobbering original card");
        return;
      }

      // 用户实际点击的那一下 — 通知 mirror 立刻 finalize 当前 liveStream,
      // 后续的 tool_use / tool_result 走防抖 standalone 路径,避免点击后仍把
      // 内容续写进同一个气泡。sweep 二次点击 (snap 命中, ok=false) 不触发,
      // 避免重复 finalize。
      if (ok && meta?.sessionId) onApproved?.(meta.sessionId);

      // Refresh original card in place (must be within 5s of click).
      // Independent of pending resolution: we always want visual ACK on any
      // well-formed click so the user knows the click landed.
      const toolInputStr = (() => {
        try {
          return JSON.stringify(meta?.toolInput ?? {}, null, 2);
        } catch {
          return String(meta?.toolInput);
        }
      })();
      const sessionShort = meta?.sessionId ? meta.sessionId.slice(-8) : "?";
      // snap 命中 = 这张卡已被 sweep / 重复点击, 没有真正状态变更, 渲染成
      // 「已经放行」而不是再画一遍 allow_window「点击取消」按钮 — 否则用户
      // 在被批量放行的卡上会看到一个会去取消整个窗口的按钮, 误导。
      try {
        const card = snap
          ? buildAlreadyResolvedCard({
              reqId: cbTaskId || reqId,
              toolName: meta?.toolName ?? "授权",
              toolInput: meta?.toolInput ?? {},
              toolInputStr,
              cwd: meta?.cwd ?? "",
              sessionShort,
              transcriptTail: meta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              detailUrl: detailUrlFor(reqId),
            })
          : buildResolvedCard({
              reqId,
              toolName: meta?.toolName ?? "授权",
              toolInput: meta?.toolInput,
              toolInputStr,
              cwd: meta?.cwd ?? "",
              sessionShort,
              transcriptTail: meta?.transcriptTail ?? "",
              windowMinutes: cfg.approval.windowMinutes,
              decision: effectiveDecision,
              by,
              sessionId: meta?.sessionId ?? "",
              detailUrl: detailUrlFor(reqId),
            });
        await client.updateTemplateCard(frame, card);
        log.info({ reqId, decision, swept: Boolean(snap) }, "card updated in place");
      } catch (e) {
        log.warn({ err: (e as Error).message, reqId }, "updateTemplateCard failed");
      }
    },
  );
};
