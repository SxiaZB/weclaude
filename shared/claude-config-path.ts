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
// 字面变量间接(`f=~/.claude/x; rm $f`)不在盲点内: 值就在命令里, 展开一层再判。
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

// 变量间接: `f=~/.claude/settings.json; rm $f` —— 写命令那一段没有字面 `.claude`,
// 纯字面逐段判定看不见它。但赋值的值就摆在同一条命令里, 展开一次就能看见。
// (允许规则侧的纯赋值段是"无害段跳过"的, 所以这条命令能被 `Bash(rm *)` 放行 ——
// 不在这里展开, 就正好是本文件开头说的那种"不发卡 + pane 阻塞"静默死锁。)
// 只收「段首赋值」(可带 export/local 等声明头), 且值必须是字面量: `f=$(…)`
// 这类动态值收不到, 仍属开头记录的解释器/运行时盲点, 不做猜测。
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;
const DECL_HEADS = new Set(["export", "local", "declare", "readonly", "typeset"]);
const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu;

/** 把段首赋值记进变量表 (就地写入 —— 逐段推进时后面的段才能用上前面的赋值)。 */
const recordAssignments = (toks: string[], vars: Map<string, string>): void => {
  const start = DECL_HEADS.has(unquote(toks[0] ?? "")) ? 1 : 0;
  for (let i = start; i < toks.length; i++) {
    const m = ASSIGN_RE.exec(toks[i]!);
    if (!m) break; // 段首赋值前缀到此为止, 后面是命令本体
    vars.set(m[1]!, unquote(m[2]!));
  }
};

/** `$f` / `${f}` 展开一层; 表里没有的变量 (如 $HOME) 原样留着继续参与路径判定。 */
const expandVars = (tok: string, vars: Map<string, string>): string =>
  vars.size === 0 ? tok : tok.replace(VAR_REF_RE, (whole, braced, bare) => vars.get(braced ?? bare) ?? whole);

/** 路径里是否有 `.claude` 这一段 —— `~/.claude/x`、`a/.claude`、裸 `.claude` 都算。 */
export const isClaudeConfigPath = (raw: string): boolean => {
  const p = unquote(raw.trim());
  if (!p) return false;
  return p.split("/").some((seg) => seg === ".claude");
};

// 段内所有「写重定向」的目标: `>f` `>>f` `2>f` `&>f` `>|f`, 以及 `>` 单独成 token
// 后跟目标的写法。`2>&1` `>&2` `2>&-` 是 fd 复制, 不落地文件, 跳过; `<` 只读不算。
//
// 为什么必须看目标, 而不是"段里出现过 >": 住在 `.claude/skills/**` 里的 skill 脚本,
// 调用时带任何重定向(哪怕只是 `2>/dev/null`)都会让"段内有 .claude token"和"段内有
// 重定向"这两个不相干的事实凑成误判。执行脚本不写配置面, CC 不会立原生框, 拦了纯属
// 白发卡 —— 2026-08-03 现场: 一条 ylog-query 命令在同一会话连发 13 张。
const redirectTargets = (toks: string[]): string[] => {
  const targets: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const idx = toks[i]!.indexOf(">");
    if (idx < 0) continue;
    const rest = toks[i]!.slice(idx).replace(/^>{1,2}\|?/u, "");
    if (rest.startsWith("&")) continue; // fd 复制, 目标不是路径
    if (rest) { targets.push(rest); continue; }
    const next = toks[i + 1]; // `> file` 分开写
    if (next !== undefined) { targets.push(next); i++; }
  }
  return targets;
};

const bashHit = (command: string): ClaudeConfigHit | undefined => {
  // 引号感知切分失败(未闭合引号/孤立 &) → 整条当一段看, fail-closed 宁可多发卡。
  const segments = splitSegments(command) ?? [command];
  const vars = new Map<string, string>();
  for (const seg of segments) {
    const rawToks = seg.trim().split(/\s+/u).filter(Boolean);
    if (rawToks.length === 0) continue;
    recordAssignments(rawToks, vars);
    const toks = rawToks.map((t) => expandVars(t, vars));
    // 重定向写入(`echo x > ~/.claude/y`)与写命令同等对待; 命令头本身不必是写命令。
    const redirHit = redirectTargets(toks).find((t) => isClaudeConfigPath(t));
    if (redirHit) return { path: unquote(redirHit), why: "bash-write" };
    const hitTok = toks.find((t) => isClaudeConfigPath(t));
    if (!hitTok) continue;
    const head = (unquote(toks[0]!).split("/").pop() ?? "").trim();
    if (WRITE_HEADS.has(head)) return { path: unquote(hitTok), why: "bash-write" };
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
