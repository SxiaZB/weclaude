#!/usr/bin/env bash
set -euo pipefail
LABEL="com.weclaude.daemon"
HOME_DIR="$HOME"
OS="$(uname -s)"

case "$OS" in
  Darwin)
    PLIST="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
    if [[ -f "$PLIST" ]]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "[uninstall] removed $PLIST"
    fi
    ;;
  Linux)
    UNIT="$HOME_DIR/.config/systemd/user/weclaude.service"
    if [[ -f "$UNIT" ]]; then
      systemctl --user disable --now weclaude.service 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
      echo "[uninstall] removed $UNIT"
    fi
    ;;
esac
echo "[uninstall] done."
