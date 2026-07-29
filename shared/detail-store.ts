// Detail record store — factory pattern so daemon (local, sits behind card links)
// and svr (standalone, chat 端浏览器直连的公网/共享网络机) can each own an isolated
// instance. Pure state + IO. Rendering lives in ./detail-render.
//
// Persistence: append-only JSONL → <stateDir>/details.jsonl, replay on init;
// TTL 24h, LRU 上限 1000 条; 超过 COMPACT_BYTES 时按 store 快照重写整个文件。
import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { expandHome } from "./paths.js";

export type ApprovalDecision =
  | "allow"
  | "allow_session"
  | "allow_window"
  | "deny"
  | "timeout"
  | "swept";

export interface ToolDetailRecord {
  kind: "tool";
  id: string;
  createdAt: number;
  toolName: string;
  toolInput: unknown;
  toolResult?: string;
  resultAt?: number;
  target?: string;
  sessionId?: string;
}

export interface ApprovalDetailRecord {
  kind: "approval";
  id: string;
  createdAt: number;
  toolName: string;
  toolInput: unknown;
  cwd: string;
  sessionId: string;
  transcriptTail: string;
  decision?: ApprovalDecision;
  decidedBy?: string;
  decidedAt?: number;
}

// Brief 模式聚合: 一个 turn 内所有中间事件的时间线快照。turnId = mirror-bridge
// 侧生成的 turnId (t<base36-time><rand6>);同一 turn 多次 append 覆盖前值 (put 语义)。
export type TurnItem =
  | { t: "text"; body: string; ts: number; final?: boolean }
  | { t: "tool_use"; toolUseId: string; toolName: string; toolInput: unknown; ts: number }
  | { t: "tool_result"; toolUseId: string; body: string; ts: number }
  | { t: "approval"; approvalId: string; toolName: string; decision?: ApprovalDecision; ts: number };

// 累计一个 turn 内所有 assistant 行的 token usage — 每次 assistant 行都拿到独立
// 的 usage 值 (Anthropic Messages API 语义), 需要字段级累加。serviceTier 只保留
// 首见值; calls 记录累加了几次 (不是 tool 调用数, 是 API 调用数)。
export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;   // cache_read_input_tokens — 累计, 含跨调用重读同一前缀
  cacheWrite: number;  // cache_creation_input_tokens — 累计
  serviceTier?: string;
  calls: number;
  // 单次 API 调用送入的上下文 (input+cacheRead+cacheWrite) 的峰值 = 窗口占用高水位。
  // 与上面的累计字段不同: 不随调用次数增长, 反映"窗口有多满"而非"总共读了多少"。
  // delta 传入时可缺省 (mirror 侧按单调用发, 由 store 计算并落库)。
  ctxPeak?: number;
}

export interface TurnDetailRecord {
  kind: "turn";
  id: string;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  target?: string;
  sessionId?: string;
  userQuery?: string;  // 触发本轮的用户输入原文 (mirror 侧 dispatch 的 text)
  items: TurnItem[];
  model?: string;      // 首个见到的 model 名
  modelAlt?: number;   // 与 model 不同的后续行数, 用于渲染 "+N"
  usage?: TurnUsage;
  // 已入账的 Anthropic message.id — Claude Code jsonl 会把一次 API 响应拆成
  // 多条 assistant 行 (如 thinking + tool_use 各一条), 两条共享同一 message.id
  // 且各自都带 usage 快照。按 id 去重, 避免 usage 被 N 倍夸大。
  usageMsgIds?: string[];
}

export type DetailRecord = ToolDetailRecord | ApprovalDetailRecord | TurnDetailRecord;

export interface DetailStore {
  recordTool(rec: Omit<ToolDetailRecord, "kind" | "createdAt"> & { createdAt?: number }): void;
  recordToolResult(toolUseId: string, full: string): void;
  recordApproval(
    rec: Omit<ApprovalDetailRecord, "kind" | "createdAt" | "decision" | "decidedAt" | "decidedBy"> & { createdAt?: number },
  ): void;
  recordApprovalDecision(reqId: string, decision: ApprovalDecision, decidedBy?: string): void;
  startTurn(
    rec: Omit<TurnDetailRecord, "kind" | "createdAt" | "updatedAt" | "closed" | "items"> & { createdAt?: number },
  ): void;
  appendTurnItem(id: string, item: TurnItem): void;
  addTurnUsage(id: string, delta: { model?: string; messageId?: string; usage: TurnUsage }): void;
  closeTurn(id: string): void;
  // 收尾所有仍开着的 turn (可选按 target / sessionId 限定, 可选排除若干 id)。返回被
  // 关闭的 id。用途: 新一轮发出 finish 消息时, 把此前遗留未关闭的 turn 一并标记结束。
  // sessionId 必须传: 同一个 chat 下的多个 #tag 会话共享 target, 只按 target 收尾会
  // 把兄弟 agent 正在跑的 turn 页面提前打成「已完成」(页面随即停止轮询, 看着像卡死)。
  // exceptIds 是复数: 当前 turn 之外, 还要保住排队中尚未激活的 turn。
  closeOpenTurns(scope: { target?: string; sessionId?: string; exceptIds?: readonly string[] }): string[];
  put(rec: DetailRecord): void;
  get(id: string): DetailRecord | undefined;
}

const TTL_MS = 24 * 3600_000;
const MAX = 1000;
const COMPACT_BYTES = 5 * 1024 * 1024;

export const createDetailStore = (opts: { stateDir: string; log?: Logger }): DetailStore => {
  const store = new Map<string, DetailRecord>();
  const dir = expandHome(opts.stateDir);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "details.jsonl");

  const gc = (): void => {
    const cutoff = Date.now() - TTL_MS;
    for (const [k, v] of store) if (v.createdAt < cutoff) store.delete(k);
    if (store.size > MAX) {
      const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (let i = 0; i < sorted.length - MAX; i++) store.delete(sorted[i]![0]);
    }
  };

  const persist = (rec: DetailRecord): void => {
    try { appendFileSync(logPath, `${JSON.stringify(rec)}\n`); } catch { /* ignore */ }
  };

  const compact = (): void => {
    const lines = [...store.values()].map((r) => JSON.stringify(r));
    try { writeFileSync(logPath, lines.length ? `${lines.join("\n")}\n` : ""); } catch { /* ignore */ }
  };

  const maybeCompact = (): void => {
    try { if (statSync(logPath).size > COMPACT_BYTES) compact(); } catch { /* ignore */ }
  };

  if (existsSync(logPath)) {
    const cutoff = Date.now() - TTL_MS;
    let replayed = 0, dropped = 0;
    try {
      const text = readFileSync(logPath, "utf8");
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as DetailRecord;
          if (!r?.id || (r.kind !== "tool" && r.kind !== "approval" && r.kind !== "turn")) continue;
          if (typeof r.createdAt !== "number" || r.createdAt < cutoff) { dropped++; continue; }
          store.set(r.id, r);
          replayed++;
        } catch { /* skip malformed line */ }
      }
    } catch (e) {
      opts.log?.warn({ err: (e as Error).message }, "detail store: replay failed");
    }
    gc();
    compact();
    opts.log?.info({ logPath, replayed, dropped, kept: store.size }, "detail store: replay done");
  } else {
    opts.log?.info({ logPath }, "detail store: fresh log");
  }

  const put = (rec: DetailRecord): void => {
    store.set(rec.id, rec);
    if (store.size > MAX) gc();
    persist(rec);
    maybeCompact();
  };

  return {
    put,
    get: (id) => store.get(id),
    recordTool: (rec) => {
      put({ kind: "tool", ...rec, createdAt: rec.createdAt ?? Date.now() });
    },
    recordToolResult: (toolUseId, full) => {
      const r = store.get(toolUseId);
      if (!r || r.kind !== "tool") return;
      put({ ...r, toolResult: full, resultAt: Date.now() });
    },
    recordApproval: (rec) => {
      put({ kind: "approval", ...rec, createdAt: rec.createdAt ?? Date.now() });
    },
    recordApprovalDecision: (reqId, decision, decidedBy) => {
      const r = store.get(reqId);
      if (!r || r.kind !== "approval") return;
      put({ ...r, decision, decidedBy, decidedAt: Date.now() });
    },
    startTurn: (rec) => {
      const now = Date.now();
      put({
        kind: "turn",
        ...rec,
        createdAt: rec.createdAt ?? now,
        updatedAt: now,
        closed: false,
        items: [],
      });
    },
    appendTurnItem: (id, item) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn") return;
      put({ ...r, items: [...r.items, item], updatedAt: Date.now() });
    },
    addTurnUsage: (id, delta) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn") return;
      // 同一 message.id 的重复行只入账一次 (thinking / tool_use 拆行, 共享 usage)。
      // 无 messageId 时保守累加 — 兼容早期 caller 或 headless (cc-bridge) 路径。
      const seenIds = r.usageMsgIds ?? [];
      const dupe = delta.messageId ? seenIds.includes(delta.messageId) : false;
      const cur = r.usage;
      const nextUsage: TurnUsage = dupe
        ? (cur ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 })
        : (() => {
            // 这一次调用送入的上下文 = 新鲜输入 + 缓存读 + 缓存写 (delta 恒为单次调用)。
            const callCtx = delta.usage.input + delta.usage.cacheRead + delta.usage.cacheWrite;
            return cur
              ? {
                  input: cur.input + delta.usage.input,
                  output: cur.output + delta.usage.output,
                  cacheRead: cur.cacheRead + delta.usage.cacheRead,
                  cacheWrite: cur.cacheWrite + delta.usage.cacheWrite,
                  serviceTier: cur.serviceTier ?? delta.usage.serviceTier,
                  calls: cur.calls + delta.usage.calls,
                  ctxPeak: Math.max(cur.ctxPeak ?? 0, callCtx),
                }
              : { ...delta.usage, ctxPeak: callCtx };
          })();
      const nextIds = delta.messageId && !dupe ? [...seenIds, delta.messageId] : seenIds;
      let model = r.model;
      let modelAlt = r.modelAlt;
      if (delta.model) {
        if (!model) model = delta.model;
        else if (model !== delta.model) modelAlt = (modelAlt ?? 0) + 1;
      }
      put({ ...r, model, modelAlt, usage: nextUsage, usageMsgIds: nextIds.length ? nextIds : undefined, updatedAt: Date.now() });
    },
    closeTurn: (id) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn" || r.closed) return;
      put({ ...r, closed: true, updatedAt: Date.now() });
    },
    closeOpenTurns: ({ target, sessionId, exceptIds }) => {
      const now = Date.now();
      const keep = new Set(exceptIds ?? []);
      const closed: string[] = [];
      for (const [id, r] of store) {
        if (r.kind !== "turn" || r.closed) continue;
        if (keep.has(id)) continue;
        if (target && r.target !== target) continue;
        if (sessionId && r.sessionId !== sessionId) continue;
        put({ ...r, closed: true, updatedAt: now });
        closed.push(id);
      }
      return closed;
    },
  };
};
