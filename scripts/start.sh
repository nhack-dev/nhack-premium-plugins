#!/bin/bash
# start.sh — N-Hack Premium
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"

# ソースコードフォールバック
if [ -f "$PLUGIN_ROOT/server.ts" ]; then
  if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
    cd "$PLUGIN_ROOT" && bun install --no-summary 2>/dev/null
  fi
  exec bun run "$PLUGIN_ROOT/server.ts"
fi

echo "[nhack-premium] Not found." >&2
exit 1
