#!/bin/sh
# SessionStart hook for Claude sessions in this repository: put the canary org and lane (this
# repository's main checkout, ~/.local/share/herdr-monitor/canary/bin) ahead of the activated
# release, so this project uses every change before a release carries it to other projects.
# CLAUDE_ENV_FILE is applied after the shell profile, which would otherwise put ~/.local/bin
# (the release) first. No canary directory, no change.
C="$HOME/.local/share/herdr-monitor/canary/bin"
[ -n "${CLAUDE_ENV_FILE:-}" ] && [ -d "$C" ] && printf 'export PATH="%s:$PATH"\n' "$C" >> "$CLAUDE_ENV_FILE"
exit 0
