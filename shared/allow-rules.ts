// Claude-Code-style allow rules for the approval flow (`approval.allowRules`).
//
// 语法对齐 Claude Code 官方 permission 规则的常用子集, 让用户在两边维护同一套
// 心智模型:
//   "Read"                      → 放行整个工具
//   "mcp__server"               → 放行该 MCP server 的全部工具
//   "mcp__server__tool"         → 放行单个 MCP 工具
//   "Bash(git status)"          → Bash 精确命令 (空白归一后全等)
//   "Bash(git log *)"           → Bash 前缀匹配 (空格-星, Claude 现行写法)
//   "Bash(npm run test:*)"      → Bash 前缀匹配 (冒号-星, Claude 早期写法)
//   "Bash(python3 .claude/skills/*)" → 星号紧跟路径亦可 (前缀=去掉末尾 *)
//
// 与 Claude 一致的安全语义:
//   • 复合命令 (&&, ||, ;, |, 换行) 逐段拆开, 每一段都必须命中某条 Bash 规则 —
//     `python3 x.py *` 匹配不了 `python3 x.py && rm -rf`;
//   • 段首的 VAR=value 环境变量前缀在匹配前剥掉 (`timeout=60 python3 …`);
//   • 含命令替换 ($(…) / 反引号) 的命令一律不命中 (fail-safe 交回发卡);
//   • 星号只支持结尾位置 (Claude 同款), 中间通配不支持;
//   • 仅 Bash 支持括号 specifier; 其他工具带 specifier 的规则视为无效 (不放行),
//     避免 "Read(/etc/*)" 被误实现成放行全部 Read。
//
// 交互卡依赖拦截的工具永不可被规则放行 (放行会让企微远端失去问答/计划审批能力)。
export const NEVER_RULE_ALLOW = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);

interface ParsedRule {
  tool: string;
  spec?: string;
}

const RULE_RE = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/s;

export const parseRule = (raw: string): ParsedRule | undefined => {
  const m = RULE_RE.exec(raw.trim());
  if (!m || !m[1]) return undefined;
  return { tool: m[1], spec: m[2] };
};

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

// 段首环境变量赋值前缀: `timeout=60 FOO=bar python3 …` → `python3 …`
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const stripEnvPrefix = (segment: string): string => {
  const toks = segment.split(" ");
  let i = 0;
  while (i < toks.length && ENV_ASSIGN_RE.test(toks[i]!)) i++;
  return toks.slice(i).join(" ");
};

const bashSpecMatches = (spec: string, segment: string): boolean => {
  const seg = stripEnvPrefix(norm(segment));
  if (!seg) return false;
  const s = norm(spec);
  if (s === "") return false;
  if (s.endsWith(":*")) {
    return seg.startsWith(s.slice(0, -2));
  }
  if (s.endsWith("*")) {
    // "git log *" → 前缀 "git log " (含空格); "…/skills/*" → 前缀 "…/skills/"。
    // 同时接受去掉尾随空格后的全等: "git log *" 匹配裸 "git log"。
    const prefix = s.slice(0, -1);
    return seg.startsWith(prefix) || seg === prefix.trimEnd();
  }
  return seg === s;
};

// 含命令替换的整条命令直接不命中 — 规则匹配的是字面前缀, 而 $(…)/反引号的实际
// 行为取决于运行时展开, 字面匹配给不出可信判断。
const HAS_SUBSTITUTION = /[`]|\$\(/;
const SEGMENT_SPLIT = /\r?\n|&&|\|\||;|\|/;

const bashCommandAllowed = (bashSpecs: Array<string | undefined>, command: string): string[] | undefined => {
  if (HAS_SUBSTITUTION.test(command)) return undefined;
  const segments = command.split(SEGMENT_SPLIT).map((s) => s.trim());
  if (segments.length === 0) return undefined;
  const hits: string[] = [];
  for (const seg of segments) {
    if (!seg) return undefined; // 空段 (如 "a && && b") 视为异常, 交回发卡
    let matched: string | undefined;
    for (const spec of bashSpecs) {
      if (spec === undefined) {
        matched = "Bash"; // 裸 "Bash" 规则: 放行一切 (不建议配置, 但语义与 Claude 对齐)
        break;
      }
      if (bashSpecMatches(spec, seg)) {
        matched = `Bash(${spec})`;
        break;
      }
    }
    if (!matched) return undefined;
    hits.push(matched);
  }
  return hits;
};

/**
 * 判定 (toolName, toolInput) 是否被 allowRules 放行。
 * 返回命中说明 (用于日志/审计 reason), 未命中返回 undefined。
 */
export const ruleAllows = (
  rules: string[],
  toolName: string,
  toolInput: unknown,
): string | undefined => {
  if (rules.length === 0) return undefined;
  if (NEVER_RULE_ALLOW.has(toolName)) return undefined;

  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== undefined);

  if (toolName === "Bash") {
    const cmd = toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    if (typeof cmd !== "string" || !cmd.trim()) return undefined;
    const bashSpecs = parsed.filter((r) => r.tool === "Bash").map((r) => r.spec);
    if (bashSpecs.length === 0) return undefined;
    const hits = bashCommandAllowed(bashSpecs, cmd);
    return hits ? [...new Set(hits)].join(" + ") : undefined;
  }

  for (const r of parsed) {
    if (r.spec !== undefined) continue; // 非 Bash 工具不支持 specifier
    if (r.tool === toolName) return r.tool;
    // MCP server 级规则: "mcp__server" 覆盖 "mcp__server__*"
    if (r.tool.startsWith("mcp__") && toolName.startsWith(`${r.tool}__`)) return r.tool;
  }
  return undefined;
};

/**
 * deny / ask 规则的匹配判定 — 与 allow 的量词相反:
 * Bash 复合命令**任一段**命中即命中 (拒绝/追问要抓到藏在复合命令里的危险段,
 * 而放行必须确保没有夹带)。含 $()/反引号不豁免匹配 (字面段仍参与判定)。
 * 不做 NEVER_RULE_ALLOW 保护 — deny/ask 都是收紧方向, fail-closed 无害。
 * 返回命中的规则原文, 未命中返回 undefined。
 */
export const ruleMatchesAny = (
  rules: string[],
  toolName: string,
  toolInput: unknown,
): string | undefined => {
  if (rules.length === 0) return undefined;
  const parsed = rules.map(parseRule).filter((r): r is ParsedRule => r !== undefined);

  if (toolName === "Bash") {
    const cmd = toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    if (typeof cmd !== "string" || !cmd.trim()) return undefined;
    const bashRules = parsed.filter((r) => r.tool === "Bash");
    const segments = cmd.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      for (const r of bashRules) {
        if (r.spec === undefined) return "Bash";
        if (bashSpecMatches(r.spec, seg)) return `Bash(${r.spec})`;
      }
    }
    return undefined;
  }

  for (const r of parsed) {
    if (r.spec !== undefined) continue;
    if (r.tool === toolName) return r.tool;
    if (r.tool.startsWith("mcp__") && toolName.startsWith(`${r.tool}__`)) return r.tool;
  }
  return undefined;
};

/**
 * 「✅ 总是」按钮的规则生成: 由本次调用推导要写入 allowRules 的规则。
 * - 非 Bash: 裸工具名 (mcp 工具即完整 mcp__server__tool);
 * - Bash: 逐段取「命令 + 第二个 token」做前缀规则 `Bash(a b *)`;
 *   第二个 token 是 flag (-开头) 或不存在时退化为单 token `Bash(a *)`;
 *   含 $()/反引号无法生成可靠的字面前缀 → 返回 [] (调用方应保持一次性放行)。
 * - 交互卡工具永不生成规则。
 */
export const alwaysAllowRulesFor = (toolName: string, toolInput: unknown): string[] => {
  if (NEVER_RULE_ALLOW.has(toolName)) return [];
  if (toolName !== "Bash") return [toolName];

  const cmd = toolInput && typeof toolInput === "object"
    ? (toolInput as Record<string, unknown>).command
    : undefined;
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  if (HAS_SUBSTITUTION.test(cmd)) return [];

  const rules: string[] = [];
  for (const rawSeg of cmd.split(SEGMENT_SPLIT)) {
    const seg = stripEnvPrefix(norm(rawSeg));
    if (!seg) return []; // 空段异常, 整体放弃生成
    // 分段器不感知引号 — 引号内的 |/&&/; 会被误切, 切出来的段引号必然不配对
    // (如 `grep "a|b" f` 切成 `grep "a` 与 `b" f`)。任一段引号不平衡说明切进了
    // 字符串内部, 整体放弃生成 (本次一次性放行), 不写垃圾规则。
    for (const q of ['"', "'"]) {
      if ((seg.split(q).length - 1) % 2 !== 0) return [];
    }
    const toks = seg.split(" ");
    const head = toks[0]!;
    // 段首必须长得像命令 (字母数字/路径字符); 括号引号等异形首 token 一律放弃。
    const TOKEN_RE = /^[A-Za-z0-9_.~/+-]+$/;
    if (!TOKEN_RE.test(head)) return [];
    // 第二个 token 只有长得像子命令/路径时才纳入前缀 (flag、引号值等退化为单命令)。
    const second = toks[1];
    const useSecond = second && !second.startsWith("-") && TOKEN_RE.test(second);
    const prefix = useSecond ? `${head} ${second}` : head;
    rules.push(`Bash(${prefix} *)`);
  }
  return [...new Set(rules)];
};
