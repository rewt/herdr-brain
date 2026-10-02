#!/usr/bin/env bash
# Opened only by the explicit supervisor pane. The adapter verifies canonical
# checkout identity and delivers housekeeping startup through supervisor policy.
set -euo pipefail
ENTRY_BIN=${HERDR_MONITOR_ENTRY_BIN:-${HERDR_MONITOR_HOME:-$HOME/.local/share/herdr-monitor}/entry/bin}
exec "$ENTRY_BIN/monitor-codex" --role supervisor -- "$@"
