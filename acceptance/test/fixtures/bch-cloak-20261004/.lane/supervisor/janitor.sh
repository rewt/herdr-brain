#!/bin/zsh
# RETIRED 2026-10-03 (operator 2026-10-02 night: eliminate polling). This script polled herdr, ps or the filesystem on a timer.
# Its job is now done by supervisor-events.mjs, which acts on file events (see WORK-PATTERN.md "Event-driven supervisor").
# The old script is kept as janitor.sh.bak-20261003-retired for reference only; do not restore it.
echo "janitor.sh is retired: use .lane/supervisor/supervisor-events.mjs (WORK-PATTERN.md, 'Event-driven supervisor')" >&2
exit 1
