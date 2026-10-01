#!/bin/zsh
# usage: close-finished-agents.sh [--dry-run]
# Closes the herdr tab of every finished agent in a bch-cloak lane workspace (operator 2026-09-28):
# an agent whose status is done or idle and whose org run is no longer open (reported or abandoned),
# or an agent that belongs to no org run at all. Never touches the supervisor workspace (wFN),
# a working or blocked agent, or an agent whose run is still open.
set -eu
DRY=${1:-}
export ORG_DIR=${ORG_DIR:-/Users/rewt/development/bastian/.org}
open=$(node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs status --json | python3 -c '
import sys,json
for r in json.load(sys.stdin)["runs"]:
    import os
    if r.get("report") is None and r.get("abandoned") is None and (r.get("meta") or {}).get("agent"):
        # an open run whose report file already exists is finished for tab purposes: the report is the record
        if r.get("report_path") and os.path.exists(r["report_path"]): continue
        print(r["meta"]["agent"])')
herdr agent list 2>/dev/null | python3 -c '
import sys,json
open_agents=set(sys.argv[1].split())
seen=set()
for a in json.load(sys.stdin)["result"]["agents"]:
    cwd=a.get("cwd","")
    if "/.herdr/worktrees/bch-cloak/lane-" not in cwd or a.get("workspace_id")=="wFN": continue
    if a.get("agent_status") not in ("done","idle"): continue
    name=a.get("name") or ""
    if name in open_agents: continue
    tab=a.get("tab_id")
    if tab and tab not in seen:
        seen.add(tab); print(tab, name or "(unnamed)", cwd.rsplit("/",1)[-1])
' "$open" | while read -r tab name lane; do
  if [ "$DRY" = --dry-run ]; then echo "would close $tab ($name, $lane)"; else
    herdr tab close "$tab" >/dev/null 2>&1 && echo "closed $tab ($name, $lane)" || echo "could not close $tab ($name)"; fi
done
# tabs with no live agent (a session that failed to start or exited) in bch-cloak lane workspaces, except each
# workspace's first tab
herdr workspace list 2>/dev/null | python3 -c 'import sys,json
d=json.load(sys.stdin)["result"]; ws=d.get("workspaces",d)
for w in ws:
    l=str(w.get("label") or "")
    if l.startswith("lane-"): print(w["workspace_id"])' | while read -r ws; do
  herdr tab list --workspace $ws 2>/dev/null | python3 -c 'import sys,json
d=json.load(sys.stdin)["result"]; t=d.get("tabs",d)
for x in t[1:]:
    if x.get("agent_status") in ("unknown",None,"") : print(x["tab_id"])' | while read -r tab; do
    if [ "$DRY" = --dry-run ]; then echo "would close agentless $tab"; continue; fi
    # a session that is still starting can read as unknown for a few seconds: confirm a minute later
    sleep 60
    st=$(herdr tab list --workspace $ws 2>/dev/null | python3 -c "import sys,json
d=json.load(sys.stdin)['result']; t=d.get('tabs',d)
print(next((x.get('agent_status') or '' for x in t if x['tab_id']=='$tab'),'gone'))")
    case "$st" in unknown|"") herdr tab close "$tab" >/dev/null 2>&1 && echo "closed agentless $tab" ;; esac
  done
done
