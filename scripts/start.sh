#!/bin/bash
# start.sh — N-Hack Premium (binary execution with auto-update)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"

# キャッシュにバイナリがあり、DATA_DIRより新しければ自動更新
if [ -f "$PLUGIN_ROOT/nhack-premium" ]; then
  if [ ! -f "$DATA_DIR/nhack-premium" ] || [ "$PLUGIN_ROOT/nhack-premium" -nt "$DATA_DIR/nhack-premium" ]; then
    mkdir -p "$DATA_DIR"
    cp "$PLUGIN_ROOT/nhack-premium" "$DATA_DIR/nhack-premium"
    chmod +x "$DATA_DIR/nhack-premium"
  fi
fi

# DATA_DIRのバイナリを実行
if [ -f "$DATA_DIR/nhack-premium" ]; then
  exec "$DATA_DIR/nhack-premium"
fi

# ソースコードフォールバック
if [ -f "$PLUGIN_ROOT/server.ts" ]; then
  if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
    cd "$PLUGIN_ROOT" && bun install --no-summary 2>/dev/null
  fi
  exec bun run "$PLUGIN_ROOT/server.ts"
fi

echo "[nhack-premium] Not found." >&2
exit 1
