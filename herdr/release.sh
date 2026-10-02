#!/usr/bin/env bash
# Releases of Herdr Monitor, kept apart from development so a merge to main never
# changes what a running project uses. A release is an immutable copy of a tag:
#
#   release.sh build TAG       copy TAG into $HOME_DIR/releases/TAG and run its build step
#   release.sh activate TAG    point $HOME_DIR/current at it; manage the record, org and lane
#                              launchers, remembering each the first time it is managed; move
#                              the Brain service onto current; link the Herdr plugin to the
#                              release (Herdr resolves links, so the plugin is re-linked whenever
#                              the release changes)
#   release.sh rollback        point current back at the release before it
#   release.sh restore         put each launcher back where it was before it was first managed
#                              and the Brain service back where it was before the first activation
#                              (the dev checkout); unlink the plugin
#   release.sh dev WORKTREE    link a second plugin, rewt.herdr-monitor-dev, to a worktree
#   release.sh status          what is active and where the launchers point
#
# Environment: HERDR_MONITOR_HOME (default ~/.local/share/herdr-monitor), HERDR_MONITOR_BIN
# (default ~/.local/bin), HERDR_MONITOR_REPO (default this script's repository),
# HERDR_MONITOR_PLIST (default ~/Library/LaunchAgents/com.rewt.herdr-brain.plist).
# RELEASE_NO_HERDR=1, RELEASE_NO_LAUNCHD=1 and RELEASE_NO_NPM=1 skip those steps, and
# RELEASE_LAUNCHCTL replaces launchctl (tests).
# HERDR_MONITOR_ENTRY_BIN defaults to $HOME_DIR/entry/bin. HERDR_MONITOR_CODEX
# and HERDR_MONITOR_CLAUDE override native executable discovery; '-' skips Claude.
# Activation installs reversible PATH snippets for fresh zsh/bash shells.
set -euo pipefail

HOME_DIR=${HERDR_MONITOR_HOME:-$HOME/.local/share/herdr-monitor}
BIN_DIR=${HERDR_MONITOR_BIN:-$HOME/.local/bin}
REPO=${HERDR_MONITOR_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
PLIST=${HERDR_MONITOR_PLIST:-$HOME/Library/LaunchAgents/com.rewt.herdr-brain.plist}
LABEL=com.rewt.herdr-brain
LAUNCHCTL=${RELEASE_LAUNCHCTL:-launchctl}
PLUGIN=rewt.herdr-monitor
LAUNCHERS="record:bin/org.mjs org:bin/org.mjs lane:lanes/lane.mjs"
ENTRY_DRIVER="$(cd "$(dirname "$0")" && pwd)/entry-install.mjs"

die() { echo "release: $*" >&2; exit 1; }
say() { echo "release: $*"; }
warn() { echo "release: warning: $*" >&2; }
herdr_bin() { echo "${HERDR_BIN_PATH:-herdr}"; }

build() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  git -C "$REPO" rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag in $REPO"
  [ -e "$dir" ] && die "$dir already exists; a release is never rebuilt in place"
  mkdir -p "$HOME_DIR/releases" "$dir.partial"
  git -C "$REPO" archive "$tag" | tar -x -C "$dir.partial"
  git -C "$REPO" rev-parse "$tag^{commit}" > "$dir.partial/.release-commit"
  [ -x "$dir.partial/herdr/install.sh" ] && MONITOR_INSTALL_BUILD_ONLY=1 "$dir.partial/herdr/install.sh"
  mv "$dir.partial" "$dir"
  chmod -R a-w "$dir"
  say "built $tag at $dir ($(cut -c1-8 "$dir/.release-commit"))"
}

# Remember each launcher's original state once, including launchers introduced after
# the first activation, so `restore` can put the set back exactly.
remember() {
  local before="$HOME_DIR/before"
  mkdir -p "$before"
  for l in $LAUNCHERS; do
    local name=${l%%:*}
    if [ ! -f "$before/$name" ] && [ ! -f "$before/$name.missing" ]; then
      if [ -L "$BIN_DIR/$name" ]; then
        readlink "$BIN_DIR/$name" > "$before/$name"
      elif [ ! -e "$BIN_DIR/$name" ]; then
        : > "$before/$name.missing"
      fi
    fi
  done
  if [ ! -f "$before/plist" ] && [ -f "$PLIST" ]; then cp "$PLIST" "$before/plist"; fi
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

managed_launcher() {
  local target
  [ -L "$1" ] || return 1
  target=$(readlink "$1")
  case "$target" in
    "$HOME_DIR/current/"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Reload the Brain service. launchd unloads asynchronously, so bootstrap right after
# bootout can fail with "5: Input/output error"; wait for the old one to go, then retry.
reload_service() {
  local domain="gui/$(id -u)" i
  "$LAUNCHCTL" bootout "$domain/$LABEL" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    "$LAUNCHCTL" print "$domain/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
  for i in 1 2 3 4 5; do
    "$LAUNCHCTL" bootstrap "$domain" "$PLIST" 2>/dev/null && return 0
    sleep 2
  done
  "$LAUNCHCTL" bootstrap "$domain" "$PLIST" || die "the Brain service did not load; try: launchctl bootstrap $domain $PLIST"
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
  reload_service
  say "Brain service now runs $tree/brain/bin/brain.mjs"
}

# Herdr resolves the path it is given, so the plugin is bound to one release
# directory, not to `current`: re-link it whenever the active release changes.
plugin_root() {
  "$(herdr_bin)" plugin list --plugin "$PLUGIN" --json 2>/dev/null \
    | python3 -c 'import json,sys; p=json.load(sys.stdin)["result"]["plugins"]; print(p[0]["plugin_root"] if p else "")' 2>/dev/null || true
}

link_plugin() {
  [ "${RELEASE_NO_HERDR:-}" = 1 ] && return 0
  local target root
  target=$(cd "$HOME_DIR/current" && pwd -P)
  root=$(plugin_root)
  [ "$root" = "$target" ] && return 0
  [ -n "$root" ] && "$(herdr_bin)" plugin unlink "$PLUGIN" >/dev/null
  "$(herdr_bin)" plugin link "$target" >/dev/null
  say "linked Herdr plugin $PLUGIN to $target"
}

unlink_plugin() {
  [ "${RELEASE_NO_HERDR:-}" = 1 ] && return 0
  [ -n "$(plugin_root)" ] && "$(herdr_bin)" plugin unlink "$PLUGIN" >/dev/null && say "unlinked Herdr plugin $PLUGIN"
  return 0
}

activate() {
  local tag=$1 dir="$HOME_DIR/releases/$1"
  git check-ref-format "refs/tags/$tag" >/dev/null || die "invalid release identifier: $tag"
  [ -d "$dir" ] || die "no release $tag; run: release.sh build $tag"
  # Check every launcher/entry destination before switching current. Older
  # releases without discovery remove the new transport when rolled back.
  for l in $LAUNCHERS; do
    local name=${l%%:*}
    [ -e "$BIN_DIR/$name" ] && [ ! -L "$BIN_DIR/$name" ] && die "$BIN_DIR/$name is not a link; refusing to replace it"
  done
  entry "$dir" --check
  remember
  entry "$dir"
  # Re-activating the active release (after a failed step) must not make it its own previous.
  if [ -L "$HOME_DIR/current" ] && [ "$(readlink "$HOME_DIR/current")" != "$dir" ]; then
    ln -sfn "$(readlink "$HOME_DIR/current")" "$HOME_DIR/previous"
  fi
  ln -sfn "$dir" "$HOME_DIR/current"
  launchers
  brain_service "$HOME_DIR/current"
  link_plugin
  say "active: $tag"
}

rollback() {
  [ -L "$HOME_DIR/previous" ] || die "no previous release to roll back to (restore returns to the dev checkout)"
  local prev; prev=$(readlink "$HOME_DIR/previous")
  case "$prev" in
    "$HOME_DIR/releases/"*) activate "${prev#"$HOME_DIR/releases/"}" ;;
    *) die "previous is outside the releases directory: $prev" ;;
  esac
}

entry() {
  local tree=$1; shift
  local bin=${HERDR_MONITOR_ENTRY_BIN:-$HOME_DIR/entry/bin}
  if [ -f "$tree/discovery/install.mjs" ]; then
    HERDR_MONITOR_HOME="$HOME_DIR" node "$ENTRY_DRIVER" --product "$tree" "$@"
  elif [ -e "$bin/.monitor-entry.json" ] || [ -e "$bin/.monitor-shell.json" ]; then
    HERDR_MONITOR_HOME="$HOME_DIR" node "$ENTRY_DRIVER" --remove "$@"
  fi
  return 0
}

restore() {
  local before="$HOME_DIR/before"
  [ -d "$before" ] || die "nothing to restore: no activation was recorded"
  HERDR_MONITOR_HOME="$HOME_DIR" node "$ENTRY_DRIVER" --remove --check
  HERDR_MONITOR_HOME="$HOME_DIR" node "$ENTRY_DRIVER" --remove
  for l in $LAUNCHERS; do
    local name=${l%%:*}
    if [ -f "$before/$name" ]; then
      ln -sfn "$(cat "$before/$name")" "$BIN_DIR/$name"
    elif [ -f "$before/$name.missing" ]; then
      if [ ! -e "$BIN_DIR/$name" ] && [ ! -L "$BIN_DIR/$name" ]; then
        :
      elif managed_launcher "$BIN_DIR/$name"; then
        rm -f "$BIN_DIR/$name"
      else
        warn "$BIN_DIR/$name changed since activation; leaving it alone"
      fi
    fi
  done
  if [ -f "$before/plist" ] && [ "${RELEASE_NO_LAUNCHD:-}" != 1 ]; then
    cp "$before/plist" "$PLIST"
    reload_service
  fi
  unlink_plugin
  say "launchers and the Brain service are back where they were before release management, and the plugin is unlinked"
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
  echo "entry:    ${HERDR_MONITOR_ENTRY_BIN:-$HOME_DIR/entry/bin} (fresh zsh/bash shells)"
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
