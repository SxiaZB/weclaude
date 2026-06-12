#!/usr/bin/env bash
# weclaude CLI — talks to local weclaude daemon over HTTP and toggles launchd/systemd.
set -uo pipefail

DAEMON_BASE="${WECLAUDE_DAEMON_BASE:-http://127.0.0.1:17890}"
LABEL="com.weclaude.daemon"
HOME_DIR="$HOME"
OS="$(uname -s)"

# Resolve symlinks so REPO_ROOT points at the real package dir even when this
# script is invoked via the npm-installed bin symlink (e.g. ~/.npm-global/bin/weclaude).
# macOS ships BSD readlink without -f, so chase the chain by hand.
self="${BASH_SOURCE[0]}"
while [[ -L "$self" ]]; do
  d="$(cd -P "$(dirname "$self")" && pwd)"
  t="$(readlink "$self")"
  [[ "$t" != /* ]] && t="$d/$t"
  self="$t"
done
REPO_ROOT="$(cd -P "$(dirname "$self")/.." && pwd)"

cmd="${1:-status}"
shift || true

usage() {
  cat <<'EOF'
weclaude <subcommand>
  init                 interactive onboarding (write config, install daemon, claim default chat, run demo)
  status               daemon health + connection state
  start                load resident daemon (launchd/systemd)
  stop                 unload resident daemon
  restart              stop + start
  reload               quick: shutdown via HTTP + kickstart
  mirror [chat]        attach current Claude session for mirror push (target overrides config)
  mirror-status        show current mirror attachment
  send <chat> <text>   proactive markdown message
  pending              list outstanding approval req_ids
  logs [-f]            tail daemon log
  config-path            show resolved config path
  sync                   write hooks/MCP/env into sync.targets settings.json
  unsync                 remove our entries from sync.targets settings.json
  uninstall              full teardown: unsync + remove daemon (run before `npm uninstall -g`)
  version                print weclaude version
  help
EOF
}

http_get() { curl -sS --max-time 5 "$DAEMON_BASE$1"; }
http_post() { curl -sS --max-time 5 -X POST -H 'content-type: application/json' -d "${2:-{\}}" "$DAEMON_BASE$1"; }

svc_load() {
  case "$OS" in
    Darwin) launchctl load -w "$HOME_DIR/Library/LaunchAgents/${LABEL}.plist" ;;
    Linux)  systemctl --user start weclaude.service ;;
  esac
}
svc_unload() {
  case "$OS" in
    Darwin) launchctl unload "$HOME_DIR/Library/LaunchAgents/${LABEL}.plist" ;;
    Linux)  systemctl --user stop weclaude.service ;;
  esac
}

# Walk the parent-process chain looking for `claude-internal`. Mirror commands
# inject into a live Claude session; we only enable them under claude-internal
# (the Tencent-internal CC build) for now to avoid surprising upstream Claude.
require_claude_internal() {
  local pid=$PPID
  local i=0
  while (( i < 8 )) && [[ "$pid" -gt 1 ]]; do
    local args
    args=$(ps -p "$pid" -o args= 2>/dev/null) || break
    [[ "$args" == *claude-internal* ]] && return 0
    pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    [[ -z "$pid" ]] && break
    (( i++ ))
  done
  echo "weclaude $cmd: only available inside claude-internal" >&2
  exit 1
}

case "$cmd" in
  init)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/init.js"
    if [[ ! -f "$SCRIPT" ]]; then
      # Dev repo: tsconfig.json present → build. npm install: tarball ships dist/,
      # so a missing init.js means a broken install — fail clearly instead of
      # invoking tsc against a non-existent tsconfig.
      if [[ -f "$REPO_ROOT/tsconfig.json" ]]; then
        echo "[weclaude init] building..."
        (cd "$REPO_ROOT" && npm install --silent && npx tsc -p tsconfig.json) || { echo "build failed"; exit 1; }
      else
        echo "[weclaude init] missing $SCRIPT — try 'npm install -g weclaude' to reinstall" >&2
        exit 1
      fi
    fi
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  status)
    if ! out=$(http_get /status 2>/dev/null); then
      echo "daemon: down ($DAEMON_BASE)"
      exit 1
    fi
    echo "$out" | jq . 2>/dev/null || echo "$out"
    ;;
  start)   svc_load   && echo "daemon: started" ;;
  stop)    svc_unload && echo "daemon: stopped" ;;
  restart) svc_unload || true; sleep 1; svc_load && echo "daemon: restarted" ;;
  reload)
    # KeepAlive.SuccessfulExit=false, so /shutdown alone won't respawn — kick it.
    http_post /shutdown >/dev/null 2>&1 || true
    case "$OS" in
      Darwin) launchctl kickstart -k "gui/$(id -u)/${LABEL}" >/dev/null && echo "daemon: reloaded" ;;
      Linux)  systemctl --user restart weclaude.service && echo "daemon: reloaded" ;;
    esac
    ;;
  send)
    chat="${1:-}"; shift || true
    text="${*:-}"
    if [[ -z "$chat" || -z "$text" ]]; then
      echo "usage: weclaude send <chat> <text>"; exit 1
    fi
    body=$(jq -nc --arg c "$chat" --arg t "$text" '{chat:$c,text:$t}')
    http_post /message "$body"
    ;;
  pending) http_get /pending | jq . 2>/dev/null || http_get /pending ;;
  logs)
    log_path=$(http_get /status 2>/dev/null | jq -r '.logFile // empty' 2>/dev/null || true)
    log_path="${log_path:-$HOME_DIR/.weclaude/daemon.log}"
    if [[ "${1:-}" == "-f" ]]; then tail -f "$log_path"; else tail -n 100 "$log_path"; fi
    ;;
  config-path) http_get /status | jq -r '.sourcePath // empty' ;;
  uninstall)
    NODE_BIN="$(command -v node)"
    SYNC_SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SYNC_SCRIPT" ]] && "$NODE_BIN" "$SYNC_SCRIPT" --remove || true
    bash "$REPO_ROOT/scripts/uninstall.sh"
    echo "[weclaude] cleaned. safe to 'npm uninstall -g weclaude' (state at ~/.weclaude kept)"
    ;;
  mirror)
    require_claude_internal
    cwd="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    enc="$(printf %s "$cwd" | sed 's|/|-|g')"
    # claude-internal stores under ~/.claude-internal/projects/, official claude
    # under ~/.claude/projects/. Prefer the internal one since this command is
    # gated to claude-internal anyway.
    proj=""
    for base in "$HOME/.claude-internal/projects" "$HOME/.claude/projects"; do
      if [[ -d "$base/$enc" ]]; then proj="$base/$enc"; break; fi
    done
    if [[ -z "$proj" ]]; then
      echo "no claude project dir for cwd: $cwd"
      echo "looked in: $HOME/.claude-internal/projects/$enc and $HOME/.claude/projects/$enc"
      exit 1
    fi
    # Resolve the *calling* session via env var Claude Code injects into every
    # child process. lsof can't help — claude doesn't keep the jsonl fd open
    # across writes, so the file appears unbound between turns.
    sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
    latest=""
    if [[ -n "$sid" && -f "$proj/$sid.jsonl" ]]; then
      latest="$proj/$sid.jsonl"
    fi
    # Fallback for setups that don't propagate the env var: most-recent mtime.
    [[ -z "$latest" ]] && latest=$(ls -t "$proj"/*.jsonl 2>/dev/null | head -1)
    if [[ -z "$latest" ]]; then
      echo "no .jsonl under $proj"; exit 1
    fi
    sid="$(basename "$latest" .jsonl)"
    # Accept user-friendly prefixes: vid:<id> → user:<id>, chatid:<id> → chat:<id>.
    # Pass anything else through (already in user:/chat:/group: form, or empty).
    raw="${1:-}"
    case "$raw" in
      vid:*)    target="user:${raw#vid:}" ;;
      chatid:*) target="chat:${raw#chatid:}" ;;
      *)        target="$raw" ;;
    esac
    body=$(jq -nc --arg s "$sid" --arg p "$latest" --arg t "$target" --arg tp "${TMUX_PANE:-}" \
      '{sessionId:$s, jsonlPath:$p}
        + (if $t == "" then {} else {target:$t} end)
        + (if $tp == "" then {} else {tmuxPane:$tp} end)')
    http_post /mirror/attach "$body" | jq . 2>/dev/null || true
    ;;
  mirror-status)
    require_claude_internal
    http_get /mirror/status | jq . 2>/dev/null || http_get /mirror/status
    ;;
  sync)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  unsync)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" --remove "$@"
    ;;
  help|-h|--help) usage ;;
  version|-v|--version)
    # Read version straight from the package manifest — no jq dep, regex is enough.
    pkg="$REPO_ROOT/package.json"
    [[ -f "$pkg" ]] || { echo "package.json not found at $pkg" >&2; exit 1; }
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg" | head -1
    ;;
  *) echo "unknown subcommand: $cmd"; usage; exit 2 ;;
esac
