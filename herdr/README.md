# Machine releases

The product has no npm dependencies. Node.js 20+, Git, Bash, tar and npm are
needed to build a release; npm runs the offline test scripts without installing
packages. Herdr and native Codex or Claude supply agent panes when used.

```sh
bash herdr/release.sh build TAG
bash herdr/release.sh build TAG --live
bash herdr/release.sh activate TAG
bash herdr/release.sh ship TAG   # build + activate + check; rolls back on failure
bash herdr/release.sh rollback
bash herdr/release.sh status
```

Agents release with `ship`. Activation moves the retired Brain watch LaunchAgent
(`~/Library/LaunchAgents/com.rewt.herdr-brain.plist`) aside after stopping it, so no
manual step precedes the first release.

Build copies exactly `git archive TAG` into `releases/TAG.partial`, runs
the `release` command and its `timeout_seconds` (and optional
`idle_timeout_seconds`) from the snapshot's `.lane.validation.json`, falling back
to `npm run test:release` when no release command is declared. The foreground
gate bounds the command and its children. Build then renames the snapshot and makes it
read-only. A failed or interrupted build retains its partial directory for
inspection and cannot be activated or rebuilt in place. `--live` adds the live
acceptance harness after the offline gate; it is optional and never run in lanes.
Every release retains `contrib/settle-watch.mjs` and `lib/cli-help.mjs`.

Activation updates `previous` and `current` and links `~/.local/bin/{org,record}`
to `current/bin/org.mjs` and `lane` to `current/lanes/lane.mjs`. Existing regular
files are refused before switching. Repeating activation preserves the previous
release. Rollback selects it. The operator controls activation and publishing.
The retired `rewt.herdr-monitor` plugin is unlinked if still registered; a failure
warns. Activation refuses while the old Brain LaunchAgent plist exists: the
operator must stop and remove that retired job first.

Set `HERDR_MONITOR_HOME`, `HERDR_MONITOR_BIN` and `HERDR_MONITOR_REPO` to choose
release, launcher and source locations. `HERDR_MONITOR_PLIST` selects the retired
plist check, and `HERDR_BIN_PATH` selects the Herdr CLI. Tests always supply scratch
homes and fake Herdr commands. No release command installs dependencies, native
hooks, harness wrappers or machine permissions.

Older installations may still contain `before/`, entry wrappers and shell PATH
blocks. Machines that activated an entry-installing release need this one-time
operator cleanup; current releases keep no restoration receipts:

1. Remove the managed wrappers in `~/.local/share/herdr-monitor/entry/bin` (or the
   former `HERDR_MONITOR_ENTRY_BIN` under a custom `HERDR_MONITOR_HOME`).
2. Remove the block between `# >>> Herdr Monitor entry >>>` and
   `# <<< Herdr Monitor entry <<<` from `.zshenv` and `.zshrc` under
   `${ZDOTDIR:-$HOME}`, and from `~/.bashrc` and the selected `~/.bash_profile`,
   `~/.bash_login` or `~/.profile`.
3. Remove only Monitor's `SessionStart` hook groups that invoke
   `herdr/native-entry.mjs` from `${CODEX_HOME:-~/.codex}/hooks.json` and
   `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, preserving other hooks and settings.

The old bin's `.monitor-shell.json` and `.monitor-native-hooks.json` receipts name
the exact destinations if they changed. Keep those receipts until cleanup is
complete, then open a fresh shell and confirm `codex` and `claude` resolve to the
native launchers. Preserve existing records and lane worktrees.
