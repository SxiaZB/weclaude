#!/usr/bin/env bash
set -uo pipefail
LABEL="com.wezard.daemon"
HOME_DIR="$HOME"
OS="$(uname -s)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

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
    pkill -f "dist/daemon/index.js" 2>/dev/null || true
    ;;
  Linux)
    UNIT="$HOME_DIR/.config/systemd/user/wezard.service"
    if [[ -f "$UNIT" ]]; then
      systemctl --user disable --now wezard.service 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
      echo "[uninstall] removed $UNIT"
    fi
    pkill -f "dist/daemon/index.js" 2>/dev/null || true
    ;;
esac
echo "[uninstall] done."
