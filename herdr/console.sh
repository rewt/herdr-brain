#!/bin/sh
# The console pane. Herdr runs plugin commands with a minimal PATH, so find node first.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for n in "$(command -v node 2>/dev/null)" "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$n" ] && exec "$n" "$ROOT/console/app.mjs" "$@"
done
echo "Herdr Monitor: node not found" >&2; exit 1
