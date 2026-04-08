#!/bin/bash
# start.sh — N-Hack Premium（ソースコード直接実行）
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec bun run "$PLUGIN_ROOT/server.ts"
