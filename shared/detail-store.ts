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

export interface TurnDetailRecord {
  kind: "turn";
  id: string;
  createdAt: number;
  updatedAt: number;
  closed: boolean;
  target?: string;
  sessionId?: string;
  items: TurnItem[];
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
  closeTurn(id: string): void;
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
    closeTurn: (id) => {
      const r = store.get(id);
      if (!r || r.kind !== "turn" || r.closed) return;
      put({ ...r, closed: true, updatedAt: Date.now() });
    },
  };
};
