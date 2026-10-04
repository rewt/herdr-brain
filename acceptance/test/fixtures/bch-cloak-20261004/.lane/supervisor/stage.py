# Print one stage's open items, highest priority first. Read-only.
# Stage membership is meta.stage on each item (1|2|3|4|keys|parked), set by the
# operator's 2026-09-17 reset; `org status` goal counts do not show it.
import json, os, sys

d = json.load(sys.stdin)
items = d["items"]
by = {i["id"]: i for i in items}
goal = by.get("G-1", {})
open_stage = str(goal.get("meta", {}).get("stage_now", "1"))
want = (sys.argv[1] if len(sys.argv) > 1 else "") or open_stage
OPEN = ("ready", "blocked", "active")

def stage_of(i):
    return str(i.get("meta", {}).get("stage", "unstaged"))

rows = [i for i in items if i["status"] in OPEN and stage_of(i) == want]
keys = [] if len(sys.argv) > 1 else [i for i in items if i["status"] in OPEN and stage_of(i) == "keys"]
unstaged = [i for i in items if i["status"] in OPEN and stage_of(i) == "unstaged"]

def show(title, rows):
    if not rows:
        return
    print("\n" + title)
    for i in sorted(rows, key=lambda i: (-(i.get("priority") or 0), i["id"])):
        p = i.get("priority")
        p = str(p) if p is not None else "-"
        blockers = [b for b in i.get("blocked_by", []) if by.get(b, {}).get("status") in OPEN]
        state = i["status"] if not blockers else "blocked by " + ", ".join(blockers)
        role = i.get("role") or "-"
        print("  %-8s p%-4s %-10s %-42s %s" % (i["id"], p, role, state[:42], i["title"][:70]))

print("stage %s (open stage: %s)" % (want, open_stage))
show("READY AND ACTIVE", [i for i in rows if i["status"] != "blocked"])
show("BLOCKED", [i for i in rows if i["status"] == "blocked"])
show("STANDING - KEY SAFETY (at most one run)", keys)
show("UNSTAGED - park or stage these before dispatching anything", unstaged)
print("\ntotals: stage %s = %d open, keys = %d, unstaged = %d" % (want, len(rows), len(keys), len(unstaged)))
