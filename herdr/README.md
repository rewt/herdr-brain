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
bash herdr/release.sh pin TAG /canonical/project  # commit .herdr-release.json to accept
bash herdr/release.sh unpin /canonical/project   # commit to return to current
bash herdr/release.sh attest LEGACY_TAG /path/to/summary.json
bash herdr/release.sh pin-status /canonical/project --json
bash herdr/release.sh exec supervisor/supervisor.mjs brief
```

Agents release with `ship`. Activation moves the retired Brain watch LaunchAgent
(`~/Library/LaunchAgents/com.rewt.herdr-brain.plist`) aside after stopping it, so no
manual step precedes the first release.

Builds and ships launched inside Herdr automatically add a background
`Release TAG · running` tab under the **canonical project workspace**, including
when the caller is a lane or a detached process with inherited Herdr context.
The tab follows the full build log (offline suites and optional live acceptance),
then keeps the output and a `passed`, `failed` or `interrupted` title. It uses the
existing workspace; no Git worktree, agent, extra gate or suite is created.
The release still executes once in its original process cwd and isolated checkout.
Its command starts before the display connects. Missing Herdr context, a closed
canonical workspace or a native refusal leaves execution and its result intact;
display errors are retained without retrying or targeting another pane.

For standalone full-suite or live-check commands, the release coordinator can use
the same foreground wrapper (the existing authorization and release policy apply):

```sh
node herdr/visible-run.mjs run --repo /canonical/herdr-brain --label 'Full suite' -- npm test
node herdr/visible-run.mjs run --repo /canonical/herdr-brain --label 'Live checks' -- node acceptance/run.mjs --candidate /candidate/checkout --source /canonical/herdr-brain
```

Run from the intended command cwd; `--repo` selects only the display's parent.
Labels and inherited workspace IDs never select a foreign project. Log, actual
command exit/signal and display attachment details stay in
`GIT_COMMON_DIR/visible-runs/run-*`. The view only reads those files. Closing it
does not stop the command; loss of the producer without a result displays
`result unknown`. These presentation files never replace validation receipts,
change release readiness, replay an existing attempt or attach to a running build.
Outside Herdr, releases keep their original output path and behavior.

Build copies exactly `git archive TAG` into `releases/TAG.partial`, runs
the `release` command and its `timeout_seconds` (and optional
`idle_timeout_seconds`) from the snapshot's `.lane.validation.json`, falling back
to `npm run test:release` when no release command is declared. The foreground
gate bounds the command and its children. Build then renames the snapshot and makes it
read-only. A failed or interrupted build retains its partial directory for
inspection and cannot be activated or rebuilt in place. `--live` adds the live
acceptance harness after the offline gate; it is optional and never run in lanes.
Pin candidates require `--live`: the build retains its summary and records READY
acceptance for the exact commit in the additive release manifest. Offline builds
explicitly record acceptance did not run. `attest` supplies write-once installation
evidence only for older protocol-1 bundles without an acceptance record.
Every release retains `contrib/settle-watch.mjs` and `lib/cli-help.mjs`.

Activation updates `previous` and `current` and installs project-aware resolvers
for `~/.local/bin/{org,record,lane}`. A committed canonical `.herdr-release.json`
selects a complete, acceptance-READY immutable bundle; unpinned projects keep using `current`.
See [release pins](RELEASE-PINS.md) for acceptance, rollback, compatibility,
operation inventory and the deferred BCH adapters. Existing regular
files are refused before switching. Repeating activation preserves the previous
release. Rollback selects it. The operator controls activation and publishing.
The retired `rewt.herdr-monitor` plugin is unlinked if still registered; a failure
warns. Complete releases and routing generations are retained; there is no pruning.

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
