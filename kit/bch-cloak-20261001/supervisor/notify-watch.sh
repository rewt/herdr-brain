#!/bin/bash
# Harness-side report notification for one org run. Runs OUTSIDE any agent
# sandbox (in a herdr pane), so worker sessions never touch the herdr socket.
#
# Waits for the run's worker agent to stop. If the run's report file exists and
# `org check` passes, it sends the [org-report] line to the supervisor itself and
# exits. If the worker stopped without a valid report, it sends one [watch]
# line and waits for the worker to resume, then repeats. If the worker vanishes,
# it sends a final [watch] line and exits. Independent of .lane/supervisor/STOP,
# which only gates settle-session spawning.
#
# Usage: notify-watch.sh R-n [--to AGENT] [--agent NAME] [--report PATH] [--dry-run]
set -u
RUN=${1:?usage: notify-watch.sh R-n [--to AGENT] [--agent NAME] [--report PATH] [--dry-run]}
shift
TO=supervisor-fable AGENT= REPORT= DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO=$2; shift 2 ;;
    --agent) AGENT=$2; shift 2 ;;
    --report) REPORT=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
export ORG_DIR=${ORG_DIR:-/Users/rewt/development/bastian/.org}

meta=$(org show "$RUN" --json | python3 -c '
import json,sys
d=json.load(sys.stdin); r=d.get("run",d)
m=r.get("meta") or {}
print(r.get("item",""), m.get("agent",""), r.get("report_path",""), sep="\t")') || { echo "cannot read $RUN from org" >&2; exit 2; }
IFS=$'\t' read -r ITEM META_AGENT META_REPORT <<<"$meta"
AGENT=${AGENT:-$META_AGENT}
REPORT=${REPORT:-$META_REPORT}
[ -n "$AGENT" ] || { echo "$RUN has no meta.agent; pass --agent" >&2; exit 2; }
[ -n "$REPORT" ] || { echo "$RUN has no report path; pass --report" >&2; exit 2; }

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
LOG=/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/notify-log.tsv
send() {  # every message is also appended to notify-log.tsv: a prompt sent while the
          # supervisor has a dialog open is swallowed, and the log is how it is found again
  if [ "$DRY" = 1 ]; then say "DRY-RUN would send to $TO: $1"; return 0; fi
  # retry: a busy pane or a transient herdr error must not lose a report (FAILED x15 on 09-27/28
  # was the target name missing from the pane, fixed by `herdr agent rename wFN:p1 supervisor-opus`)
  st=FAILED; err=
  for try in 1 2 3 4 5; do
    # deliver to the supervisor tab (operator 2026-09-28): the pane in wFN's tab labelled "supervisor", whatever its id
    dest=$(herdr tab list --workspace wFN 2>/dev/null | python3 -c "import sys,json
d=json.load(sys.stdin)['result']; t=d.get('tabs',d)
print(next((x['tab_id'] for x in t if (x.get('label') or '')=='supervisor'),''))")
    if [ -n "$dest" ]; then
      dest=$(herdr agent list 2>/dev/null | python3 -c "import sys,json
a=json.load(sys.stdin)['result']['agents']; print(next((x['pane_id'] for x in a if x.get('tab_id')==sys.argv[1]),''))" "$dest")
    fi
    [ -n "$dest" ] && herdr agent rename "$dest" "$TO" >/dev/null 2>&1
    if err=$(herdr agent prompt "${dest:-$TO}" "$1" 2>&1 >/dev/null); then st=sent; break; fi
    say "send attempt $try to $TO failed: ${err:0:160}"; sleep 30
  done
  if [ $st = sent ]; then say "sent to $TO: $1"; else say "SEND FAILED to $TO: $1"; fi
  printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$RUN" "$st" "$1" >> "$LOG"
}
self_close() {  # a watcher whose report was delivered closes its own tab (tidy panes, 2026-09-24)
  [ "$DRY" = 1 ] && return 0
  [ -n "${HERDR_PANE_ID:-}" ] || return 0
  # only ever close a notify/watch tab: a detached watcher can inherit the supervisor pane's id (09-28 incident)
  lbl=$(herdr tab list --workspace "${HERDR_PANE_ID%%:*}" 2>/dev/null | python3 -c "import sys,json
d=json.load(sys.stdin)['result']; t=d.get('tabs',d)
print(next((x.get('label') or '' for x in t if x.get('tab_id')==sys.argv[1]),''))" "$(herdr pane get "$HERDR_PANE_ID" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"].get("tab_id",""))' 2>/dev/null)")
  case "$lbl" in "notify R-"*|"watch R-"*) ;; *) return 0 ;; esac
  say "delivered; closing this watcher pane in 5 s"
  sleep 5
  herdr pane close "$HERDR_PANE_ID" >/dev/null 2>&1 || true
}
field() {  # first front-matter value of key $1 in the report
  python3 - "$REPORT" "$1" <<'PY'
import sys,re
t=open(sys.argv[1],errors="ignore").read()
m=re.match(r"---\n(.*?)\n---",t,re.S)
fm=m.group(1) if m else ""
v=re.search(r"^"+re.escape(sys.argv[2])+r":\s*(.*)$",fm,re.M)
print((v.group(1).strip().strip('"') if v else "n/a")[:40])
PY
}

say "watching $RUN ($ITEM): worker $AGENT, report $REPORT, notify $TO"
while :; do
  if ! herdr agent wait "$AGENT" --until idle --until done --until blocked >/dev/null 2>&1; then
    send "[watch] run=$RUN item=$ITEM worker=$AGENT is gone (herdr wait failed); report present=$([ -f "$REPORT" ] && echo yes || echo no) path=$REPORT"
    exit 1
  fi
  if [ -f "$REPORT" ] && ! grep -qE 'PLACEHOLDER|\b[A-Z][A-Z0-9_]*_(LINE|RESULT|DETAIL|TBD|TODO)\b' "$REPORT" && check=$(org check "$REPORT" 2>&1 | grep '^ok:' | tail -1 | tr -d '\n') && [ -n "$check" ]; then
    send "[org-report] run=$RUN item=$ITEM outcome=$(field outcome) verdict=$(field verdict) report=$REPORT -- delivered by notify-watch ($check)"
    # a finished worker's tab closes itself (operator 2026-09-28); blocked or needs_human keep theirs for reading
    if [ "$DRY" != 1 ] && [ "$(field outcome)" = done ]; then
      tab=$(herdr agent get "$AGENT" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"].get("tab_id",""))' 2>/dev/null)
      [ -n "$tab" ] && { sleep 20; herdr tab close "$tab" >/dev/null 2>&1 && say "closed worker tab $tab"; }
    fi
    self_close
    exit 0
  fi
  # grace (09-28): a Claude worker goes idle between its own background monitor events and resumes by
  # itself; alert only if it stays idle for GRACE seconds, or at once if it is blocked on a question.
  st=$(herdr agent get "$AGENT" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])' 2>/dev/null || echo gone)
  waited=0
  while { [ "$st" = idle ] || [ "$st" = done ]; } && [ $waited -lt ${GRACE:-900} ] && ! [ -f "$REPORT" ]; do
    sleep 20; waited=$((waited+20))
    st=$(herdr agent get "$AGENT" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])' 2>/dev/null || echo gone)
  done
  if [ "$st" = working ]; then say "worker resumed within grace ($waited s); waiting again"; continue; fi
  if [ -f "$REPORT" ] && grep -qE 'PLACEHOLDER|\b[A-Z][A-Z0-9_]*_(LINE|RESULT|DETAIL|TBD|TODO)\b' "$REPORT"; then why="report still has placeholders"; elif [ -f "$REPORT" ]; then why="report fails org check"; else why="no report yet"; fi
  send "[watch] run=$RUN item=$ITEM worker=$AGENT stopped ($st, idle ${waited}s): $why; check its pane"
  herdr agent wait "$AGENT" --until working >/dev/null 2>&1 || { send "[watch] run=$RUN worker=$AGENT is gone"; exit 1; }
  say "worker resumed; waiting again"
done
