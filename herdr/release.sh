#!/usr/bin/env bash
# Immutable local releases. The operator controls activation and distribution.
# Usage: release.sh build TAG [--live] | activate TAG | rollback | status
# HERDR_MONITOR_HOME, HERDR_MONITOR_BIN and HERDR_MONITOR_REPO select destinations.
# HERDR_MONITOR_PLIST selects the retired Brain LaunchAgent to check.
set -euo pipefail
HOME_DIR=${HERDR_MONITOR_HOME:-$HOME/.local/share/herdr-monitor}
BIN_DIR=${HERDR_MONITOR_BIN:-$HOME/.local/bin}
REPO=${HERDR_MONITOR_REPO:-}
LEGACY_PLIST=${HERDR_MONITOR_PLIST:-$HOME/Library/LaunchAgents/com.rewt.herdr-brain.plist}
LAUNCHERS="org:bin/org.mjs record:bin/org.mjs lane:lanes/lane.mjs"
die() { echo "release: $*" >&2; exit 1; }
say() { echo "release: $*"; }
valid_tag() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] && git check-ref-format "refs/tags/$1" >/dev/null || die "invalid release identifier: $1"
}
absent_or_link() {
  [ ! -e "$1" ] || [ -L "$1" ] || die "$1 is not a link; refusing to replace it"
}
build() {
  local tag=$1 dir="$HOME_DIR/releases/$1" live=${2:-}
  valid_tag "$tag"
  [ -n "$REPO" ] || REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
  git -C "$REPO" rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null || die "no tag $tag in $REPO"
  [ ! -e "$dir" ] && [ ! -L "$dir" ] || die "$dir already exists; a release is never rebuilt in place"
  mkdir -p "$HOME_DIR/releases"
  mkdir "$dir.partial" || die "$dir.partial already exists; inspect the unfinished build"
  git -C "$REPO" archive "refs/tags/$tag" | tar -x -C "$dir.partial"
  git -C "$REPO" rev-parse "refs/tags/$tag^{commit}" > "$dir.partial/.release-commit"
  for file in bin/org.mjs lanes/lane.mjs contrib/settle-watch.mjs lib/cli-help.mjs; do
    [ -f "$dir.partial/$file" ] || die "release is missing $file"
  done
  (cd "$dir.partial" && node --input-type=module <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import { validateValidation } from './lanes/validation.mjs';
import { runGateSync } from './test-slot/run.mjs';
const declared = fs.existsSync('.lane.validation.json')
  ? validateValidation(JSON.parse(fs.readFileSync('.lane.validation.json', 'utf8'))) : {};
const timeoutSeconds = typeof declared.timeout_seconds === 'object'
  ? declared.timeout_seconds.release : declared.timeout_seconds;
const idleTimeoutSeconds = typeof declared.idle_timeout_seconds === 'object'
  ? declared.idle_timeout_seconds.release : declared.idle_timeout_seconds;
const run = runGateSync('release snapshot', ['/bin/sh', '-c', declared.release ?? 'npm run test:release'], {
  tier: 'release', timeoutSeconds, idleTimeoutSeconds, retryTimeout: false, stdio: 'inherit',
});
if (run.error) console.error(run.error.message);
process.exitCode = run.status ?? (run.signal ? 128 + (os.constants.signals[run.signal] ?? 0) : 1);
NODE
  )
  if [ "$live" = --live ]; then
    (cd "$dir.partial" && node acceptance/run.mjs --candidate "$dir.partial")
  fi
  mv "$dir.partial" "$dir"
  chmod -R a-w "$dir"
  say "built $tag at $dir ($(cut -c1-8 "$dir/.release-commit"))"
}
retire_plugin() {
  local plugins
  if ! plugins=$("${HERDR_BIN_PATH:-herdr}" plugin list --plugin rewt.herdr-monitor --json 2>/dev/null); then
    echo "release: warning: could not inspect the retired Herdr plugin" >&2; return
  fi
  local code=0
  printf '%s' "$plugins" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try {const p=JSON.parse(s).result.plugins;if(!Array.isArray(p))process.exit(2);process.exit(p.length?0:1)}catch{process.exit(2)}})' || code=$?
  if [ "$code" != 0 ]; then
    # Empty lists need no mutation; malformed replies should remain visible.
    [ "$code" = 1 ] || echo "release: warning: could not parse Herdr plugin inventory" >&2
    return
  fi
  "${HERDR_BIN_PATH:-herdr}" plugin unlink rewt.herdr-monitor >/dev/null || echo "release: warning: could not unlink retired Herdr plugin" >&2
}
activate() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  valid_tag "$tag"
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -f "$dir/.release-commit" ] || die "no built release $tag; run: release.sh build $tag"
  for l in $LAUNCHERS; do absent_or_link "$BIN_DIR/${l%%:*}"; [ -f "$dir/${l#*:}" ] || die "release is missing ${l#*:}"; done
  absent_or_link "$HOME_DIR/current"; absent_or_link "$HOME_DIR/previous"
  [ ! -e "$LEGACY_PLIST" ] && [ ! -L "$LEGACY_PLIST" ] || die "$LEGACY_PLIST still starts Brain watch; stop and remove it first: launchctl bootout gui/$(id -u)/com.rewt.herdr-brain; rm $LEGACY_PLIST"
  mkdir -p "$BIN_DIR"
  if [ -L "$HOME_DIR/current" ] && [ "$(readlink "$HOME_DIR/current")" != "$dir" ]; then
    ln -sfn "$(readlink "$HOME_DIR/current")" "$HOME_DIR/previous"
  fi
  ln -sfn "$dir" "$HOME_DIR/current"
  for l in $LAUNCHERS; do ln -sfn "$HOME_DIR/current/${l#*:}" "$BIN_DIR/${l%%:*}"; done
  retire_plugin
  say "active: $tag"
}
rollback() {
  [ -L "$HOME_DIR/previous" ] || die "no previous release to roll back to"
  local prev; prev=$(readlink "$HOME_DIR/previous")
  case "$prev" in
    "$HOME_DIR/releases/"*) activate "${prev#"$HOME_DIR/releases/"}" ;;
    *) die "previous is outside the releases directory: $prev" ;;
  esac
}
status() {
  echo "current:  $(readlink "$HOME_DIR/current" 2>/dev/null || echo none)"
  echo "previous: $(readlink "$HOME_DIR/previous" 2>/dev/null || echo none)"
  for l in $LAUNCHERS; do echo "${l%%:*} -> $(readlink "$BIN_DIR/${l%%:*}" 2>/dev/null || echo missing)"; done
  if [ -d "$HOME_DIR/releases" ]; then ls "$HOME_DIR/releases" | sed 's/^/release:  /'; fi
}
case "${1:-}" in
  build) [ $# -eq 2 ] || { [ $# -eq 3 ] && [ "$3" = --live ]; } || die "usage: release.sh build TAG [--live]"; build "$2" "${3:-}" ;;
  activate) [ $# -eq 2 ] || die "usage: release.sh activate TAG"; activate "$2" ;;
  rollback) [ $# -eq 1 ] || die "usage: release.sh rollback"; rollback ;;
  status) [ $# -eq 1 ] || die "usage: release.sh status"; status ;;
  *) die "usage: release.sh build TAG [--live] | activate TAG | rollback | status" ;;
esac
