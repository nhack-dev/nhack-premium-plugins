#!/usr/bin/env bash
# UserPromptSubmit hook — pull keywords from the user prompt, grep the
# local memory for hits, and feed matches back via hookSpecificOutput.
# Defensive: exit 0 silently on any failure. Never block the submit.

set -u
umask 077

MEMORY_DIR="${NHACK_MEMORY_DIR:-$HOME/.nhack/memory}"
export MEMORY_DIR

if [ ! -d "$MEMORY_DIR" ]; then
  exit 0
fi

# Capture hook stdin once — it's the JSON from Claude Code.
HOOK_INPUT=$(cat 2>/dev/null || true)
export HOOK_INPUT

if [ -z "$HOOK_INPUT" ]; then
  exit 0
fi

# Do the work in python for unicode correctness. Read the captured JSON
# from the HOOK_INPUT env var (not stdin — the heredoc owns stdin here).
python3 - <<'PY' 2>/dev/null || true
import json, os, re, sys, glob

MEM = os.environ.get("MEMORY_DIR", "")
RAW = os.environ.get("HOOK_INPUT", "")

try:
    data = json.loads(RAW or "{}")
except Exception:
    sys.exit(0)

prompt = data.get("prompt", "")
if not isinstance(prompt, str) or not prompt:
    sys.exit(0)

# ASCII runs of length >= 3 + JP (hiragana/katakana/kanji) runs of length >= 3.
words = []
seen = set()
for m in re.findall(r"[A-Za-z0-9_]{3,}|[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]{3,}", prompt):
    low = m.lower()
    if low in seen:
        continue
    seen.add(low)
    words.append(m)
    if len(words) >= 12:
        break

if not words:
    sys.exit(0)

if not MEM or not os.path.isdir(MEM):
    sys.exit(0)

files = sorted(glob.glob(os.path.join(MEM, "*.md")))
if not files:
    sys.exit(0)

hits = []
for kw in words:
    kw_low = kw.lower()
    per_kw = 0
    for f in files:
        if per_kw >= 3:
            break
        try:
            with open(f, "r", encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh, 1):
                    if kw_low in line.lower():
                        hits.append(f"[{kw}] {os.path.basename(f)}:{i}: {line.rstrip()}")
                        per_kw += 1
                        break
        except Exception:
            continue
        if len(hits) >= 10:
            break
    if len(hits) >= 10:
        break

if not hits:
    sys.exit(0)

body = "[auto-recall] nhack-premium memory hits:\n" + "\n".join(hits)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": body,
    }
}, ensure_ascii=False))
PY

exit 0
