#!/bin/zsh
# usage: resume-interrupted.sh [--dry-run]
# Auto-resume (operator 2026-09-29): a Codex session in the alternate screen turns on mouse tracking, so a mouse-wheel
# scroll over its pane reaches its input as ESC[<65;x;yM. Codex reads the ESC as an interrupt and the rest as typed
# text. For every idle agent in a lane workspace whose composer holds such a sequence and whose screen shows the
# interruption, clear the composer and tell it to continue. Acts once per agent state change. Never touches wFN.
# New Codex sessions no longer capture the mouse (~/.codex/config.toml tui.alternate_screen = "never"); this covers
# sessions started before that change.
set -u
DRY=${1:-}
S=/Users/rewt/development/bastian/bch-cloak/.lane/supervisor
SEEN=$S/watch-logs/resume-seen.txt; touch $SEEN
MSG="Supervisor: your session was interrupted by a stray mouse-wheel escape sequence from the terminal, not by an instruction. Ignore it and continue exactly where you left off."
herdr agent list 2>/dev/null | python3 -c '
import sys,json
for a in json.load(sys.stdin)["result"]["agents"]:
    if a.get("workspace_id")=="wFN" or "/.herdr/worktrees/bch-cloak/lane-" not in a.get("cwd",""): continue
    if a.get("agent_status")!="idle": continue
    print(a["pane_id"], a.get("state_change_seq"))' | while read -r pane seq; do
  key="$pane $seq"
  grep -qxF "$key" $SEEN && continue
  verdict=$(herdr agent read $pane --source visible 2>/dev/null | python3 -c '
import sys,re
lines=sys.stdin.read().splitlines()
junk=re.compile(r"<6[4-7];\d+;\d+[Mm]")
composer=[l for l in lines if l.lstrip().startswith("›")]
tail="\n".join(lines[-40:])
print("yes" if composer and junk.search(composer[-1]) and re.search(r"interrupted",tail,re.I) else "no")')
  [ "$verdict" = yes ] || continue
  if [ "$DRY" = --dry-run ]; then echo "would resume $pane"; continue; fi
  herdr agent send-keys $pane ctrl+e ctrl+u ctrl+u >/dev/null 2>&1
  sleep 1
  herdr agent prompt $pane "$MSG" >/dev/null 2>&1 && echo "resumed $pane (seq $seq)" || echo "could not resume $pane"
  echo "$key" >> $SEEN
done
