// Session cache for "Allow for session" decisions.
// Key = (sessionId, toolName, hash(cmd_prefix)). In-memory, TTL via approval.sessionCacheMinutes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "../shared/paths.js";
import type { Decision } from "./pending.js";

interface Entry {
  decision: Decision;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

const cmdPrefix = (toolName: string, toolInput: unknown): string => {
  // Bash: first token of command. Others: stable JSON.
  if (toolName === "Bash" && toolInput && typeof toolInput === "object") {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === "string") {
      const first = norm(cmd).split(" ")[0] ?? "";
      return first;
    }
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
};

export const cacheKey = (sessionId: string, toolName: string, toolInput: unknown): string => {
  const h = createHash("sha1").update(cmdPrefix(toolName, toolInput)).digest("hex").slice(0, 12);
  return `${sessionId}::${toolName}::${h}`;
};

export const cacheGet = (key: string): Decision | undefined => {
  const e = cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return e.decision;
};

export const cachePut = (key: string, decision: Decision, ttlMs: number): void => {
  cache.set(key, { decision, expiresAt: Date.now() + ttlMs });
};

export const cacheClear = (): void => cache.clear();

// ── Per-session auto-approve window ────────────────────────────────────
// Set by `allow_window` clicks; while active, approval requests within the
// SAME sessionId bypass the card flow and return allow immediately.
// Persisted to disk so daemon restart doesn't drop the user's "10min" choice.
const autoApproveUntilBySession = new Map<string, number>();

// 保存最近一次窗口卡片的元信息，用于"取消"时重建卡片不丢上下文。
export interface WindowMeta {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  transcriptTail: string;
}
const windowMetaBySession = new Map<string, WindowMeta>();

// ── Persistence ─────────────────────────────────────────────────────────
let persistPath: string | undefined;

interface PersistShape {
  windows: Record<string, { until: number; meta?: WindowMeta }>;
}

const writeAtomic = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
};

const persist = (): void => {
  if (!persistPath) return;
  const windows: PersistShape["windows"] = {};
  for (const [sid, until] of autoApproveUntilBySession.entries()) {
    windows[sid] = { until, meta: windowMetaBySession.get(sid) };
  }
  try {
    writeAtomic(persistPath, JSON.stringify({ windows } satisfies PersistShape));
  } catch {
    /* best-effort; in-memory state still authoritative */
  }
};

/** Call once at daemon startup. Loads any unexpired windows from disk. */
export const initAutoWindowPersistence = (stateDir: string): void => {
  const dir = expandHome(stateDir);
  persistPath = join(dir, "auto-windows.json");
  try {
    mkdirSync(dirname(persistPath), { recursive: true });
  } catch {
    /* ignore */
  }
  if (!existsSync(persistPath)) return;
  try {
    const data = JSON.parse(readFileSync(persistPath, "utf8")) as Partial<PersistShape>;
    const now = Date.now();
    for (const [sid, entry] of Object.entries(data.windows ?? {})) {
      if (!entry || typeof entry.until !== "number") continue;
      if (entry.until <= now) continue;
      autoApproveUntilBySession.set(sid, entry.until);
      if (entry.meta) windowMetaBySession.set(sid, entry.meta);
    }
    // 清掉过期项后落盘一次。
    persist();
  } catch {
    /* corrupt file — start fresh */
  }
};

export const setAutoWindow = (sessionId: string, ttlMs: number, meta?: WindowMeta): number => {
  const until = Date.now() + ttlMs;
  autoApproveUntilBySession.set(sessionId, until);
  if (meta) windowMetaBySession.set(sessionId, meta);
  persist();
  return until;
};

export const getWindowMeta = (sessionId: string): WindowMeta | undefined =>
  windowMetaBySession.get(sessionId);

export const autoWindowRemainingMs = (sessionId: string): number =>
  Math.max(0, (autoApproveUntilBySession.get(sessionId) ?? 0) - Date.now());

export const isAutoWindowActive = (sessionId: string): boolean => {
  const until = autoApproveUntilBySession.get(sessionId);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    autoApproveUntilBySession.delete(sessionId);
    windowMetaBySession.delete(sessionId);
    persist();
    return false;
  }
  return true;
};

export const clearAutoWindow = (sessionId?: string): void => {
  if (sessionId === undefined) {
    autoApproveUntilBySession.clear();
    windowMetaBySession.clear();
  } else {
    autoApproveUntilBySession.delete(sessionId);
    windowMetaBySession.delete(sessionId);
  }
  persist();
};
