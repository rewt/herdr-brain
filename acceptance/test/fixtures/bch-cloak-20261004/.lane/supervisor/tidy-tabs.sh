#!/bin/bash
# Tidy the bch-cloak herdr console (operator request, 2026-09-24): close what is
# finished, keep what is live, and surface notifications the supervisor may
# have missed. Safe to run at any time; run it at every settlement and at the
# start and end of every supervisor shift.
#
#   1. In the supervisor workspace (default wFN), close every "watch R-n" tab
#      whose org run is no longer open (reported, abandoned, closed).
#   2. Close every herdr workspace labelled lane-<topic> whose lane is gone
#      (no lane/<topic> branch and no worktree at ~/.herdr/worktrees/bch-cloak/lane-<topic>).
#      Open lanes keep their workspace: fix rounds re-prompt the same agent.
#   3. Print the last notify-log entries, so a notification swallowed by an
#      open dialog in the supervisor pane is noticed and settled.
#
# Never touches: the supervisor tab, operator tabs (org, cli, anything not
# named "watch R-n"), long-run tabs (e.g. 5.1b measurements), or any workspace
# of another project (labels outside ^lane-[a-z0-9-]+$).
#
# Usage: tidy-tabs.sh [--dry-run] [--workspace wFN] [--log-lines N]
set -u
WS=wFN DRY=0 N=8
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --workspace) WS=$2; shift 2 ;;
    --log-lines) N=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
export ORG_DIR=${ORG_DIR:-/Users/rewt/development/bastian/.org}
REPO=/Users/rewt/development/bastian/bch-cloak
WT=/Users/rewt/.herdr/worktrees/bch-cloak
act() { if [ "$DRY" = 1 ]; then echo "DRY-RUN: $*"; else "$@" >/dev/null 2>&1 && echo "done: $*" || echo "FAILED: $*"; fi; }

echo "== watcher tabs in $WS"
herdr tab list --workspace "$WS" | python3 -c '
import json,sys,re
for t in json.load(sys.stdin)["result"]["tabs"]:
    m=re.fullmatch(r"(?:watch|notify) (R-\d+)", t.get("label") or "")
    if m: print(t["tab_id"], m.group(1))' | while read -r tab run; do
  state=$(org show "$run" 2>/dev/null | sed -n 's/^state: //p' | head -1)
  case "$state" in
    open*|"") echo "keep  $tab $run (${state:-unknown state})" ;;
    *) echo "close $tab $run ($state)"; act herdr tab close "$tab" ;;
  esac
done

echo "== lane workspaces"
herdr workspace list | python3 -c '
import json,sys,re
for w in json.load(sys.stdin)["result"]["workspaces"]:
    l=w.get("label") or ""
    if re.fullmatch(r"lane-[a-z0-9-]+", l): print(w["workspace_id"], l)' | while read -r ws label; do
  topic=${label#lane-}
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/lane/$topic" || [ -d "$WT/$label" ]; then
    echo "keep  $ws $label (lane open)"
  else
    echo "close $ws $label (lane closed)"; act herdr workspace close "$ws"
  fi
done

LOG=$REPO/.lane/supervisor/notify-log.tsv
echo "== last $N notify-log entries (settle any report you have not seen)"
[ -f "$LOG" ] && tail -n "$N" "$LOG" | cut -c1-220 || echo "(no log yet)"

# Provider balance (operator 2026-09-28; policy: selection_policy in scripts/lane/routing.json).
# Counts org runs started in the last 24 hours by provider, route class and effort.
echo "== provider balance, runs started in the last 24 h (policy: scripts/lane/routing.json selection_policy)"
python3 - "${ORG_DIR:-/Users/rewt/development/bastian/.org}/events.jsonl" <<'PY' || echo "(balance tally failed)"
import json, sys, collections, datetime
cut = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
by = collections.Counter(); cls = collections.Counter(); total = 0
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e.get("type") != "run.started": continue
    if datetime.datetime.fromisoformat(e["at"].replace("Z", "+00:00")) < cut: continue
    m = e.get("meta", {}); h = m.get("harness", "?"); r = m.get("route", "?")
    kind = "settle" if r.startswith("settle") else "review" if r.startswith("review") else "engineer" if r.startswith("engineer") else r
    by[(h, m.get("effort", "?"))] += 1; cls[(h, kind)] += 1; total += 1
if not total: print("  no runs"); sys.exit(0)
for h in sorted({k[0] for k in by}):
    n = sum(v for k, v in by.items() if k[0] == h)
    eff = ", ".join(f"{e} {v}" for (hh, e), v in sorted(by.items()) if hh == h)
    kinds = ", ".join(f"{k} {v}" for (hh, k), v in sorted(cls.items()) if hh == h)
    print(f"  {h:7} {n:3} runs ({100*n//total}%)  effort: {eff}  |  {kinds}")
PY

# Finished agent tabs in lane workspaces (operator 2026-09-28): close every done/idle agent whose org run is over.
echo "== finished agent tabs"
/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/close-finished-agents.sh | sed 's/^/  /' || echo "  (close-finished-agents failed)"
