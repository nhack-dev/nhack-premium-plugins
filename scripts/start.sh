#!/bin/bash
# start.sh — N-Hack Premium (binary execution)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"

# 1. DATA_DIRにバイナリがあれば実行
if [ -f "$DATA_DIR/nhack-premium" ]; then
  exec "$DATA_DIR/nhack-premium"
fi

# 2. PLUGIN_ROOT（キャッシュ）にバイナリがあれば、DATA_DIRにコピーして実行
if [ -f "$PLUGIN_ROOT/nhack-premium" ]; then
  mkdir -p "$DATA_DIR"
  cp "$PLUGIN_ROOT/nhack-premium" "$DATA_DIR/nhack-premium"
  chmod +x "$DATA_DIR/nhack-premium"
  exec "$DATA_DIR/nhack-premium"
fi

# 3. ソースコードフォールバック
if [ -f "$PLUGIN_ROOT/server.ts" ]; then
  if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
    cd "$PLUGIN_ROOT" && bun install --no-summary 2>/dev/null
  fi
  exec bun run "$PLUGIN_ROOT/server.ts"
fi

echo "[nhack-premium] Not found." >&2
exit 1
