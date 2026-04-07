#!/bin/bash
# start.sh — 150万プレミアム版（ソースコード直接実行・シンプル！）
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec bun run "$PLUGIN_ROOT/server.ts"
