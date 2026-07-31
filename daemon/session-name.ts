// 审批卡上的「会话名」— 回答"是哪个会话在请求授权"。
//
// 数据源按可靠度降级:
//   1. chatKey 里的 `#tag` — CLI 侧显式命名的并行会话, 最准;
//   2. transcript 里第一条用户消息的首句 — 没有 tag 时, "这个会话是来干嘛的"
//      的最好近似 (CC 生成会话 summary 用的也是它; summary 行本身不是每个
//      会话都有, 不可依赖);
//   3. sessionId 尾八位 — 前两者都拿不到时的保底可辨识串。
//
// 首条消息按 transcript 路径缓存: 会话的第一条用户消息不会变, 文件级 LRU 足够,
// 不用每张卡都读一次盘。
import { closeSync, openSync, readSync } from "node:fs";
import { tagOfKey } from "../shared/session-label.js";

const HEAD_BYTES = 32 * 1024;
const NAME_MAX = 12; // main_title 一行 13 字, 名字之外还要放 emoji 和 toolName

const readHead = (path: string): string => {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString("utf8", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

// 与 hook 的 transcript_tail 提取同一套噪声过滤: 剥掉 Claude Code 注入的包裹标签。
const WRAPPER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>|<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>|<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g;

const firstUserText = (path: string): string => {
  for (const line of readHead(path).split("\n")) {
    if (!line.includes('"user"')) continue; // 便宜的预过滤, 大部分行不用 parse
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "user" || row.isMeta === true) continue;
    const msg = row.message as { content?: unknown } | undefined;
    const c = msg?.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.filter((b): b is { type: string; text: string } =>
            Boolean(b) && (b as { type?: string }).type === "text",
          ).map((b) => b.text).join(" ")
        : "";
    const clean = text.replace(WRAPPER_RE, "").replace(/\s+/g, " ").trim();
    if (clean) return clean;
  }
  return "";
};

const cache = new Map<string, string>(); // transcriptPath → first user text (原文, 截断在出口做)
const CACHE_MAX = 300;

const firstUserTextCached = (path: string): string => {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const v = firstUserText(path);
  // 空串也缓存 — 空会话反复读盘毫无意义; 会话有了首条消息后 jsonl 路径不变,
  // 但那时早过了发卡时点, 下一张卡再读一次的成本可接受: 空串不缓存即可。
  if (v) {
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(path, v);
  }
  return v;
};

const TRUNC = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 会话名: #tag > transcript 首条用户消息首句 > sessionId 尾八位。 */
export const sessionNameFor = (
  chatKey: string | undefined,
  transcriptPath: string | undefined,
  sessionId: string | undefined,
): string => {
  const tag = chatKey ? tagOfKey(chatKey) : "";
  if (tag) return `#${TRUNC(tag, NAME_MAX)}`;
  if (transcriptPath) {
    const t = firstUserTextCached(transcriptPath);
    if (t) return TRUNC(t, NAME_MAX);
  }
  return sessionId ? sessionId.slice(-8) : "";
};
