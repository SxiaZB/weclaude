// Chat-level derivations over the detail store — pure, no IO.
//
// A WeCom chat hosts one default session plus any number of `#tag` siblings
// (see session-label). The store already stamps every turn with its `target`
// (`chat:xxx#fix`), so "what does this chat look like right now" is a fold over
// the turn records sharing a base principal: group by target → a chat list,
// order one group by time → a thread, sum the usages → a status bar.
//
// Nothing here touches tmux or the mirror bridge, so the standalone svr derives
// exactly the same view from the records that were POSTed to it.
import { baseOfKey, labelFor, tagOfKey } from "./session-label.js";
import type { DetailRecord, TurnDetailRecord, TurnUsage } from "./detail-store.js";

export interface AggUsage extends TurnUsage {
  /** Wall-clock covered by the aggregated turns (sum of per-turn spans). */
  durationMs: number;
  turns: number;
  tools: number;
}

const ZERO: AggUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0,
  ctxPeak: 0, durationMs: 0, turns: 0, tools: 0,
};

export interface TagSummary {
  target: string;
  /** `#tag` suffix; "" for the chat's default session. */
  tag: string;
  /** Stable animal emoji, keyed on the tag string (survives /clear). */
  label: string;
  sessionId?: string;
  turns: number;
  lastTs: number;
  running: boolean;
  /** One-line "what happened last", for the chat-list row. */
  preview: string;
  usage: AggUsage;
}

export interface ChatSummary {
  base: string;
  tags: TagSummary[];
  usage: AggUsage;
}

/** A turn is finished when closed, or once its final assistant text landed —
 *  closeTurn can lag, but `final` really is the last thing a turn emits. */
export const turnDone = (r: TurnDetailRecord): boolean =>
  r.closed || r.items.some((it) => it.t === "text" && it.final === true);

const turnSpan = (r: TurnDetailRecord, now: number): number =>
  (turnDone(r) ? r.updatedAt : now) - r.createdAt;

const addUsage = (a: AggUsage, r: TurnDetailRecord, now: number): AggUsage => {
  const u = r.usage;
  const ctx = u ? (u.ctxPeak ?? u.input + u.cacheRead + u.cacheWrite) : 0;
  return {
    input: a.input + (u?.input ?? 0),
    output: a.output + (u?.output ?? 0),
    cacheRead: a.cacheRead + (u?.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (u?.cacheWrite ?? 0),
    calls: a.calls + (u?.calls ?? 0),
    serviceTier: a.serviceTier ?? u?.serviceTier,
    ctxPeak: Math.max(a.ctxPeak ?? 0, ctx),
    durationMs: a.durationMs + turnSpan(r, now),
    turns: a.turns + 1,
    tools: a.tools + r.items.filter((it) => it.t === "tool_use").length,
  };
};

export const aggregate = (turns: readonly TurnDetailRecord[], now: number): AggUsage =>
  turns.reduce((a, r) => addUsage(a, r, now), ZERO);

const stripMd = (s: string): string => s.replace(/[`*_~|#>]/g, "").replace(/\s+/g, " ").trim();

/** Last assistant prose of a turn, else the query that opened it. */
const previewOf = (r: TurnDetailRecord): string => {
  const texts = r.items.filter((it): it is Extract<typeof it, { t: "text" }> => it.t === "text");
  const last = texts[texts.length - 1]?.body ?? "";
  const src = last || r.userQuery || "";
  return stripMd(src).slice(0, 120);
};

export const isTurn = (r: DetailRecord): r is TurnDetailRecord => r.kind === "turn";

/** Turns of one session key, oldest first — the thread order. */
export const threadOf = (records: readonly DetailRecord[], target: string): TurnDetailRecord[] =>
  records.filter(isTurn).filter((r) => r.target === target).sort((a, b) => a.createdAt - b.createdAt);

const summarizeTag = (target: string, turns: readonly TurnDetailRecord[], now: number): TagSummary => {
  const last = turns[turns.length - 1];
  const tag = tagOfKey(target);
  return {
    target,
    tag,
    label: labelFor(tag || target),
    sessionId: last?.sessionId,
    turns: turns.length,
    lastTs: turns.reduce((m, r) => Math.max(m, r.updatedAt), 0),
    running: turns.some((r) => !turnDone(r)),
    preview: last ? previewOf(last) : "",
    usage: aggregate(turns, now),
  };
};

/** Group every turn of one chat by session key → the chat list. Most recently
 *  active tag first; the running ones naturally float up. */
export const chatSummary = (records: readonly DetailRecord[], base: string, now: number): ChatSummary => {
  const mine = records.filter(isTurn).filter((r) => r.target && baseOfKey(r.target) === base);
  const byTarget = mine.reduce((m, r) => {
    const k = r.target!;
    return m.set(k, [...(m.get(k) ?? []), r]);
  }, new Map<string, TurnDetailRecord[]>());
  const tags = [...byTarget.entries()]
    .map(([target, turns]) => summarizeTag(target, [...turns].sort((a, b) => a.createdAt - b.createdAt), now))
    .sort((a, b) => b.lastTs - a.lastTs);
  return { base, tags, usage: aggregate(mine, now) };
};
