#!/bin/zsh
# SessionStart hook (operator 2026-09-28): a supervisor session that starts in the main bch-cloak checkout inside the
# supervisor herdr workspace (wFN) claims the notify target name `supervisor-opus`. It starts nothing.
# Every other session (lane workers in worktrees, other workspaces, no herdr) is left alone.
[ "$PWD" = /Users/rewt/development/bastian/bch-cloak ] || exit 0
case "${HERDR_PANE_ID:-}" in wFN:*) ;; *) exit 0 ;; esac
herdr agent rename "$HERDR_PANE_ID" supervisor-opus >/dev/null 2>&1 || true
# 2026-10-03: no polling daemon starts from this hook. The janitor it used to start relaunched slot-notify and gate-queue at
# 08:09 on 10-03, despite PAUSED, when herdr restored this pane after the reboot. Event-driven tooling is started by hand only.
echo "{\"systemMessage\": \"supervisor-opus -> $HERDR_PANE_ID; no supervisor daemons started (see .lane/supervisor/WORK-PATTERN.md)\"}"
