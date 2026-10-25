#!/usr/bin/env bash
# Immutable local releases. The project supervisor ships them (see supervisor/PROTOCOL.md).
# Usage: release.sh build TAG [--live] | activate TAG | ship TAG | rollback | status
#        release.sh pin TAG [PROJECT] | unpin [PROJECT] | pin-status [PROJECT] [--json]
#        release.sh attest TAG SUMMARY.json | exec ENTRY [ARGS...]
# ship = build (release gate in a genuine checkout) + activate + check the installed launchers; it rolls
# back to the previous release if that check fails. Agents run it as one bare command. A built tag is
# never rebuilt: after a failed ship cut a new tag; if a build succeeded but activation never ran,
# run activate TAG.
# HERDR_MONITOR_HOME, HERDR_MONITOR_BIN and HERDR_MONITOR_REPO select destinations.
# HERDR_MONITOR_PLIST selects the retired Brain LaunchAgent to check.
set -euo pipefail
HOME_DIR=${HERDR_MONITOR_HOME:-$HOME/.local/share/herdr-monitor}
BIN_DIR=${HERDR_MONITOR_BIN:-$HOME/.local/bin}
REPO=${HERDR_MONITOR_REPO:-}
LEGACY_PLIST=${HERDR_MONITOR_PLIST-$HOME/Library/LaunchAgents/com.rewt.herdr-brain.plist}
# launchctl acts on the real login session whatever HOME says, so only the account's own plist may stop it.
REAL_PLIST="$(eval echo "~$(id -un)")/Library/LaunchAgents/com.rewt.herdr-brain.plist"
LAUNCHERS="org:bin/org.mjs record:bin/org.mjs lane:lanes/lane.mjs"
TOOLS="$(cd "$(dirname "$0")" && pwd -P)/releases.mjs"
die() { echo "release: $*" >&2; exit 1; }
say() { echo "release: $*"; }
valid_tag() {
  [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] && git check-ref-format "refs/tags/$1" >/dev/null || die "invalid release identifier: $1"
}
absent_or_link() {
  [ ! -e "$1" ] || [ -L "$1" ] || die "$1 is not a link; refusing to replace it"
}
build() {
  local tag=$1 dir="$HOME_DIR/releases/$1" live=${2:-} C work identity_hash
  valid_tag "$tag"
  [ -n "$REPO" ] || REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
  C=$(git -C "$REPO" rev-parse -q --verify "refs/tags/$tag^{commit}") || die "no tag $tag in $REPO"
  [ ! -e "$dir" ] && [ ! -L "$dir" ] || die "$dir already exists; a release is never rebuilt in place"
  mkdir -p "$HOME_DIR/releases"
  dir="$(cd "$HOME_DIR/releases" && pwd -P)/$tag"
  mkdir "$dir.partial" || die "$dir.partial already exists; inspect the unfinished build"
  mkdir -p "$HOME_DIR/builds"
  work="$(cd "$HOME_DIR/builds" && pwd -P)/$tag"
  mkdir "$work" || die "$work already exists; inspect the unfinished build"
  node "$TOOLS" freeze-validation "$REPO" "$tag" "$work/validation.json" "$C"
  identity_hash=$(node "$TOOLS" checkout "$REPO" "$C" "$work/checkout" "$work/identity.json" "$work/validation.json")
  for file in bin/org.mjs lanes/lane.mjs contrib/settle-watch.mjs lib/cli-help.mjs verify/verify.mjs verify/execute.mjs verify/expectations.mjs; do
    [ -f "$work/checkout/$file" ] || die "release is missing $file"
  done
  # Like the promotion train, queue for the shared host test slot instead of refusing while another
  # project's gate holds it; an explicit setting (0 refuses at once) wins. Agents ship with one bare
  # command, so they cannot set this themselves. This bounds admission, never test execution.
  export MONITOR_TEST_SLOT_WAIT_SECONDS=${MONITOR_TEST_SLOT_WAIT_SECONDS:-${BCH_CLOAK_TEST_SLOT_WAIT_SECONDS:-3600}}
  (cd "$work/checkout" && node --input-type=module - "$work" <<'NODE'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateValidation } from './lanes/validation.mjs';
import { runGateSync } from './test-slot/run.mjs';
const work = process.argv[2], frozen = JSON.parse(fs.readFileSync(path.join(work, 'validation.json'), 'utf8'));
if (frozen.schema !== 'release-validation-admission/v1') throw Error('invalid frozen release validation admission');
const declared = validateValidation(frozen.declaration);
const timeoutSeconds = typeof declared.timeout_seconds === 'object'
  ? declared.timeout_seconds.release : declared.timeout_seconds;
const idleTimeoutSeconds = typeof declared.idle_timeout_seconds === 'object'
  ? declared.idle_timeout_seconds.release : declared.idle_timeout_seconds;
const directory = path.join(frozen.common, 'lane-validation');
fs.mkdirSync(directory, { recursive: true });
const executionReceipt = path.join(directory, `release-${randomUUID()}.execution.json`);
console.error(`release gate receipt: ${executionReceipt}`);
const run = runGateSync('release checkout', ['/bin/sh', '-c', declared.release ?? 'npm run test:release'], {
  common: frozen.common, executionReceipt, tier: 'release', timeoutSeconds, idleTimeoutSeconds, retryTimeout: false, stdio: 'inherit',
});
if (run.error) console.error(run.error.message);
fs.writeFileSync(path.join(work, 'execution.json'), JSON.stringify({ cwd: process.cwd(), commit: frozen.payloadCommit,
  receipt: executionReceipt, sha256: createHash('sha256').update(fs.readFileSync(executionReceipt)).digest('hex') }) + '\n');
process.exitCode = run.status ?? (run.signal ? 128 + (os.constants.signals[run.signal] ?? 0) : 1);
NODE
  )
  if [ "$live" = --live ]; then
    (cd "$work/checkout" && node acceptance/run.mjs --candidate "$work/checkout" --summary-file "$work/acceptance.json")
  fi
  git -C "$REPO" archive "$C" | tar -x -C "$dir.partial"
  node "$TOOLS" verify-package "$dir.partial" "$work/identity.json" "$identity_hash" > "$work/validated.json"
  cp "$work/validated.json" "$dir.partial/.release-validation.json"
  printf '%s\n' "$C" > "$dir.partial/.release-commit"
  node "$TOOLS" manifest "$dir.partial" ${live:+"$work/acceptance.json"}
  node "$TOOLS" verify-package "$dir.partial" "$work/identity.json" "$identity_hash" >/dev/null
  chmod -R a-w "$dir.partial"
  node "$TOOLS" verify-package "$dir.partial" "$work/identity.json" "$identity_hash" --read-only >/dev/null
  node "$TOOLS" verify-bundle "$dir.partial"
  [ ! -e "$dir" ] && [ ! -L "$dir" ] || die "$dir appeared during the build; publication refused"
  mv "$dir.partial" "$dir"
  # Keep the original source root and evidence: publication transfers no claims.
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
retire_brain_service() {
  # The retired Brain watch LaunchAgent would restart a command releases no longer ship: stop it and move it aside.
  [ -n "$LEGACY_PLIST" ] || return 0
  [ -e "$LEGACY_PLIST" ] || [ -L "$LEGACY_PLIST" ] || return 0
  # Only the account's real plist belongs to the loaded service; scratch HOMEs and test plists never stop it.
  if [ "$LEGACY_PLIST" = "$REAL_PLIST" ] && [ "${RELEASE_NO_LAUNCHD:-}" != 1 ]; then
    launchctl bootout "gui/$(id -u)/com.rewt.herdr-brain" 2>/dev/null || true
  fi
  local aside="$LEGACY_PLIST.retired-$(date +%Y%m%d%H%M%S)"
  mv "$LEGACY_PLIST" "$aside" || die "could not move aside $LEGACY_PLIST"
  say "retired the Brain watch LaunchAgent (moved to $aside)"
}
verify_installed() {
  # The launchers projects call must run from the new current release.
  local out
  out=$(cd "$HOME_DIR" && node "$BIN_DIR/org" help 2>&1) || { echo "release: installed org failed to start: $(printf '%s' "$out" | tail -3)" >&2; return 1; }
  out=$(cd "$HOME_DIR" && node "$BIN_DIR/lane" --help 2>&1) || { echo "release: installed lane failed to start: $(printf '%s' "$out" | tail -3)" >&2; return 1; }
  out=$(node --check "$HOME_DIR/current/contrib/settle-watch.mjs" 2>&1) || { echo "release: installed settle-watch does not load: $(printf '%s' "$out" | tail -3)" >&2; return 1; }
}
ship() {
  local tag=$1 earlier
  build "$tag"
  earlier=$(readlink "$HOME_DIR/previous" 2>/dev/null || true)
  activate "$tag"
  if verify_installed; then say "shipped $tag"; return 0; fi
  if [ -L "$HOME_DIR/previous" ]; then
    echo "release: rolling back after the failed post-activation check" >&2
    rollback
    # rollback made the broken tag "previous"; point previous back at the last good release.
    if [ -n "$earlier" ]; then ln -sfn "$earlier" "$HOME_DIR/previous"; else rm -f "$HOME_DIR/previous"; fi
    die "ship $tag failed its post-activation check; rolled back to $(basename "$(readlink "$HOME_DIR/current")")"
  fi
  die "ship $tag failed its post-activation check and there is no previous release; $tag stays active: activate a good tag"
}
activate() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  valid_tag "$tag"
  [[ "$tag" != *.partial ]] || die "unfinished release cannot activate: $tag"
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -f "$dir/.release-commit" ] || die "no built release $tag; run: release.sh build $tag"
  for l in $LAUNCHERS; do absent_or_link "$BIN_DIR/${l%%:*}"; [ -f "$dir/${l#*:}" ] || die "release is missing ${l#*:}"; done
  absent_or_link "$HOME_DIR/current"; absent_or_link "$HOME_DIR/previous"
  node "$TOOLS" verify-bundle "$dir"
  retire_brain_service
  mkdir -p "$BIN_DIR"
  if [ -L "$HOME_DIR/current" ] && [ "$(readlink "$HOME_DIR/current")" != "$dir" ]; then
    ln -sfn "$(readlink "$HOME_DIR/current")" "$HOME_DIR/previous"
  fi
  ln -sfn "$dir" "$HOME_DIR/current"
  node "$TOOLS" install "$HOME_DIR" "$BIN_DIR"
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
  ship) [ $# -eq 2 ] || die "usage: release.sh ship TAG"; ship "$2" ;;
  rollback) [ $# -eq 1 ] || die "usage: release.sh rollback"; rollback ;;
  status) [ $# -eq 1 ] || die "usage: release.sh status"; status ;;
  pin) [ $# -ge 2 ] && [ $# -le 3 ] || die "usage: release.sh pin TAG [PROJECT]"; node "$TOOLS" pin "$HOME_DIR" "${3:-$PWD}" "$2" ;;
  unpin) [ $# -le 2 ] || die "usage: release.sh unpin [PROJECT]"; node "$TOOLS" unpin "$HOME_DIR" "${2:-$PWD}" ;;
  attest) [ $# -eq 3 ] || die "usage: release.sh attest TAG SUMMARY.json"; valid_tag "$2"; node "$TOOLS" attest "$HOME_DIR" "$2" "$3" ;;
  pin-status)
    shift
    project=$PWD; json=; project_set=
    for arg in "$@"; do
      if [ "$arg" = --json ] && [ -z "$json" ]; then json=--json
      elif [ -z "$project_set" ] && [[ "$arg" != --* ]]; then project=$arg; project_set=1
      else die "usage: release.sh pin-status [PROJECT] [--json]"; fi
    done
    node "$TOOLS" pin-status "$HOME_DIR" "$project" ${json:+"$json"} ;;
  exec) [ $# -ge 2 ] || die "usage: release.sh exec ENTRY [ARGS...]"; shift; node "$TOOLS" run "$@" ;;
  *) die "usage: release.sh build TAG [--live] | activate TAG | ship TAG | rollback | status | pin TAG [PROJECT] | unpin [PROJECT] | attest TAG SUMMARY.json | pin-status [PROJECT] [--json] | exec ENTRY [ARGS...]" ;;
esac
