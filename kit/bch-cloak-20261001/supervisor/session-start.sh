#!/bin/zsh
# SessionStart hook (operator 2026-09-28): a supervisor session that starts in the main bch-cloak checkout inside the
# supervisor herdr workspace (wFN) claims the notify target name `supervisor-opus` and makes sure the janitor runs.
# Every other session (lane workers in worktrees, other workspaces, no herdr) is left alone.
[ "$PWD" = /Users/rewt/development/bastian/bch-cloak ] || exit 0
case "${HERDR_PANE_ID:-}" in wFN:*) ;; *) exit 0 ;; esac
herdr agent rename "$HERDR_PANE_ID" supervisor-opus >/dev/null 2>&1 || true
/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/janitor.sh start >/dev/null 2>&1 || true
echo "{\"systemMessage\": \"supervisor-opus -> $HERDR_PANE_ID; janitor running\"}"
