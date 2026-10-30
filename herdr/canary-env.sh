#!/bin/sh
# Retained SessionStart entry: operations use the installed project-pin resolver.
# Development remains available by an explicit source path. This hook changes
# only future session PATH, never an installation, pin, controller or saved job.
C="$HOME/.local/bin"
[ -n "${CLAUDE_ENV_FILE:-}" ] && [ -d "$C" ] && printf 'export PATH="%s:$PATH"\n' "$C" >> "$CLAUDE_ENV_FILE"
exit 0
