#!/usr/bin/env bash
# wezard PreToolUse hook: forward to local daemon → long-poll → emit decision.
# Any failure → ask (never break workflow).
set -uo pipefail

DAEMON_URL="${WEZARD_DAEMON_URL:-http://127.0.0.1:17890/approve}"
# 必须严格大于 daemon 的 approval.longPollSec (默认 43200) 且小于 hooks.json
# 的 timeout, 否则卡在 WeCom 里挂 >30min 后 curl 先死, 用户的点击写进死 socket。
HOOK_TIMEOUT="${WEZARD_HOOK_TIMEOUT:-43210}"
STATE_DIR="${WEZARD_STATE_DIR:-$HOME/.wezard/state}"
# Fallback policy when the daemon is unreachable / replies garbage. ask|allow|deny.
# Default keeps the safe behavior; set to `allow` in trusted local-only setups.
FALLBACK="${WEZARD_HOOK_FALLBACK:-ask}"

emit() {
  local decision="$1" reason="${2:-}"
  # 用 jq 拼 JSON: reason 可能含字面引号(askq deny 把答案塞进 reason),
  # printf 直接拼会漏出内层 " 把 JSON 撕烂, Claude Code 解析失败 fallback
  # 弹原生 picker → askq 失效。
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg d "$decision" --arg r "wezard: $reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  else
    # jq 缺失兜底: 手动转义 \ 和 " (足够覆盖 reason 里的字面引号)。
    local esc="${reason//\\/\\\\}"; esc="${esc//\"/\\\"}"
    printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${decision}\",\"permissionDecisionReason\":\"wezard: ${esc}\"}}"
  fi
  exit 0
}
ask() { emit "ask" "${1:-bridge unreachable}"; }

# Daemon-down fallback. Consults the persisted auto-approve window first so a
# session-level "allow N min" survives daemon restart / outage; otherwise falls
# back to FALLBACK. SESSION_ID must already be parsed.
bridge_down() {
  local reason="$1"
  local sf="$STATE_DIR/auto-windows.json"
  if [[ -n "${SESSION_ID:-}" && -r "$sf" ]] && command -v jq >/dev/null 2>&1; then
    local active
    active=$(jq -r --arg s "$SESSION_ID" \
      'if (.windows[$s].until // 0) > (now * 1000) then "1" else "0" end' \
      "$sf" 2>/dev/null) || active=""
    if [[ "$active" == "1" ]]; then
      emit "allow" "auto-window (offline): $reason"
    fi
  fi
  case "$FALLBACK" in
    allow|deny|ask) emit "$FALLBACK" "$reason" ;;
    *) emit "ask" "$reason" ;;
  esac
}

PAYLOAD=$(cat) || ask "stdin read failed"
command -v jq >/dev/null 2>&1 || ask "jq missing"

SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')
TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty')
TOOL_INPUT=$(printf '%s' "$PAYLOAD" | jq -c '.tool_input // {}')
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""')
TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // ""')
PERMISSION_MODE=$(printf '%s' "$PAYLOAD" | jq -r '.permission_mode // ""')

# 权限模式短路: 只对用户主动选的"完全跳过"模式放掉, 其它一律走 daemon 发 IM
# 卡, 让 wezard 远端用户能在 IM 上点决策。
#   - bypassPermissions: 用户已经主动选了"全跳", emit allow 直接放, 不打 daemon。
#   - auto: 不在此短路。第一次发卡用户点 10min 后, daemon 的 isAutoWindowActive
#     会接管, 后续 tool 自动放行不再发卡, 既不丢 IM 控制权也不会变成"卡刷屏"。
#     若 emit "ask" 让 Claude 自己处理, 不安全 tool 会弹本地 CLI picker, 远端用户
#     完全看不见也答不了 — 那是 v0.1.35 的回退原因。
#   - dontAsk: Claude 默认拒, 但 wezard 用户可能希望从 IM 端覆盖, 不在此短路。
# acceptEdits / default / plan 不在此列, 维持 daemon 流程。AskUserQuestion 始终
# 走卡 (远端用户的主动决策), 故任何 mode 都不在此短路。
# WEZARD_HONOR_AUTO_MODE=0 关掉本段对齐行为。
if [[ "$TOOL_NAME" != "AskUserQuestion" ]] && [[ "${WEZARD_HONOR_AUTO_MODE:-1}" != "0" ]]; then
  case "$PERMISSION_MODE" in
    bypassPermissions)
      emit "allow" "bypass-mode passthrough" ;;
  esac
fi

# ExitPlanMode 只是把 plan mode 的产出交给用户确认, 本地 CLI 会再弹一次原生
# 确认框, 走 IM 审批纯属多此一举, 直接放行。
if [[ "$TOOL_NAME" == "ExitPlanMode" ]]; then
  emit "allow" "ExitPlanMode passthrough"
fi

# wezard 自家 MCP 工具全部走 loopback 到本 daemon, 自审会把 /wrc 首次绑定卡死
# (还没 defaultChat, 卡片无处可推 → 鸡生蛋), 直接放行。
# 命名两条路径:
#   1. cli/sync.ts (legacy claude-internal): mcp__wezard__<tool>
#   2. .claude-plugin/plugin.json:           mcp__plugin_wezard_wezard__<tool>
# 用 *wezard__* 同时覆盖两种前缀。
if [[ "$TOOL_NAME" == mcp__*wezard__* ]]; then
  emit "allow" "wezard mcp self-call bypass"
fi

# wezard 自家 Skill (slash commands like /wrc) 也是本地插件代码, 无须审批。
# tool_input.skill 形如 "wezard:wrc"; plugin 命名空间用冒号分隔。
if [[ "$TOOL_NAME" == "Skill" ]]; then
  SKILL_NAME=$(printf '%s' "$TOOL_INPUT" | jq -r '.skill // ""')
  if [[ "$SKILL_NAME" == wezard:* ]]; then
    emit "allow" "wezard skill self-call bypass"
  fi
fi

# Bash read-only fast-path: bypass cards for grep / rg etc.
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(printf '%s' "$TOOL_INPUT" | jq -r '.command // ""')
  if [[ "$CMD" =~ ^[[:space:]]*(grep|egrep|fgrep|rg|ls|cat|head|tail|wc|file)([[:space:]]|$) ]] \
     && [[ ! "$CMD" =~ [\;\|\&\>\<\`\$\(] ]]; then
    emit "allow" "read-only bypass"
  fi
  # wezard CLI 同理: /wrc /cd 这些 slash command 的 ! bash 都打到本 daemon,
  # 自己审自己没意义, 也避免首次绑定时无处推卡。
  if [[ "$CMD" =~ (^|/|[[:space:]])wezard(\.sh)?([[:space:]]|$) ]]; then
    emit "allow" "wezard self-call bypass"
  fi
fi

# Tail of recent user messages for context on the card.
# 注意 .message.content 可能是 string 或 content blocks 数组；过滤 tool_result 与
# Claude Code 注入的 <system-reminder>/<command-*>/<local-command-*> 包裹标签。
TRANSCRIPT_TAIL=""
if [[ -n "$TRANSCRIPT_PATH" && -r "$TRANSCRIPT_PATH" ]]; then
  TRANSCRIPT_TAIL=$(tail -n 200 "$TRANSCRIPT_PATH" 2>/dev/null \
    | jq -r '
        select(.type == "user" or .role == "user")
        | select((.isMeta // false) == false)
        | (.message.content // .content) as $c
        | ( if ($c | type) == "string" then $c
            elif ($c | type) == "array" then
              ([ $c[]? | select(.type == "text") | .text ] | join("\n"))
            else "" end )
        | gsub("(?s)<system-reminder>.*?</system-reminder>"; "")
        | gsub("(?s)<command-name>.*?</command-name>"; "")
        | gsub("(?s)<command-message>.*?</command-message>"; "")
        | gsub("(?s)<command-args>.*?</command-args>"; "")
        | gsub("(?s)<local-command-stdout>.*?</local-command-stdout>"; "")
        | gsub("(?s)<local-command-caveat>.*?</local-command-caveat>"; "")
        | gsub("\\s+"; " ")
        | sub("^\\s+"; "") | sub("\\s+$"; "")
        | select(length > 0)
      ' 2>/dev/null \
    | tail -n 3 \
    | head -c 800 || true)
fi

BODY=$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg tn "$TOOL_NAME" \
  --argjson ti "$TOOL_INPUT" \
  --arg cwd "$CWD" \
  --arg tail "$TRANSCRIPT_TAIL" \
  '{session_id:$sid,tool_name:$tn,tool_input:$ti,cwd:$cwd,transcript_tail:$tail}')

RESP=$(curl -sS --max-time "$HOOK_TIMEOUT" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "$DAEMON_URL" 2>/dev/null) || bridge_down "daemon curl failed"

DECISION=$(printf '%s' "$RESP" | jq -r '.decision // "ask"' 2>/dev/null) || bridge_down "bad daemon response"
REASON=$(printf '%s' "$RESP" | jq -r '.reason // ""' 2>/dev/null)

case "$DECISION" in
  allow|deny|ask) emit "$DECISION" "$REASON" ;;
  *) bridge_down "unknown decision: $DECISION" ;;
esac
