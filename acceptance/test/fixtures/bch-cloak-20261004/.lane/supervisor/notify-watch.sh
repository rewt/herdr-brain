#!/bin/bash
# Harness-side report notification for one org run. Runs OUTSIDE any agent
# sandbox (in a herdr pane), so worker sessions never touch the herdr socket.
#
# Waits for the run's worker agent to stop. If the run's report file exists and
# `org check` passes, it queues the [org-report] line for the supervisor and
# exits. If the worker stopped without a valid report, it queues one [watch]
# line and waits for the worker to resume, then repeats. If the worker vanishes,
# it sends a final [watch] line and exits. Independent of .lane/supervisor/STOP,
# which only gates settle-session spawning.
#
# Messages are files in the outbox; supervisor-events.mjs delivers them to its
# one target (the agent named supervisor-opus). --to is only a label here:
# dispatch.sh counts runs in flight by it. If the outbox cannot be written the
# watcher exits 1 and closes no tab. Its herdr calls (one blocking agent wait at
# a time, plus agent get) are not serialized with other processes' herdr calls.
# A report written while the worker is not working (by hand, or by a background
# job of an idle worker) is seen at the next stop, or when the grace wait ends.
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
OUTBOX=${NW_OUTBOX:-/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/outbox}
WAITERS=${NW_WAITERS:-/private/tmp/bch-cloak-waiters}

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
send() {  # 2026-10-03: no herdr call and no retry loop here. The message goes to the outbox; supervisor-events.mjs delivers it
          # when the supervisor's input box is empty, and logs it to inbox.log and notify-log.tsv. Returns 1 if it could not be queued.
  if [ "$DRY" = 1 ]; then say "DRY-RUN would send to $TO: $1"; return 0; fi
  local f=$OUTBOX/$(date +%s)-$$-$RANDOM.msg
  if mkdir -p "$OUTBOX" 2>/dev/null && printf '%s' "$1" > "$f.tmp" && mv "$f.tmp" "$f"; then say "queued for $TO: $1"; return 0; fi
  say "OUTBOX WRITE FAILED ($OUTBOX): $1"; rm -f "$f.tmp"; return 1
}
valid_report() {  # the report exists, has no template placeholders, and passes org check; sets $check
  [ -f "$REPORT" ] && ! grep -qE 'PLACEHOLDER|\b[A-Z][A-Z0-9_]*_(LINE|RESULT|DETAIL|TBD|TODO)\b' "$REPORT" && check=$(org check "$REPORT" 2>&1 | grep '^ok:' | tail -1 | tr -d '\n') && [ -n "$check" ]
}
status() { herdr agent get "$AGENT" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"]["agent_status"])' 2>/dev/null || echo gone; }
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
graced=0  # 1 once this stop has had its grace wait; the next pass alerts instead of waiting again
while :; do
  if ! herdr agent wait "$AGENT" --until idle --until done --until blocked >/dev/null 2>&1; then
    send "[watch] run=$RUN item=$ITEM worker=$AGENT is gone (herdr wait failed); report present=$([ -f "$REPORT" ] && echo yes || echo no) path=$REPORT"
    exit 1
  fi
  if valid_report; then
    send "[org-report] run=$RUN item=$ITEM outcome=$(field outcome) verdict=$(field verdict) report=$REPORT -- delivered by notify-watch ($check)" \
      || { say "report notification not queued; keeping the worker tab; exit 1"; exit 1; }
    # a finished worker's tab closes once its report notification is queued (operator 2026-09-28; the report file is the record, and
    # supervisor-events delivers the notification later); blocked or needs_human keep theirs for reading
    if [ "$DRY" != 1 ] && [ "$(field outcome)" = done ]; then
      tab=$(herdr agent get "$AGENT" 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["agent"].get("tab_id",""))' 2>/dev/null)
      [ -n "$tab" ] && { sleep 20; herdr tab close "$tab" >/dev/null 2>&1 && say "closed worker tab $tab"; }
    fi
    self_close
    exit 0
  fi
  st=$(status)
  # an agent idle on purpose (it wrote $WAITERS/$RUN.slot or .file; supervisor-events.mjs wakes it) is not an alert
  if { [ "$st" = idle ] || [ "$st" = done ]; } && ! [ -f "$REPORT" ] && { [ -f "$WAITERS/$RUN.slot" ] || [ -f "$WAITERS/$RUN.file" ]; }; then
    say "worker is waiting on supervisor-events (no alert)"; herdr agent wait "$AGENT" --until working >/dev/null 2>&1 || { send "[watch] run=$RUN worker=$AGENT is gone"; exit 1; }
    say "worker resumed; waiting again"; graced=0; continue
  fi
  # grace (09-28): a Claude worker goes idle between its own background monitor events and resumes by itself; alert only if it stays
  # idle for GRACE seconds, or at once if it is blocked on a question. One blocking wait with a timeout, no polling (2026-10-03). When
  # the grace ends (idle, or blocked meanwhile), the loop goes round once more, so a report written meanwhile is checked properly
  # before any alert.
  if { [ "$st" = idle ] || [ "$st" = done ]; } && [ $graced = 0 ]; then
    t0=$(date +%s)
    herdr agent wait "$AGENT" --until working --until blocked --timeout $(( ${GRACE:-900} * 1000 )) >/dev/null 2>&1
    st=$(status); waited=$(( $(date +%s) - t0 ))
    if [ "$st" = working ]; then say "worker resumed within grace ($waited s); waiting again"; continue; fi
    graced=1; say "grace over ($waited s, now $st); checking the report again"; continue  # idle or blocked: valid_report runs first
  fi
  if [ -f "$REPORT" ] && grep -qE 'PLACEHOLDER|\b[A-Z][A-Z0-9_]*_(LINE|RESULT|DETAIL|TBD|TODO)\b' "$REPORT"; then why="report still has placeholders"; elif [ -f "$REPORT" ]; then why="report fails org check"; else why="no report yet"; fi
  send "[watch] run=$RUN item=$ITEM worker=$AGENT stopped ($st): $why; check its pane" || exit 1
  herdr agent wait "$AGENT" --until working >/dev/null 2>&1 || { send "[watch] run=$RUN worker=$AGENT is gone"; exit 1; }
  say "worker resumed; waiting again"; graced=0
done
