#!/usr/bin/env bash
# Stop hook — when a turn ends, scan the last assistant message for
# learn/decide keywords and nudge the user (via stderr) to save it.
# Never blocks: exit 0 unconditionally. Stop events do NOT support
# hookSpecificOutput per the Claude Code schema (2026-04-19 lesson),
# so this hook is stderr-only.

set -u
umask 077

MEMORY_DIR="${NHACK_MEMORY_DIR:-$HOME/.nhack/memory}"
export MEMORY_DIR

HOOK_INPUT=$(cat 2>/dev/null || true)
export HOOK_INPUT

if [ -z "$HOOK_INPUT" ]; then
  exit 0
fi

# All logic is wrapped in a single python try/except so accidental python
# noise never leaks to stderr. We reserve stderr for the intentional nudge.
python3 - <<'PY' || true
import json, os, sys, glob, time

def main():
    RAW = os.environ.get("HOOK_INPUT", "")
    MEM = os.environ.get("MEMORY_DIR", "")

    try:
        data = json.loads(RAW or "{}")
    except Exception:
        return

    tp = data.get("transcript_path", "")
    last_text = ""
    if isinstance(tp, str) and tp and os.path.isfile(tp):
        try:
            with open(tp, "r", encoding="utf-8", errors="replace") as fh:
                tail = fh.readlines()[-200:]
            for line in reversed(tail):
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                msg = obj.get("message") or {}
                if obj.get("type") == "assistant" or msg.get("role") == "assistant":
                    content = msg.get("content") or obj.get("content")
                    if isinstance(content, str):
                        last_text = content
                        break
                    if isinstance(content, list):
                        parts = []
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "text":
                                parts.append(c.get("text", ""))
                        if parts:
                            last_text = "\n".join(parts)
                            break
        except Exception:
            return

    if not last_text:
        return

    triggers = ["学び", "教訓", "決定", "重要", "lesson", "decision", "important", "learned"]
    lt_low = last_text.lower()
    hit = next((t for t in triggers if t.lower() in lt_low), None)
    if not hit:
        return

    # Suppress if any memory file was touched within the last 2 minutes.
    try:
        if MEM and os.path.isdir(MEM):
            now = time.time()
            for f in glob.glob(os.path.join(MEM, "*.md")):
                try:
                    if now - os.path.getmtime(f) < 120:
                        return
                except Exception:
                    continue
    except Exception:
        pass

    sys.stderr.write(f'📝 新しい学び? save_memory で保存を検討 (trigger: "{hit}")\n')

try:
    main()
except Exception:
    pass
PY

exit 0
