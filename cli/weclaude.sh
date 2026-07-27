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
  svr [args...]        run standalone detail relay (deploy on a host chat + cli both reach)
  logs [-f]            tail daemon log
  config-path            show resolved config path
  sync                   write hooks/MCP/env into sync.targets settings.json
  unsync                 remove our entries from sync.targets settings.json
  audit [tag]            token/cost breakdown for current Claude session (main + subagents)
  uninstall              full teardown: stop daemon + unsync + plugin uninstall + remove daemon (run before `npm uninstall -g`)
                         add `--purge` to also delete ~/.weclaude state
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
  svr)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/svr/index.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
    ;;
  logs)
    log_path=$(http_get /status 2>/dev/null | jq -r '.logFile // empty' 2>/dev/null || true)
    log_path="${log_path:-$HOME_DIR/.weclaude/daemon.log}"
    if [[ "${1:-}" == "-f" ]]; then tail -f "$log_path"; else tail -n 100 "$log_path"; fi
    ;;
  config-path) http_get /status | jq -r '.sourcePath // empty' ;;
  uninstall)
    # Order matters: stop the daemon FIRST so it can't rewrite settings/lock
    # files mid-teardown; then strip MCP/env from agent settings; then remove
    # the plist/unit + Claude plugin registration. State at ~/.weclaude is
    # preserved unless `--purge` is given.
    purge=0
    [[ "${1:-}" == "--purge" ]] && purge=1
    http_post /shutdown >/dev/null 2>&1 || true
    NODE_BIN="$(command -v node)"
    SYNC_SCRIPT="$REPO_ROOT/dist/cli/sync.js"
    [[ -f "$SYNC_SCRIPT" ]] && "$NODE_BIN" "$SYNC_SCRIPT" --remove || true
    bash "$REPO_ROOT/scripts/uninstall.sh"
    rm -f "$HOME_DIR/.weclaude/sync.lock.json"
    if (( purge )); then
      rm -rf "$HOME_DIR/.weclaude"
      echo "[weclaude] state purged (~/.weclaude removed)"
    else
      echo "[weclaude] cleaned. state kept at ~/.weclaude — remove with 'weclaude uninstall --purge' or 'rm -rf ~/.weclaude'"
    fi
    echo "[weclaude] safe to 'npm uninstall -g weclaude' now"
    ;;
  mirror)
    cwd="${CLAUDE_PROJECT_DIR:-${CODEBUDDY_PROJECT_DIR:-$(pwd)}}"
    # claude-internal stores under ~/.claude-internal/projects/, official claude
    # under ~/.claude/projects/, codebuddy under ~/.codebuddy/projects/. Walk up
    # parent dirs — caller may be in a subdirectory of the cwd the CLI was
    # launched in (e.g. monorepo subpackage). Encoding differs: claude keeps a
    # leading `-` ([/.]→-), codebuddy trims it first (no leading `-`).
    # Prioritize the base matching the active CLI (detected via env vars) so a
    # codebuddy session doesn't fall through to a stale claude project dir.
    if [[ -n "${CODEBUDDY_SESSION_ID:-}" ]]; then
      bases=("$HOME/.codebuddy/projects" "$HOME/.claude-internal/projects" "$HOME/.claude/projects")
    else
      bases=("$HOME/.claude-internal/projects" "$HOME/.claude/projects" "$HOME/.codebuddy/projects")
    fi
    proj=""
    probe="$cwd"
    while [[ -z "$proj" && -n "$probe" ]]; do
      for base in "${bases[@]}"; do
        if [[ "$base" == *codebuddy* ]]; then
          enc="$(printf %s "$probe" | sed 's|^[/]*||; s|[/.]|-|g')"
        else
          enc="$(printf %s "$probe" | sed 's|[/.]|-|g')"
        fi
        if [[ -d "$base/$enc" ]]; then proj="$base/$enc"; break; fi
      done
      [[ "$probe" == "/" ]] && break
      probe="$(dirname "$probe")"
    done
    if [[ -z "$proj" ]]; then
      echo "no claude/codebuddy project dir for cwd: $cwd (or any ancestor)"
      echo "tried encodings up to $HOME/.claude{,-internal}/projects/ + $HOME/.codebuddy/projects/<encoded-ancestor>"
      exit 1
    fi
    # Resolve the *calling* session via env var the CLI injects into every
    # child process. Both Claude Code and CodeBuddy export CLAUDE_SESSION_ID
    # (back-compat); CODEBUDDY_SESSION_ID is the codebuddy-native name.
    sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${CODEBUDDY_SESSION_ID:-}}}"
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
  audit)
    NODE_BIN="$(command -v node)"
    SCRIPT="$REPO_ROOT/dist/cli/audit.js"
    [[ -f "$SCRIPT" ]] || { echo "build first: npm run build"; exit 1; }
    exec "$NODE_BIN" "$SCRIPT" "$@"
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
