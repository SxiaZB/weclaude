#!/usr/bin/env bash
# Install resident daemon. Auto-detects macOS (launchd) vs Linux (systemd --user).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
HOME_DIR="$HOME"
LABEL="com.weclaude.daemon"

[[ -x "$NODE" ]] || { echo "node not found in PATH"; exit 1; }

# Build if missing
if [[ ! -f "$REPO/dist/daemon/index.js" ]]; then
  echo "[install] building..."
  (cd "$REPO" && npm install --silent && npx tsc -p tsconfig.json)
fi

mkdir -p "$HOME_DIR/.weclaude"

OS="$(uname -s)"
case "$OS" in
  Darwin)
    PLIST_DST="$HOME_DIR/Library/LaunchAgents/${LABEL}.plist"
    sed \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__HOME__|$HOME_DIR|g" \
      "$REPO/launchd/${LABEL}.plist.template" > "$PLIST_DST"
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load -w "$PLIST_DST"
    echo "[install] launchd loaded: $PLIST_DST"
    ;;
  Linux)
    UNIT_DIR="$HOME_DIR/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT_DST="$UNIT_DIR/weclaude.service"
    sed \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__REPO__|$REPO|g" \
      -e "s|__HOME__|$HOME_DIR|g" \
      "$REPO/systemd/weclaude.service.template" > "$UNIT_DST"
    systemctl --user daemon-reload
    systemctl --user enable --now weclaude.service
    echo "[install] systemd unit enabled: $UNIT_DST"
    ;;
  *)
    echo "unsupported OS: $OS"; exit 1 ;;
esac

echo "[install] done. Logs at $HOME_DIR/.weclaude/daemon.{stdout,stderr,log}"
