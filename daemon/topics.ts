// 事件订阅 / 广播 / 定时。IM 命令解析 + 订阅表 CRUD + 每日定时调度。
// 订阅关系与调度写回 config.jsonc(`topics.subs` / `topics.schedules`),loadConfig
// 每次读盘,daemon 内 cfg 用 in-place 变更保持同步。
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";
import { withTagHeader } from "../shared/session-label.js";

const stripPrefix = (s: string): string => {
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
};

// Topic name 允许中文/字母数字/`-`/`_`/`.`,不允许空白。剥离外层引号(中英文单双)。
const stripQuotes = (s: string): string =>
  s.trim().replace(/^[\s'"‘’“”`]+|[\s'"‘’“”`]+$/gu, "");

const normTopic = (raw: string): string => stripQuotes(raw);

// ── 订阅表 ────────────────────────────────────────────────────────
export const subscribe = (
  cfg: Config,
  sourcePath: string,
  topic: string,
  target: string,
): { added: boolean } => {
  const t = normTopic(topic);
  if (!t) return { added: false };
  const arr = cfg.topics.subs[t] ? cfg.topics.subs[t]!.slice() : [];
  if (arr.includes(target)) return { added: false };
  arr.push(target);
  cfg.topics.subs[t] = arr;
  patchJsonc(sourcePath, [{ path: ["topics", "subs", t], value: arr }]);
  return { added: true };
};

export const unsubscribe = (
  cfg: Config,
  sourcePath: string,
  topic: string,
  target: string,
): { removed: boolean } => {
  const t = normTopic(topic);
  const arr = cfg.topics.subs[t] ?? [];
  const next = arr.filter((x) => x !== target);
  if (next.length === arr.length) return { removed: false };
  cfg.topics.subs[t] = next;
  patchJsonc(sourcePath, [{ path: ["topics", "subs", t], value: next }]);
  return { removed: true };
};

export const listSubs = (cfg: Config, target?: string): Array<{ topic: string; targets: string[] }> => {
  const entries = Object.entries(cfg.topics.subs);
  const filtered = target ? entries.filter(([, subs]) => subs.includes(target)) : entries;
  return filtered.map(([topic, targets]) => ({ topic, targets: targets.slice() }));
};

// ── 定时任务 ──────────────────────────────────────────────────────
export interface Schedule {
  topic: string;
  hour: number;
  minute: number;
  content: string;
  createdBy: string;
  createdAt: number;
}

const persistSchedules = (cfg: Config, sourcePath: string): void => {
  patchJsonc(sourcePath, [{ path: ["topics", "schedules"], value: cfg.topics.schedules }]);
};

export const addSchedule = (cfg: Config, sourcePath: string, s: Schedule): void => {
  cfg.topics.schedules.push(s);
  persistSchedules(cfg, sourcePath);
};

export const removeSchedulesByTopic = (
  cfg: Config,
  sourcePath: string,
  topic: string,
): number => {
  const t = normTopic(topic);
  const before = cfg.topics.schedules.length;
  cfg.topics.schedules = cfg.topics.schedules.filter((s) => s.topic !== t);
  const removed = before - cfg.topics.schedules.length;
  if (removed > 0) persistSchedules(cfg, sourcePath);
  return removed;
};

export const listSchedules = (cfg: Config, topic?: string): Schedule[] => {
  const t = topic ? normTopic(topic) : undefined;
  return t ? cfg.topics.schedules.filter((s) => s.topic === t) : cfg.topics.schedules.slice();
};

// ── 发布 ──────────────────────────────────────────────────────────
export interface PublishResult {
  topic: string;
  sent: number;
  failed: number;
  subs: string[];
}

export const publish = async (
  client: WSClient,
  cfg: Config,
  log: Logger,
  topic: string,
  content: string,
): Promise<PublishResult> => {
  const t = normTopic(topic);
  const subs = (cfg.topics.subs[t] ?? []).slice();
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      // 订阅者 key 可能带 `#tag` (订阅是按会话 key 记的) —— 广播落到该会话的
      // 视觉通道里, 与该会话的其它气泡一致。
      await client.sendMessage(stripPrefix(s), {
        msgtype: "markdown",
        markdown: { content: withTagHeader(s, content) },
      });
      sent++;
    } catch (e) {
      failed++;
      log.warn({ topic: t, target: s, err: (e as Error).message }, "publish target failed");
    }
  }
  log.info({ topic: t, subs: subs.length, sent, failed }, "publish");
  return { topic: t, sent, failed, subs };
};

// ── 调度器 ────────────────────────────────────────────────────────
// 每 20s 检查一次(足够密以捕获整分钟翻转);同一 (day,hour,minute) 在进程生命周期
// 内只触发一次(lastKey 去重),避免同分钟内多 tick 造成重复推送。
interface SchedulerDeps {
  client: WSClient;
  cfg: Config;
  log: Logger;
}

export const startScheduler = ({ client, cfg, log }: SchedulerDeps): { stop: () => void } => {
  let lastKey = "";
  const tick = async (): Promise<void> => {
    if (!client.isConnected) return;
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (key === lastKey) return;
    lastKey = key;
    const h = now.getHours();
    const m = now.getMinutes();
    const due = cfg.topics.schedules.filter((s) => s.hour === h && s.minute === m);
    for (const s of due) {
      try {
        await publish(client, cfg, log, s.topic, s.content);
      } catch (e) {
        log.error({ topic: s.topic, err: (e as Error).message }, "scheduled publish failed");
      }
    }
  };
  const timer = setInterval(() => { void tick(); }, 20_000);
  return { stop: () => clearInterval(timer) };
};

// ── 命令解析 ──────────────────────────────────────────────────────
// 所有解析函数都是 pure — 输入 raw text,输出结构化命令或 undefined。
// 中文引号、半角引号、反引号、混合空白都能容忍。

// "订阅 sync-daily" | "订阅'sync-daily'" | "subscribe sync-daily"
export const parseSubscribe = (text: string): { topic: string } | undefined => {
  const m = /^(?:订阅|subscribe|sub)\s*(.+)$/iu.exec(text.trim());
  const raw = m?.[1];
  if (!raw) return undefined;
  const topic = normTopic(raw);
  return topic ? { topic } : undefined;
};

// "退订 sync-daily" | "取消订阅 sync-daily" | "unsubscribe sync-daily"
export const parseUnsubscribe = (text: string): { topic: string } | undefined => {
  const m = /^(?:退订|取消订阅|unsubscribe|unsub)\s*(.+)$/iu.exec(text.trim());
  const raw = m?.[1];
  if (!raw) return undefined;
  const topic = normTopic(raw);
  return topic ? { topic } : undefined;
};

// "广播 sync-daily 内容:xxx" — topic 与 content 之间用空白分隔
// 也支持 topic 被引号包裹: "广播 'sync-daily' 内容:xxx"
export const parseBroadcast = (
  text: string,
): { topic: string; content: string } | undefined => {
  const m = /^(?:广播|broadcast|pub|publish)\s+(['"‘’“”`]?[^\s'"‘’“”`]+['"‘’“”`]?)\s+([\s\S]+)$/iu.exec(text.trim());
  const rawTopic = m?.[1];
  const rawContent = m?.[2];
  if (!rawTopic || !rawContent) return undefined;
  const topic = normTopic(rawTopic);
  const content = rawContent.trim();
  if (!topic || !content) return undefined;
  return { topic, content };
};

// 每天定时。宽松匹配以下几种自然写法:
//   每天 08:00 广播 sync-daily 内容:xxx
//   每天8点广播 sync-daily 内容:xxx
//   每天8点30广播 sync-daily 内容:xxx
//   每天 8:30 广播 'sync-daily' 内容:xxx
//   每日 08:00 广播 …
export const parseDailySchedule = (
  text: string,
): { hour: number; minute: number; topic: string; content: string } | undefined => {
  const re = /^(?:每天|每日|daily)\s*(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(\d{1,2})?\s*(?:分)?|时\s*(\d{1,2})?\s*(?:分)?)?\s*(?:广播|broadcast|pub|publish)\s+(['"‘’“”`]?[^\s'"‘’“”`]+['"‘’“”`]?)\s+([\s\S]+)$/iu;
  const m = re.exec(text.trim());
  if (!m) return undefined;
  const rawHour = m[1];
  const rawTopic = m[5];
  const rawContent = m[6];
  if (!rawHour || !rawTopic || !rawContent) return undefined;
  const hour = parseInt(rawHour, 10);
  const minute = parseInt(m[2] ?? m[3] ?? m[4] ?? "0", 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const topic = normTopic(rawTopic);
  const content = rawContent.trim();
  if (!topic || !content) return undefined;
  return { hour, minute, topic, content };
};

// 只读命令
export const isListSchedules = (text: string): boolean =>
  /^(?:广播列表|定时列表|schedules?|list\s+schedules?)$/iu.test(text.trim());

export const isListSubs = (text: string): boolean =>
  /^(?:订阅列表|subs?|list\s+subs?|subscriptions?)$/iu.test(text.trim());

// "取消广播 sync-daily" | "删除广播 sync-daily"
export const parseCancelSchedule = (text: string): { topic: string } | undefined => {
  const m = /^(?:取消广播|删除广播|cancel\s+broadcast)\s*(.+)$/iu.exec(text.trim());
  const raw = m?.[1];
  if (!raw) return undefined;
  const topic = normTopic(raw);
  return topic ? { topic } : undefined;
};

// ── 渲染 ──────────────────────────────────────────────────────────
const pad2 = (n: number): string => String(n).padStart(2, "0");

export const renderSubs = (cfg: Config, target: string): string => {
  const mine = listSubs(cfg, target);
  if (mine.length === 0) return "本会话未订阅任何 topic。使用 `订阅 <topic>` 来订阅。";
  const lines = mine.map(({ topic, targets }) => `- \`${topic}\` (${targets.length} 订阅者)`);
  return [`本会话订阅列表:`, ...lines].join("\n");
};

export const renderSchedules = (cfg: Config, topic?: string): string => {
  const list = listSchedules(cfg, topic);
  if (list.length === 0) return topic ? `topic \`${topic}\` 无定时任务` : "无任何定时广播";
  const lines = list.map(
    (s) => `- 每天 ${pad2(s.hour)}:${pad2(s.minute)} → \`${s.topic}\` (创建者 \`${s.createdBy || "?"}\`)`,
  );
  return ["定时广播:", ...lines].join("\n");
};
