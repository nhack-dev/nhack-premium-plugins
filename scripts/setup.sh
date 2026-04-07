#!/bin/bash
# setup.sh — 依存パッケージインストール
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$PLUGIN_ROOT"
if [ ! -d "node_modules" ]; then
  bun install --frozen-lockfile 2>/dev/null || bun install
fi
