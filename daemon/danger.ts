// 危险操作名单。命中者 **必须逐次单独审批**:
//   · 不吃 auto-window (approval.windowMinutes 的「N 分钟全过」)
//   · 不吃 session cache (同参数重复调用也要再点一次)
//   · 不参与批量合流 (永远独占一张卡, 不会被 ×N 聚合掉)
//   · 卡上没有「全过」按钮, 只有 ✅ / ❌
//   · fallbackOnError=allow 时降级为 ask (超时/断线不静默放行危险操作)
// 纯函数, 只做匹配; 所有副作用留在 approval.ts。
import type { Config } from "../shared/config.js";

export interface DangerHit {
  /** 人类可读的规则名, 直接渲染到卡片上 — 用户要知道「哪一条」判定它危险。 */
  rule: string;
}

type Rule = readonly [label: string, re: RegExp];

// ── 内置命令名单 (Bash / 任何带 command 的工具) ────────────────────────
const CMD_RULES: readonly Rule[] = [
  ["删除文件 rm", /\brm\b/],
  ["删除目录 rmdir", /\brmdir\b/],
  ["批量删除 find -delete", /\bfind\b[\s\S]*(-delete|-exec\s+rm)\b/],
  ["管道删除 xargs rm", /\bxargs\b[\s\S]*\brm\b/],
  ["清空文件 truncate", /\btruncate\b/],
  ["裸设备写入 dd", /\bdd\s+(if|of)=/],
  ["格式化 mkfs", /\bmkfs\b|\bdiskutil\s+(erase|partition)/],
  ["重定向到设备", />\s*\/dev\/(?!null\b|stdout\b|stderr\b)/],
  ["提权 sudo", /\bsudo\b|\bsu\s+-/],
  ["递归改权限", /\bch(mod|own)\b[\s\S]*(-R|\b777\b)/],
  ["强制杀进程", /\bkill\s+-9\b|\bkillall\b|\bpkill\b/],
  ["关机/重启", /\b(shutdown|reboot|halt|poweroff)\b/],
  ["服务停用", /\blaunchctl\s+(unload|bootout|remove)\b|\bsystemctl\s+(stop|disable|mask)\b/],
  ["git 强推", /\bgit\b[\s\S]*\bpush\b[\s\S]*(--force|-f\b)/],
  ["git 丢弃改动", /\bgit\s+(reset\s+--hard|clean\b|checkout\s+--\s|restore\b)/],
  ["git 删分支", /\bgit\s+branch\s+-D\b|\bgit\s+push\b[\s\S]*--delete\b/],
  ["发布包", /\bnpm\s+(publish|unpublish)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/],
  ["容器删除", /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|compose\s+down)\b/],
  ["k8s 删除", /\bkubectl\s+delete\b/],
  ["基础设施销毁", /\bterraform\s+destroy\b/],
  ["云资源删除", /\baws\s+[\s\S]*\b(rm|rb|delete-|terminate-)|\bgcloud\s+[\s\S]*\bdelete\b/],
  ["GitHub 删除", /\bgh\s+(repo|release|secret|ssh-key)\s+delete\b/],
  ["数据库 DROP/TRUNCATE", /\b(drop|truncate)\s+(table|database|schema|index)\b/i],
  ["无条件 DELETE", /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i],
  ["Redis 清库", /\bflush(all|db)\b/i],
  ["下载即执行", /\b(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(ba)?sh\b/],
  ["fork 炸弹", /:\(\)\s*\{.*\|.*&.*\}/],
  ["清历史", /\bhistory\s+-c\b|\bdefaults\s+delete\b/],
];

// ── 内置工具名名单 (MCP / 内置工具, 按名字判定) ────────────────────────
const TOOL_RULES: readonly Rule[] = [
  ["删除类工具", /(^|_|__|\b)(delete|remove|destroy|drop|purge|revoke|uninstall)/i],
];

// ── 内置敏感路径名单 (任何工具的任意字符串入参) ────────────────────────
const PATH_RULES: readonly Rule[] = [
  ["SSH 密钥", /(^|\/)\.ssh\/|id_(rsa|ed25519|ecdsa)\b|authorized_keys\b/],
  ["凭据文件", /(^|\/)\.(env|npmrc|netrc|aws|gnupg)\b|credentials\b|secrets?\.(json|ya?ml|env)\b/],
  ["系统目录", /^\/(etc|System|Library\/LaunchDaemons|usr\/bin|bin|sbin)\//],
  ["家目录根/根目录", /^\s*(~|\/|\$HOME)\/?\s*$/],
];

const compile = (sources: readonly string[]): Rule[] =>
  sources.flatMap((s) => {
    try {
      return [[`自定义:${s}`, new RegExp(s, "i")] as Rule];
    } catch {
      return []; // 坏正则不应该让整条审批链挂掉
    }
  });

const firstHit = (rules: readonly Rule[], text: string): DangerHit | undefined => {
  const hit = rules.find(([, re]) => re.test(text));
  return hit ? { rule: hit[0] } : undefined;
};

// 递归收集入参里的字符串叶子 (深度/数量有界 — 入参可能很大)。
const MAX_NODES = 200;
const strings = (v: unknown, depth = 0, acc: string[] = []): string[] => {
  if (acc.length >= MAX_NODES || depth > 4) return acc;
  if (typeof v === "string") { acc.push(v); return acc; }
  if (Array.isArray(v)) { v.forEach((x) => strings(x, depth + 1, acc)); return acc; }
  if (v && typeof v === "object") {
    Object.values(v as Record<string, unknown>).forEach((x) => strings(x, depth + 1, acc));
  }
  return acc;
};

// command 类入参: Bash.command, 以及任何叫 command/script/cmd 的字段。
const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);
const commandsOf = (input: unknown): string[] => {
  if (!input || typeof input !== "object") return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([k, v]) => COMMAND_KEYS.has(k) && typeof v === "string")
    .map(([, v]) => v as string);
};

// 路径类入参: 只看看起来像路径的字符串, 避免拿正文去撞路径规则。
const pathish = (s: string): boolean => s.length < 512 && /^[~$/.]|\//.test(s);

/**
 * danger 模式下这次调用是否可以免卡直接放行。
 * 名单关掉时不生效 (退回全量审批) —— 「模式=danger + 名单=off」不该等于全放行。
 */
export const dangerModeSkips = (cfg: Config, hit: DangerHit | undefined): boolean =>
  cfg.approval.mode === "danger" && cfg.approval.danger.enabled && !hit;

/** danger.skip: 命中危险名单也免卡直接放行 (显式的「跳过 danger」)。 */
export const dangerSkips = (cfg: Config, hit: DangerHit | undefined): boolean =>
  !!hit && cfg.approval.danger.skip;

/** 判定一次工具调用是否落在危险名单里。undefined = 安全。 */
export const dangerOf = (cfg: Config, toolName: string, toolInput: unknown): DangerHit | undefined => {
  const d = cfg.approval.danger;
  if (!d.enabled) return undefined;

  const cmds = commandsOf(toolInput);
  const allow = compile(d.allowPatterns);
  // 白名单优先: 任一命令被豁免则整条调用豁免 (显式覆盖内置的宽规则)。
  if (allow.length > 0 && [toolName, ...cmds].some((t) => firstHit(allow, t))) return undefined;

  const cmdRules = [...(d.builtin ? CMD_RULES : []), ...compile(d.commandPatterns)];
  const toolRules = [...(d.builtin ? TOOL_RULES : []), ...compile(d.toolPatterns)];
  const pathRules = [...(d.builtin ? PATH_RULES : []), ...compile(d.pathPatterns)];

  return (
    firstHit(toolRules, toolName) ??
    cmds.reduce<DangerHit | undefined>((acc, c) => acc ?? firstHit(cmdRules, c), undefined) ??
    strings(toolInput).filter(pathish).reduce<DangerHit | undefined>(
      (acc, s) => acc ?? firstHit(pathRules, s),
      undefined,
    )
  );
};
