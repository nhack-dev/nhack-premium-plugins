#!/usr/bin/env bash
# PreCompact hook — right before Claude Code compacts the transcript,
# stash a recent-conversation excerpt to disk so it survives as memory.
# Defensive: exit 0 unconditionally. PreCompact does NOT support
# hookSpecificOutput — side-effect only.

set -u
umask 077

MEMORY_DIR="${NHACK_MEMORY_DIR:-$HOME/.nhack/memory}"
mkdir -p "$MEMORY_DIR" 2>/dev/null || true
export MEMORY_DIR

HOOK_INPUT=$(cat 2>/dev/null || true)
export HOOK_INPUT

if [ -z "$HOOK_INPUT" ]; then
  exit 0
fi

python3 - <<'PY' 2>/dev/null || true
import json, os, sys, datetime

RAW = os.environ.get("HOOK_INPUT", "")
MEM = os.environ.get("MEMORY_DIR", "")

try:
    data = json.loads(RAW or "{}")
except Exception:
    sys.exit(0)

if not MEM:
    sys.exit(0)

# Best-effort transcript tail grab. schemas vary — stash whatever we can.
tp = data.get("transcript_path", "")
excerpts = []
if isinstance(tp, str) and tp and os.path.isfile(tp):
    try:
        with open(tp, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()[-60:]
        for line in lines:
            try:
                obj = json.loads(line)
            except Exception:
                continue
            msg = obj.get("message") or {}
            role = msg.get("role") or obj.get("type") or "unknown"
            content = msg.get("content") or obj.get("content") or ""
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        parts.append(c.get("text", ""))
                content = "\n".join(parts)
            if isinstance(content, str) and content.strip():
                excerpts.append(f"### {role}\n{content.strip()}")
    except Exception:
        pass

now = datetime.datetime.now()
stamp = now.strftime("%Y%m%d-%H%M")
iso = now.isoformat(timespec="seconds")
trigger = data.get("trigger", "unknown")
body = "\n\n".join(excerpts) if excerpts else "(no transcript excerpt captured)"

out = (
    f"---\n"
    f"topic: compact-{stamp}\n"
    f"created: {iso}\n"
    f"updated: {iso}\n"
    f"kind: pre-compact-snapshot\n"
    f"trigger: {trigger}\n"
    f"---\n"
    f"# pre-compact snapshot ({stamp})\n\n"
    f"{body}\n"
)

path = os.path.join(MEM, f"compact-{stamp}.md")
try:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(out)
except Exception:
    pass
PY

exit 0
