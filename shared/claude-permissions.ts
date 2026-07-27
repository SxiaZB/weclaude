// 从 Claude Code 的 settings.json 一次性导入 permissions → approval 三层规则。
//
// 设计取向: 只在 `weclaude init`(或手动 --import-claude-permissions) 时读一次,
// 不做运行时耦合 —— Claude 配置格式演进不影响 daemon; 导入后规则由 weclaude
// 自管(审批卡的「✅总是」按钮继续生长 allowRules)。
//
// 映射: permissions.allow → approval.allowRules
//       permissions.ask   → approval.askRules
//       permissions.deny  → approval.denyRules
// 兼容过滤: 引擎不支持的条目跳过并汇报 —— 非 Bash 工具带 specifier 的规则
// (如 "WebFetch(domain:…)" "Read(/etc/*)"), 以及 allow 侧的交互卡工具
// (AskUserQuestion 等, 放行会让企微远端失去问答能力)。
import { existsSync, readFileSync } from "node:fs";
import { NEVER_RULE_ALLOW, parseRule } from "./allow-rules.js";
import { expandHome } from "./paths.js";

export interface ClaudePermissions {
  allow?: unknown;
  ask?: unknown;
  deny?: unknown;
}

export interface MappedRules {
  allow: string[];
  ask: string[];
  deny: string[];
  /** 引擎不兼容而被跳过的原始条目 (供导入时汇报) */
  skipped: string[];
}

const compatible = (raw: string, forAllow: boolean): boolean => {
  const r = parseRule(raw);
  if (!r) return false;
  if (r.tool !== "Bash" && r.spec !== undefined) return false;
  if (forAllow && NEVER_RULE_ALLOW.has(r.tool)) return false;
  return true;
};

/** 纯映射 (无 IO), 供测试与调用方复用。 */
export const mapClaudePermissions = (perms: ClaudePermissions): MappedRules => {
  const out: MappedRules = { allow: [], ask: [], deny: [], skipped: [] };
  const take = (list: unknown, into: string[], forAllow: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (typeof e !== "string" || !e.trim()) continue;
      const v = e.trim();
      if (compatible(v, forAllow)) {
        if (!into.includes(v)) into.push(v);
      } else {
        out.skipped.push(v);
      }
    }
  };
  take(perms.allow, out.allow, true);
  take(perms.ask, out.ask, false);
  take(perms.deny, out.deny, false);
  return out;
};

/** 读取 Claude settings.json 的 permissions 段; 文件缺失/解析失败返回 undefined。 */
export const readClaudePermissions = (
  settingsPath = "~/.claude/settings.json",
): ClaudePermissions | undefined => {
  const abs = expandHome(settingsPath);
  if (!existsSync(abs)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as {
      permissions?: ClaudePermissions;
    };
    return parsed?.permissions;
  } catch {
    return undefined;
  }
};
