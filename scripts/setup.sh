#!/bin/bash
# setup.sh — N-Hack Premium setup
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/discord}"
mkdir -p "$DATA_DIR"

