#!/bin/bash
# setup.sh — N-Hack Premium setup
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"
mkdir -p "$DATA_DIR"

# バイナリがなければプラグインルートからコピー
if [ ! -f "$DATA_DIR/nhack-premium" ] && [ -f "$PLUGIN_ROOT/nhack-premium" ]; then
  cp "$PLUGIN_ROOT/nhack-premium" "$DATA_DIR/nhack-premium"
  chmod +x "$DATA_DIR/nhack-premium"
  echo "[nhack-premium] Binary installed to $DATA_DIR/nhack-premium"
fi
