// Declarative config: schema (zod) + loader. Pure transforms, file IO at boundary.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { expandHome } from "./paths.js";

// ── Schema ──────────────────────────────────────────────────────────
const Bot = z.object({
  botId: z.string().min(1),
  secret: z.string().min(1),
  websocketUrl: z.string().url().default("wss://openws.work.weixin.qq.com"),
});

const Daemon = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(17890),
  stateDir: z.string().default("~/.weclaude/state"),
  logFile: z.string().default("~/.weclaude/daemon.log"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  // 工具调用 / 授权详情页 URL。空则用 http://<host>:<port> (回环)。
  // 想让手机 WeCom 也能点开, 需要在反向代理后填外网地址。桌面端用回环即可。
  detailPublicBase: z.string().default(""),
  // 远端 detail svr (weclaude svr 起的独立服务, chat + cli 共同可达的网络里)。
  // 空则不转发, 详情走本机 :port/detail。非空时:
  //   • 每次 record*() 后 fire-and-forget POST 到 <base>/d, 存到远端 store。
  //   • buildDetailUrl 用 <base> 作为链接根 (chat 端浏览器打开 <base>/detail?id=...)。
  // 用这条路径解决 daemon (公司内网) 和 chat 用户 (移动网络) 不同网段的场景。
  detailRemoteBase: z.string().default(""),
  detailRemoteToken: z.string().default(""),
  // 镜像消息里给每个 tool_use 行包成 markdown 链接, 点开本地 HTML 详情页。
  detailLinksInMirror: z.boolean().default(true),
});

const Mirror = z.object({
  // Where Claude Code writes per-project transcripts. Forks like `claude-internal`
  // use a parallel dir (e.g. `~/.claude-internal/projects`). The mirror tails
  // `<projectsDir>/<encoded(wrc.cwd)>/<sid>.jsonl`. Empty → auto-derive from
  // `wrc.claudeBin` basename (handled by the Wrc transform below): `claude` →
  // `~/.claude/projects`, `claude-internal` → `~/.claude-internal/projects`.
  projectsDir: z.string().default(""),
  // Pin a specific Claude session to mirror. Empty → auto-pick latest .jsonl
  // under `<projectsDir>/<encoded(wrc.cwd)>/` by mtime.
  sessionId: z.string().default(""),
  // Where to push live assistant output. Empty → fall back to defaultChat.
  pushChat: z.string().default(""),
  // Cap a single push payload (WeCom markdown ~2048 limit). Long replies are split.
  chunkChars: z.number().int().positive().default(1800),
  // Mirror the user's CLI prompts (type:"user" with string content). Off by
  // default: WeCom-sourced inbounds get dedup'd anyway, and local CLI typing
  // is rare in the bot-driven flow — keeping it on mostly produced echo noise.
  includeUser: z.boolean().default(false),
  // Mirror assistant tool_use blocks (Bash/Edit/Read/...).
  includeTools: z.boolean().default(true),
  // Mirror tool_result blocks. Off by default — usually noisy.
  includeToolResults: z.boolean().default(false),
  // Truncate each tool_result body to this many chars.
  toolResultMaxChars: z.number().int().positive().default(400),
  // 工具调用气泡里 `compact` 一行的最大字符数 (`🔧 Name <compact>` / `[• compact](url)`).
  // 旧值 40 太窄, 长 bash / 长 file_path 直接被截掉; 抬到 120 兼顾可读与单行。
  toolUseInlineMaxChars: z.number().int().positive().default(120),
  // Where inbound images/files from WeCom get saved before being pasted into
  // the live TTY. Files persist — claude reads them by absolute path.
  inboxDir: z.string().default("~/.weclaude/inbox"),
  // Persisted mirror attachments (principal → sessionId/jsonl/tmux). Restored
  // on daemon boot + lazily on first inbound after reload — so reloading the
  // daemon doesn't re-spawn a fresh claude for an already-bound chat.
  attachmentsFile: z.string().default("~/.weclaude/mirror-attachments.json"),
  // Standalone fallback 路径(liveStream 已 closed/dead/capped) 上的防抖聚合窗口
  // (ms)。窗口内同一 attachment 的多个 item 合并为一条 markdown, 抑制连续工具
  // 调用刷屏。liveStream 仍活时不受影响——直接走 typewriter。0 = 关闭。
  standaloneDebounceMs: z.number().int().nonnegative().default(3000),
  // dispatch 后延迟开 stream 的窗口 (ms)。窗口内 item 累积:
  //   • 出现 needs-approval tool_use → 立刻把 buffer 聚合成单条 standalone 推出 (赶在
  //     授权卡之前), 切到 AWAITING_APPR 等点击; 点击后再开 stream 续 tool_result+回复。
  //   • 窗口内 turn_end (纯文本快回复) → buffer 整体作为一条 standalone, 不开 stream。
  //   • 窗口超时 → 正常开 stream, 重放 buffer。
  // 0 = 关闭, 退回到 dispatch 立即 ack "…" 的旧行为。
  outboundDeferMs: z.number().int().nonnegative().default(3000),
  // 发卡前等待目标 tool_use 在 jsonl 落盘的最长 poll 时间 (ms)。Claude Code 的
  // assistant 行写盘相对 PreToolUse hook fire 有 tens-to-hundreds ms 异步抖动,
  // 没等到的话 drain 抓空, 卡先到、思考过程后到。轮询步进 50ms。0 = 关闭等待,
  // 仅做一次同步 drain (旧行为)。
  flushBeforeCardWaitMs: z.number().int().nonnegative().default(800),
  // 发卡前从活着的 tmux pane 抠出「为什么发这张卡」的 assistant 前言并先推一条。
  // 必要性: Claude Code 把以 tool_use 收尾的整个 turn 攒着, 等工具 resolve 才 flush
  // 到 jsonl —— 而工具正卡在这张授权卡上, 于是前言在发卡时点既不在 jsonl 也不在
  // hook 的 transcript_tail 里, 唯一存在处是 pane。抠不到时静默退回「只发卡」(无回归)。
  panePreamble: z.boolean().default(true),
  // Brief 模式: 只对 mirror 模式生效。一个 turn 里群里只发两条 —
  //   1. turn 起始时:「🧵 [本轮详情](url)」链接 (指向聚合详情页,含所有 tool 输入/输出+中间文本+折叠展示)
  //   2. turn 结束时: Claude 的 finish text (最终 assistant 回复)
  // 中间 tool_use / tool_result / thinking / 非 final text 全部只写进详情页,不发气泡。
  // 授权卡照常发群 (交互无法替代)。false = 现状 (逐条气泡)。
  brief: z.boolean().default(true),
});

const Wrc = z.object({
  allowFrom: z.array(z.string()).default([]),
  mode: z.enum(["headless", "mirror"]).default("headless"),
  claudeBin: z.string().default("claude"),
  cwd: z.string().default("~/.weclaude/workspace"),
  sessionMapFile: z.string().default("~/.weclaude/sessions.json"),
  extraArgs: z.array(z.string()).default([]),
  mirror: Mirror.default({}),
  // Mirror-only: tmux session name prefix for auto-spawn. Final name is
  // `${prefix}-<short>`. Auto-spawn fires when an authorized inbound finds no
  // mirror attached for that chat — allowFrom IS the authorization.
  tmuxPrefix: z.string().default("weclaude"),
}).transform((v) => {
  // Auto-derive projectsDir from claudeBin basename when not explicitly set.
  // `claude` → `~/.claude/projects`, `claude-internal` → `~/.claude-internal/projects`.
  // Without this, a user running claude-internal sees the daemon tailing the
  // wrong dir → pane→chat silently drops every reply.
  if (!v.mirror.projectsDir) {
    const name = v.claudeBin.split("/").pop() || "claude";
    v.mirror.projectsDir = `~/.${name}/projects`;
  }
  return v;
});

const Approval = z.object({
  enabled: z.boolean().default(true),
  matcher: z.string().default(".*"),
  approvers: z.array(z.string()).default([]),
  hookTimeoutSec: z.number().int().positive().default(43210),
  longPollSec: z.number().int().positive().default(43200),
  sessionCacheMinutes: z.number().int().nonnegative().default(30),
  windowMinutes: z.number().int().nonnegative().default(600),
  sensitiveArgRedact: z.boolean().default(true),
  fallbackOnError: z.enum(["ask", "allow", "deny"]).default("ask"),
  // 同 session 同 tool 的并发 PreToolUse 合流窗口: 第一次到达后等待这么久,
  // 期间到的同类请求合成一张批量卡 (减少 N 张并发卡的轰炸)。0 = 关闭聚合,
  // 每次立刻发卡 (旧行为)。单次到达走单卡路径, 仅多了一次性的延迟。
  batchCoalesceMs: z.number().int().nonnegative().default(250),
  // 拦截 model 主动调用的 EnterPlanMode (deny + reason),让 Claude 不要自动进
  // plan mode、直接干活。用户仍可在本地 Shift+Tab 手动进 plan mode(那条路径
  // 不过 hook)。默认 true。设 false 恢复原行为(允许模型自动进 plan mode)。
  blockAutoPlanMode: z.boolean().default(true),
  // Claude-Code 风格的放行规则 (语法子集见 daemon/allow-rules.ts): 命中的调用
  // 跳过发卡直接 allow。例:
  //   "Bash(git log *)"  "Bash(python3 .claude/skills/*)"  "mcp__server__tool"
  // matcher 决定哪些工具进入审批, allowRules 在其中再挖细粒度豁免 (对 Bash 可
  // 按命令前缀区分, matcher 做不到)。默认空 = 不豁免。
  allowRules: z.array(z.string()).default([]),
});

const SyncTarget = z.object({
  // 仅作为 sync 日志里的标签使用; 真正决定写入位置的是 settingsPath。
  // 留成自由字符串以兼容 claude / claude-internal / custom 等任何 fork。
  kind: z.string().default("claude"),
  settingsPath: z.string(),
  scope: z.enum(["user", "project", "local"]).default("user"),
});
const Sync = z.object({
  targets: z.array(SyncTarget).default([]),
});

// 独立 detail 中转服务 (weclaude svr) 的默认参数。CLI 参数 (--host/--port/…) 仍可覆盖,
// 空则退回硬编码默认 (0.0.0.0:17891)。放在 top-level 而不是塞进 daemon: svr 是独立进程,
// 与 daemon 生命周期解耦。
const Svr = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().min(1).max(65535).default(17891),
  stateDir: z.string().default("~/.weclaude/svr"),
  tokenFile: z.string().default("~/.weclaude/svr-token"),
  token: z.string().default(""),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
});

// 事件订阅 / 广播。subs 是 topic → 目标id数组 (`user:xxx` / `chat:xxx`),
// 一个 topic 可以有多个订阅者; schedules 是「每天 HH:MM 触发某 topic」的定时任务。
// 订阅关系与定时通过 IM 命令 (订阅 / 每天HH:MM广播 …) 增删,写回 config.jsonc。
const Schedule = z.object({
  topic: z.string(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  content: z.string(),
  createdBy: z.string().default(""),
  createdAt: z.number().default(0),
});
const Topics = z.object({
  subs: z.record(z.string(), z.array(z.string())).default({}),
  schedules: z.array(Schedule).default([]),
});

export const ConfigSchema = z.object({
  bot: Bot,
  defaultChat: z.string().default(""),
  daemon: Daemon.default({}),
  wrc: Wrc.default({}),
  approval: Approval.default({}),
  sync: Sync.default({ targets: [] }),
  svr: Svr.default({}),
  topics: Topics.default({ subs: {}, schedules: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────
const DEFAULT_CONFIG_PATHS = [
  "~/.weclaude/config.jsonc",
  "~/.weclaude/config.json",
];
const SECRETS_PATH = "~/.weclaude/secrets.json";

const readJsoncIfExists = (p: string): unknown | undefined => {
  const abs = expandHome(p);
  if (!existsSync(abs)) return undefined;
  const text = readFileSync(abs, "utf8");
  return parseJsonc(text);
};

const deepMerge = <T extends Record<string, unknown>>(a: T, b: Partial<T>): T => {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    const av = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && av && typeof av === "object" && !Array.isArray(av)) {
      out[k] = deepMerge(av as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined && v !== "") {
      out[k] = v;
    }
  }
  return out as T;
};

/** Resolve config path: explicit > $WECLAUDE_CONFIG > defaults. */
const resolveConfigPath = (explicit?: string): string | undefined => {
  if (explicit) return explicit;
  if (process.env.WECLAUDE_CONFIG) return process.env.WECLAUDE_CONFIG;
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (existsSync(expandHome(p))) return p;
  }
  return undefined;
};

export interface LoadResult {
  config: Config;
  sourcePath: string;
}

export const loadConfig = (explicitPath?: string): LoadResult => {
  const sourcePath = resolveConfigPath(explicitPath);
  if (!sourcePath) {
    throw new Error(
      `weclaude config not found. Create ~/.weclaude/config.jsonc (see config.example.jsonc) or set $WECLAUDE_CONFIG.`,
    );
  }
  const base = (readJsoncIfExists(sourcePath) ?? {}) as Record<string, unknown>;
  const secrets = (readJsoncIfExists(SECRETS_PATH) ?? {}) as Record<string, unknown>;
  const merged = deepMerge(base, secrets);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`weclaude config invalid (${sourcePath}):\n${issues}`);
  }
  return { config: parsed.data, sourcePath: expandHome(sourcePath) };
};
