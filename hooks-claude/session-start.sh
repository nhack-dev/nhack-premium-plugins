#!/usr/bin/env bash
# SessionStart hook — inject the most recently updated memory topics into
# the session as <context>. Runs at Claude Code session boot. Defensive:
# exit 0 unconditionally so a bad memory dir never blocks a session.

set -u
umask 077

MEMORY_DIR="${NHACK_MEMORY_DIR:-$HOME/.nhack/memory}"

# No memory yet → silently do nothing.
if [ ! -d "$MEMORY_DIR" ]; then
  exit 0
fi

# Find top 10 most recently modified *.md by mtime. macOS and Linux diverge
# on `stat` flags, so list+sort via `ls -t` (newest first, safe for names
# without newlines — topics are sanitized to [A-Za-z0-9_-] server-side).
files=$(cd "$MEMORY_DIR" 2>/dev/null && ls -t *.md 2>/dev/null | head -10)

if [ -z "$files" ]; then
  exit 0
fi

{
  echo "<context>"
  echo "# nhack-premium memory — recent topics"
  echo ""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    path="$MEMORY_DIR/$f"
    [ -f "$path" ] || continue
    topic="${f%.md}"
    # per-file cap: 40 lines. Keeps session-start light even if a topic
    # has accumulated many entries.
    echo "## $topic"
    head -40 "$path" 2>/dev/null || true
    echo ""
    echo "---"
    echo ""
  done <<< "$files"
  echo "</context>"
} 2>/dev/null

exit 0
