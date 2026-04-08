#!/bin/bash
# start.sh — N-Hack Premium (binary execution)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"

# バイナリがあればバイナリ実行（安定！依存関係ゼロ！）
if [ -f "$DATA_DIR/nhack-premium" ]; then
  exec "$DATA_DIR/nhack-premium"
fi

# バイナリがなければソースコード実行（フォールバック）
if [ -f "$PLUGIN_ROOT/server.ts" ]; then
  # node_modulesがなければインストール
  if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
    cd "$PLUGIN_ROOT" && bun install --no-summary 2>/dev/null
  fi
  exec bun run "$PLUGIN_ROOT/server.ts"
fi

echo "[nhack-premium] Binary not found. Run setup first." >&2
exit 1
