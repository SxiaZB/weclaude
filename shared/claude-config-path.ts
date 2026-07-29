// 判定一次工具调用会不会**写到 `.claude/` 配置面**。
//
// 为什么需要: 改动 `.claude/**`(settings.json / hooks / skills / commands /
// agents …) 会让 Claude Code 立起它自己的「允许 Claude 改自己的配置」原生确认框。
// 那个框**不经过 PreToolUse hook** —— hook 返回 allow 豁免不掉, `permissions.allow`
// 也覆盖不到(设计如此: hook 与 settings 本身就是权限边界, 若能被 hook 放行,
// 一次 prompt injection 改写它们就等于提权闭环)。对 weclaude 的后果是致命的:
// 规则判 allow → 不发卡 → 企微侧零感知 → pane 无限期阻塞。
//
// 2026-07-28 实测(daemon.log:5840 + transcript e1bad394):
// `mkdir -p x/.claude/skills && ls -a x` 被 `Bash(mkdir *) + Bash(ls *)` 放行、
// 没发卡, pane 上照样立起 "Do you want to proceed?", 卡死 3 分钟直到 /stop。
//
// 已知盲点: 解释器间接写入(`python3 gen.py` 内部往 `.claude/` 写文件)看不出来 ——
// 字面判定拿不到运行时行为。那类调用退回旧行为(可能死锁), 不做猜测式拦截。
//
// 纯函数, 无 IO —— daemon 决策与单测共用。
import { splitSegments } from "./allow-rules.js";

export interface ClaudeConfigHit {
  /** 命中的路径原文(已去引号), 用于日志与告知模型。 */
  path: string;
  /** file = 文件类工具的 file_path; bash-write = Bash 段里的写命令/重定向。 */
  why: "file" | "bash-write";
}

/** 文件类工具: 直接看 file_path / notebook_path。 */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// 会落地改动的命令头(basename 比较, 覆盖 `/bin/mkdir` 这类绝对路径写法)。
// 只读命令(cat/ls/grep/readlink…)故意不在列: 读 `.claude/` 不触发那个框, 拦了纯属误伤。
const WRITE_HEADS = new Set([
  "mkdir", "rmdir", "rm", "ln", "cp", "mv", "touch", "tee", "install",
  "rsync", "truncate", "chmod", "chown", "dd", "unzip", "tar", "mktemp",
]);

const unquote = (tok: string): string => tok.replace(/^['"]|['"]$/g, "");

/** 路径里是否有 `.claude` 这一段 —— `~/.claude/x`、`a/.claude`、裸 `.claude` 都算。 */
export const isClaudeConfigPath = (raw: string): boolean => {
  const p = unquote(raw.trim());
  if (!p) return false;
  return p.split("/").some((seg) => seg === ".claude");
};

const bashHit = (command: string): ClaudeConfigHit | undefined => {
  // 引号感知切分失败(未闭合引号/孤立 &) → 整条当一段看, fail-closed 宁可多发卡。
  const segments = splitSegments(command) ?? [command];
  for (const seg of segments) {
    const toks = seg.trim().split(/\s+/u).filter(Boolean);
    if (toks.length === 0) continue;
    const hitTok = toks.find((t) => isClaudeConfigPath(t));
    if (!hitTok) continue;
    const head = (unquote(toks[0]!).split("/").pop() ?? "").trim();
    // 重定向写入(`echo x > ~/.claude/y`)与写命令同等对待; 命令头本身不必是写命令。
    const redirects = /[^0-9<>]?>{1,2}/u.test(seg);
    if (WRITE_HEADS.has(head) || redirects) return { path: unquote(hitTok), why: "bash-write" };
    // `sed -i` 原地改写; 不带 -i 的 sed 只是读。
    if (head === "sed" && toks.some((t) => t === "-i" || t.startsWith("-i"))) {
      return { path: unquote(hitTok), why: "bash-write" };
    }
  }
  return undefined;
};

/**
 * 命中返回 hit 详情, 未命中返回 undefined。
 * Bash 逐段判定(复合命令里任一段写 `.claude/` 就算), 文件类工具看 file_path。
 */
export const claudeConfigWrite = (
  toolName: string,
  toolInput: unknown,
): ClaudeConfigHit | undefined => {
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : undefined;
  if (!input) return undefined;

  if (FILE_TOOLS.has(toolName)) {
    const p = [input.file_path, input.notebook_path].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return p && isClaudeConfigPath(p) ? { path: p, why: "file" } : undefined;
  }

  if (toolName === "Bash" || toolName === "Shell") {
    const cmd = input.command;
    if (typeof cmd !== "string" || !cmd.trim()) return undefined;
    return bashHit(cmd);
  }

  return undefined;
};
