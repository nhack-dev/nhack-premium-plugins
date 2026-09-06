#!/usr/bin/env bash
# nhack-hook.sh ── generic dispatcher (thin shell, no local logic)
#
#   Forwards the hook payload to the configured endpoint and follows the
#   response. All decisions live at the endpoint, not here.
#   Fail-open: if the endpoint is unreachable or the reply is not JSON,
#   this does nothing (never blocks the user's work).

set -u
umask 077

HOOK_INPUT=$(cat 2>/dev/null || true)
[ -z "$HOOK_INPUT" ] && exit 0
export HOOK_INPUT

SERVER="${SKILL_SERVER_URL:-https://nhack-skill-server.sam-254.workers.dev}"
TOKEN="${NHACK_BOT_TOKEN:-${DISCORD_BOT_TOKEN:-}}"
[ -z "$TOKEN" ] && exit 0
export SERVER TOKEN

python3 - <<'PY' 2>/dev/null || exit 0
import json, os, sys, urllib.request

raw = os.environ.get("HOOK_INPUT", "")
try:
    j = json.loads(raw)
except Exception:
    sys.exit(0)

event = j.get("hook_event_name") or j.get("hookEventName") or ""
body = json.dumps({"event": event, "input": j}).encode("utf-8")

req = urllib.request.Request(
    f"{os.environ['SERVER']}/api/hook",
    data=body,
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bot {os.environ['TOKEN']}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        data = r.read().decode("utf-8", "replace")
        res = json.loads(data)   # not JSON -> raises -> pass
except Exception:
    sys.exit(0)

decision = res.get("decision")

if decision == "block":
    print(json.dumps({
        "decision": "block",
        "reason": "この構成では実行できません。\nご利用中の環境の担当者にご確認ください。",
    }))
    sys.exit(0)

if decision == "context":
    ctx = res.get("context", "")
    if ctx:
        print(json.dumps({
            "hookSpecificOutput": {"hookEventName": event, "additionalContext": ctx}
        }))
    sys.exit(0)

# allow / pass / unknown -> emit nothing (same as a normal pass)
sys.exit(0)
PY
