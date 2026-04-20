#!/usr/bin/env bash
# SessionEnd hook — drop an auto-handover note listing today's touched
# topics + a preview, so the next session starts oriented.
# Defensive: exit 0 unconditionally. SessionEnd does NOT support
# hookSpecificOutput — side-effect only.

set -u
umask 077

MEMORY_DIR="${NHACK_MEMORY_DIR:-$HOME/.nhack/memory}"
mkdir -p "$MEMORY_DIR" 2>/dev/null || true
export MEMORY_DIR

HOOK_INPUT=$(cat 2>/dev/null || true)
export HOOK_INPUT

python3 - <<'PY' 2>/dev/null || true
import json, os, sys, datetime, glob

MEM = os.environ.get("MEMORY_DIR", "")
RAW = os.environ.get("HOOK_INPUT", "")

if not MEM or not os.path.isdir(MEM):
    sys.exit(0)

try:
    data = json.loads(RAW or "{}")
except Exception:
    data = {}
reason = data.get("reason", "unknown")

# Gather topics updated today.
today = datetime.date.today()
topics = []
for f in glob.glob(os.path.join(MEM, "*.md")):
    try:
        mtime = os.path.getmtime(f)
    except Exception:
        continue
    if datetime.date.fromtimestamp(mtime) != today:
        continue
    name = os.path.basename(f)[:-3]
    if name.startswith("handover-") or name == "handover":
        continue
    # Pull the first non-frontmatter heading for a preview.
    title = name
    try:
        with open(f, "r", encoding="utf-8", errors="replace") as fh:
            body = fh.read()
        if body.startswith("---\n"):
            end = body.find("\n---\n", 4)
            if end != -1:
                body = body[end + 5:]
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("# "):
                title = line[2:].strip() or name
                break
    except Exception:
        pass
    topics.append((mtime, name, title))

topics.sort(reverse=True)

now = datetime.datetime.now()
stamp = now.strftime("%Y%m%d-%H%M")
iso = now.isoformat(timespec="seconds")

lines = [
    "---",
    f"topic: handover-{stamp}",
    f"created: {iso}",
    f"updated: {iso}",
    "kind: session-end-handover",
    f"reason: {reason}",
    "---",
    f"# handover ({stamp})",
    "",
    f"Session ended: {iso}  (reason: {reason})",
    "",
    "## Topics touched today",
    "",
]
if topics:
    for mt, name, title in topics:
        ts = datetime.datetime.fromtimestamp(mt).strftime("%H:%M")
        lines.append(f"- [{ts}] **{name}** — {title}")
else:
    lines.append("- (none)")
lines.append("")

path = os.path.join(MEM, f"handover-{stamp}.md")
try:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
except Exception:
    pass
PY

exit 0
