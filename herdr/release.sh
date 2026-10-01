#!/usr/bin/env bash
# Releases of Herdr Monitor, kept apart from development so a merge to main never
# changes what a running project uses. A release is an immutable copy of a tag:
#
#   release.sh build TAG       copy TAG into $HOME_DIR/releases/TAG and run its build step
#   release.sh activate TAG    point $HOME_DIR/current at it; on first use, move the org and
#                              lane launchers and the Brain service onto current, and link
#                              the Herdr plugin through current
#   release.sh rollback        point current back at the release before it
#   release.sh restore         put the launchers and the Brain service back where they were
#                              before the first activation (the dev checkout)
#   release.sh dev WORKTREE    link a second plugin, rewt.herdr-monitor-dev, to a worktree
#   release.sh status          what is active and where the launchers point
#
# Environment: HERDR_MONITOR_HOME (default ~/.local/share/herdr-monitor), HERDR_MONITOR_BIN
# (default ~/.local/bin), HERDR_MONITOR_REPO (default this script's repository),
# HERDR_MONITOR_PLIST (default ~/Library/LaunchAgents/com.rewt.herdr-brain.plist).
# RELEASE_NO_HERDR=1, RELEASE_NO_LAUNCHD=1 and RELEASE_NO_NPM=1 skip those steps, and
# RELEASE_LAUNCHCTL replaces launchctl (tests).
set -euo pipefail

HOME_DIR=${HERDR_MONITOR_HOME:-$HOME/.local/share/herdr-monitor}
BIN_DIR=${HERDR_MONITOR_BIN:-$HOME/.local/bin}
REPO=${HERDR_MONITOR_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
PLIST=${HERDR_MONITOR_PLIST:-$HOME/Library/LaunchAgents/com.rewt.herdr-brain.plist}
LABEL=com.rewt.herdr-brain
LAUNCHCTL=${RELEASE_LAUNCHCTL:-launchctl}
PLUGIN=rewt.herdr-monitor
LAUNCHERS="org:bin/org.mjs lane:lanes/lane.mjs"

die() { echo "release: $*" >&2; exit 1; }
say() { echo "release: $*"; }
herdr_bin() { echo "${HERDR_BIN_PATH:-herdr}"; }

build() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  git -C "$REPO" rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag in $REPO"
  [ -e "$dir" ] && die "$dir already exists; a release is never rebuilt in place"
  mkdir -p "$HOME_DIR/releases" "$dir.partial"
  git -C "$REPO" archive "$tag" | tar -x -C "$dir.partial"
  git -C "$REPO" rev-parse "$tag^{commit}" > "$dir.partial/.release-commit"
  [ -x "$dir.partial/herdr/install.sh" ] && "$dir.partial/herdr/install.sh"
  mv "$dir.partial" "$dir"
  chmod -R a-w "$dir"
  say "built $tag at $dir ($(cut -c1-8 "$dir/.release-commit"))"
}

# The first activation records where the launchers and the Brain service pointed, so
# `restore` can put them back exactly.
remember() {
  local before="$HOME_DIR/before"
  [ -e "$before" ] && return 0
  mkdir -p "$before"
  for l in $LAUNCHERS; do
    local name=${l%%:*}
    if [ -L "$BIN_DIR/$name" ]; then readlink "$BIN_DIR/$name" > "$before/$name"; fi
  done
  [ -f "$PLIST" ] && cp "$PLIST" "$before/plist"
  return 0
}

launchers() {
  mkdir -p "$BIN_DIR"
  for l in $LAUNCHERS; do
    local name=${l%%:*} rel=${l#*:}
    [ -e "$BIN_DIR/$name" ] && [ ! -L "$BIN_DIR/$name" ] && die "$BIN_DIR/$name is not a link; refusing to replace it"
    ln -sfn "$HOME_DIR/current/$rel" "$BIN_DIR/$name"
  done
}

# Point the Brain service's program at a tree (keeping its node, arguments and
# environment) and restart it. No plist, no service: nothing is created unasked.
brain_service() {
  local tree=$1
  [ "${RELEASE_NO_LAUNCHD:-}" = 1 ] && return 0
  [ -f "$PLIST" ] || { say "no $PLIST; the Brain service is left alone"; return 0; }
  python3 - "$PLIST" "$tree" <<'PY'
import plistlib, sys
path, tree = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f: p = plistlib.load(f)
args = p['ProgramArguments']
i = next(n for n, a in enumerate(args) if a.endswith('brain/bin/brain.mjs'))
args[i] = f'{tree}/brain/bin/brain.mjs'
p['WorkingDirectory'] = f'{tree}/brain'
with open(path, 'wb') as f: plistlib.dump(p, f)
PY
  "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"
  say "Brain service now runs $tree/brain/bin/brain.mjs"
}

link_plugin() {
  [ "${RELEASE_NO_HERDR:-}" = 1 ] && return 0
  if "$(herdr_bin)" plugin list --plugin "$PLUGIN" --json 2>/dev/null | grep -q "\"plugin_id\":\"$PLUGIN\""; then return 0; fi
  "$(herdr_bin)" plugin link "$HOME_DIR/current" >/dev/null
  say "linked Herdr plugin $PLUGIN through $HOME_DIR/current"
}

activate() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  [ -d "$dir" ] || die "no release $tag; run: release.sh build $tag"
  remember
  [ -L "$HOME_DIR/current" ] && ln -sfn "$(readlink "$HOME_DIR/current")" "$HOME_DIR/previous"
  ln -sfn "$dir" "$HOME_DIR/current"
  launchers
  brain_service "$HOME_DIR/current"
  link_plugin
  say "active: $tag"
}

rollback() {
  [ -L "$HOME_DIR/previous" ] || die "no previous release to roll back to (restore returns to the dev checkout)"
  local prev; prev=$(readlink "$HOME_DIR/previous")
  ln -sfn "$(readlink "$HOME_DIR/current")" "$HOME_DIR/previous"
  ln -sfn "$prev" "$HOME_DIR/current"
  brain_service "$HOME_DIR/current"
  say "active: $(basename "$prev")"
}

restore() {
  local before="$HOME_DIR/before"
  [ -d "$before" ] || die "nothing to restore: no activation was recorded"
  for l in $LAUNCHERS; do
    local name=${l%%:*}
    [ -f "$before/$name" ] && ln -sfn "$(cat "$before/$name")" "$BIN_DIR/$name"
  done
  if [ -f "$before/plist" ] && [ "${RELEASE_NO_LAUNCHD:-}" != 1 ]; then
    cp "$before/plist" "$PLIST"
    "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST"
  fi
  say "launchers and the Brain service are back where they were before the first activation"
}

dev() {
  local wt; wt=$(cd "$1" && pwd)
  [ -f "$wt/herdr-plugin.toml" ] || die "$wt has no herdr-plugin.toml"
  mkdir -p "$HOME_DIR/dev"
  sed -e "s/^id = \"$PLUGIN\"/id = \"$PLUGIN-dev\"/" -e 's/^name = "\(.*\)"/name = "\1 (dev)"/' \
      -e "s#\\\$HERDR_PLUGIN_ROOT#$wt#g" -e "s/--plugin $PLUGIN /--plugin $PLUGIN-dev /" \
      "$wt/herdr-plugin.toml" > "$HOME_DIR/dev/herdr-plugin.toml"
  [ "${RELEASE_NO_HERDR:-}" = 1 ] && { say "dev manifest written for $wt"; return 0; }
  "$(herdr_bin)" plugin unlink "$PLUGIN-dev" >/dev/null 2>&1 || true
  "$(herdr_bin)" plugin link "$HOME_DIR/dev" >/dev/null
  say "linked $PLUGIN-dev to $wt"
}

status() {
  echo "current:  $(readlink "$HOME_DIR/current" 2>/dev/null || echo none)"
  echo "previous: $(readlink "$HOME_DIR/previous" 2>/dev/null || echo none)"
  for l in $LAUNCHERS; do local name=${l%%:*}; echo "$name -> $(readlink "$BIN_DIR/$name" 2>/dev/null || echo missing)"; done
  ls "$HOME_DIR/releases" 2>/dev/null | sed 's/^/release:  /'
}

case "${1:-}" in
  build) [ $# -eq 2 ] || die "usage: release.sh build TAG"; build "$2" ;;
  activate) [ $# -eq 2 ] || die "usage: release.sh activate TAG"; activate "$2" ;;
  rollback) rollback ;;
  restore) restore ;;
  dev) [ $# -eq 2 ] || die "usage: release.sh dev WORKTREE"; dev "$2" ;;
  status) status ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
