#!/usr/bin/env bash
# weclaude PreToolUse hook: forward to local daemon → long-poll → emit decision.
# Any failure → ask (never break workflow).
set -uo pipefail

DAEMON_URL="${WECLAUDE_DAEMON_URL:-http://127.0.0.1:17890/approve}"
HOOK_TIMEOUT="${WECLAUDE_HOOK_TIMEOUT:-1810}"
STATE_DIR="${WECLAUDE_STATE_DIR:-$HOME/.weclaude/state}"
# Fallback policy when the daemon is unreachable / replies garbage. ask|allow|deny.
# Default keeps the safe behavior; set to `allow` in trusted local-only setups.
FALLBACK="${WECLAUDE_HOOK_FALLBACK:-ask}"

emit() {
  local decision="$1" reason="${2:-}"
  # 用 jq 拼 JSON: reason 可能含字面引号(askq deny 把答案塞进 reason),
  # printf 直接拼会漏出内层 " 把 JSON 撕烂, Claude Code 解析失败 fallback
  # 弹原生 picker → askq 失效。
  if command -v jq >/dev/null 2>&1; then
    jq -cn --arg d "$decision" --arg r "weclaude: $reason" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  else
    # jq 缺失兜底: 手动转义 \ 和 " (足够覆盖 reason 里的字面引号)。
    local esc="${reason//\\/\\\\}"; esc="${esc//\"/\\\"}"
    printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"${decision}\",\"permissionDecisionReason\":\"weclaude: ${esc}\"}}"
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

# weclaude 自家 MCP 工具全部走 loopback 到本 daemon, 自审会把 /wrc 首次绑定卡死
# (还没 defaultChat, 卡片无处可推 → 鸡生蛋), 直接放行。
# 命名两条路径:
#   1. cli/sync.ts (legacy claude-internal): mcp__weclaude__<tool>
#   2. .claude-plugin/plugin.json:           mcp__plugin_weclaude_weclaude__<tool>
# 用 *weclaude__* 同时覆盖两种前缀。
if [[ "$TOOL_NAME" == mcp__*weclaude__* ]]; then
  emit "allow" "weclaude mcp self-call bypass"
fi

# Bash read-only fast-path: bypass cards for grep / rg etc.
if [[ "$TOOL_NAME" == "Bash" ]]; then
  CMD=$(printf '%s' "$TOOL_INPUT" | jq -r '.command // ""')
  if [[ "$CMD" =~ ^[[:space:]]*(grep|egrep|fgrep|rg|ls|cat|head|tail|wc|file)([[:space:]]|$) ]] \
     && [[ ! "$CMD" =~ [\;\|\&\>\<\`\$\(] ]]; then
    emit "allow" "read-only bypass"
  fi
  # weclaude CLI 同理: /wrc /cd 这些 slash command 的 ! bash 都打到本 daemon,
  # 自己审自己没意义, 也避免首次绑定时无处推卡。
  if [[ "$CMD" =~ (^|/|[[:space:]])weclaude(\.sh)?([[:space:]]|$) ]]; then
    emit "allow" "weclaude self-call bypass"
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
