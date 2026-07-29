#!/usr/bin/env bash
set -uo pipefail
HOME_DIR="$HOME"
OS="$(uname -s)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# label | systemd unit | entry script (for the pkill sweep)
SERVICES=(
  "com.wezard.daemon|wezard.service|dist/daemon/index.js"
  "com.wezard.svr|wezard-svr.service|dist/svr/index.js"
)

# Best-effort: drop the Claude Code plugin + marketplace registration installed
# by `wezard init`. Tries both `claude` and `claude-internal` since either
# could have been used at install time. All failures are non-fatal — uninstall
# must keep going even if claude binaries are gone.
for bin in claude claude-internal; do
  command -v "$bin" >/dev/null 2>&1 || continue
  "$bin" plugin uninstall wezard@wezard-local 2>/dev/null && \
    echo "[uninstall] $bin: plugin uninstalled" || true
  "$bin" plugin marketplace remove "$REPO" 2>/dev/null && \
    echo "[uninstall] $bin: marketplace removed" || true
done

for svc in "${SERVICES[@]}"; do
  IFS='|' read -r LABEL UNIT ENTRY <<< "$svc"
  case "$OS" in
    Darwin)
      PLIST="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
      if [[ -f "$PLIST" ]]; then
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        echo "[uninstall] removed $PLIST"
      fi
      # Belt-and-braces: launchctl unload can leave a stray process if the plist
      # was edited mid-flight. bootout the label, then SIGTERM any survivors.
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
      pkill -f "$ENTRY" 2>/dev/null || true
      ;;
    Linux)
      UNIT_PATH="$HOME_DIR/.config/systemd/user/$UNIT"
      if [[ -f "$UNIT_PATH" ]]; then
        systemctl --user disable --now "$UNIT" 2>/dev/null || true
        rm -f "$UNIT_PATH"
        systemctl --user daemon-reload
        echo "[uninstall] removed $UNIT_PATH"
      fi
      pkill -f "$ENTRY" 2>/dev/null || true
      ;;
  esac
done
echo "[uninstall] done."
