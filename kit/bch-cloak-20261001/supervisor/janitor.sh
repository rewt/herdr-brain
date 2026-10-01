#!/bin/zsh
# usage: janitor.sh [start|stop|status|once]
# Automatic console housekeeping (operator 2026-09-28): every 10 minutes, close finished agent tabs in lane workspaces
# and notify/watch tabs whose org run is over, so the console only shows sessions that are running or waiting on the
# operator. Every minute, resume a lane session that a stray mouse-wheel sequence interrupted (resume-interrupted.sh,
# operator 2026-09-29). Runs detached; one instance at a time (pid file). Logs to .lane/supervisor/watch-logs/janitor.log.
set -u
S=/Users/rewt/development/bastian/bch-cloak/.lane/supervisor
PID=$S/watch-logs/janitor.pid; LOG=$S/watch-logs/janitor.log
mkdir -p $S/watch-logs
once() {
  { echo "== $(date '+%Y-%m-%d %H:%M:%S')"
    $S/close-finished-agents.sh 2>&1 | sed 's/^/  /'
    $S/tidy-tabs.sh 2>&1 | grep -E '^close|closed' | sed 's/^/  /'
  } >> $LOG 2>&1
}
resume() { out=$($S/resume-interrupted.sh 2>&1); [ -n "$out" ] && { echo "== $(date '+%Y-%m-%d %H:%M:%S') resume"; echo "$out" | sed 's/^/  /'; } >> $LOG 2>&1; true; }
case ${1:-status} in
  once) once ;;
  tick) resume; last=$(cat $S/watch-logs/janitor.last 2>/dev/null || echo 0)
        if [ $(( $(date +%s) - last )) -ge 540 ]; then date +%s > $S/watch-logs/janitor.last; once; fi; true ;;
  start)
    if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "janitor already running (pid $(cat $PID))"; exit 0; fi
    $S/janitor.sh once; nohup zsh -c "while :; do $S/janitor.sh tick; sleep 60; done" > /dev/null 2>&1 < /dev/null &!
    sleep 1; pgrep -f "janitor.sh tick; sleep 60" | head -1 > $PID; echo "janitor started (pid $(cat $PID)), log $LOG" ;;
  stop) [ -f $PID ] && kill $(cat $PID) 2>/dev/null; rm -f $PID; echo "janitor stopped" ;;
  status) if [ -f $PID ] && kill -0 $(cat $PID) 2>/dev/null; then echo "janitor running (pid $(cat $PID))"; tail -5 $LOG; else echo "janitor not running"; fi ;;
esac
