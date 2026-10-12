# Machine installation and releases

The release is independent of development: `release.sh build TAG` archives a Git
tag, renames it to its final path and makes it read-only. The product has no npm
dependencies. Building never installs entry adapters from `.partial`.
`release.sh activate TAG` installs entry from the final release, manages the
record/org/lane launchers and switches `current`. Releases no longer manage the
Brain LaunchAgent (Brain `watch` was removed on 2026-10-12): activation refuses
while `~/Library/LaunchAgents/com.rewt.herdr-brain.plist` exists, naming the
`launchctl bootout` and `rm` to run once, and `restore` never reinstalls it.
The Herdr plugin was removed on 2026-10-12: activating a release without
`herdr-plugin.toml` unlinks an older plugin registration, and rolling back to an
older release links its plugin again. Development merges do not change that release.

```sh
bash herdr/release.sh build TAG
bash herdr/release.sh activate TAG
bash herdr/release.sh rollback
bash herdr/release.sh restore
```

After activation, complete the printed **required Codex setup** before dispatching:
open Codex with each profile used for workers or native/desktop sessions, open
`/hooks`, and review the Monitor user SessionStart hook. For a named profile,
launch `codex -p PROFILE`; plain `codex` uses its configured default profile.
Trust is per profile: reviewing `claude-mem-rewt` does not review
`claude-mem-bastian` or the default profile. The operator chooses whether to
trust the hook; installation and dispatch never write Codex trust records.

If dispatch reports the `Hooks need review` dialog with its count of new or changed
hooks, or `1 hook needs review before it can run.`, open `/hooks` in the
named worker session and review in that profile, then run
`node dispatch/dispatch.mjs --retry R-n` with the returned run ID. The pending
brief, run and worker are retained for retry.

Only the operator/supervisor performs machine installation. Lane tests set their
own refusal/fake Herdr CLI before any lane or entry operation. The bounded test
runner also clears inherited Herdr IDs and pins an absent scratch socket; neither
`npm test` nor `npm run test:lanes` contacts the operator's server. Tests run with
their own actor and bounded fixture commands. They set their
own scratch `HOME`, `ZDOTDIR`, release home and bin; they skip plugin registration
and launchd. `RELEASE_NO_NPM=1` skips the npm prerequisite check only. It does not
skip entry. `MONITOR_INSTALL_BUILD_ONLY=1` makes `herdr/install.sh` the archive
build's no-op step. A direct `herdr/install.sh` run installs entry.

A direct install copies entry's dependency-free runtime into a stable,
content-addressed directory under `$HERDR_MONITOR_HOME/entry/runtimes` before
installing adapters. The runtime remains usable when the source checkout moves
or disappears. Release activation instead pins the final immutable release.

Install native Codex, Claude, or both. On macOS, Claude-only worker validation
uses the existing OS provider; Linux validation currently requires Codex.
The installer checks Node/npm, Git, Python and Herdr before changing entry.
Entry resolves discovered
native executables from PATH at launch, excluding managed entry directories;
the install receipt retains their launchers as fallback. Receipts also preserve
whether each native was explicitly selected. `HERDR_MONITOR_CODEX`,
`HERDR_MONITOR_CLAUDE`, and installer `--codex`/`--claude` selections win while
executable, then fall back to PATH if absent. Use stable launchers or symlinks
for overrides to follow upgrades. An adapter `--binary` selects that invocation
directly. Release activation retains explicit selections from the receipt. Existing harness
settings are retained alongside a reversible user SessionStart hook. Defaults require no project or machine settings:

| Environment override | Default |
| --- | --- |
| `HERDR_MONITOR_HOME` | `$HOME/.local/share/herdr-monitor` |
| `HERDR_MONITOR_BIN` | `$HOME/.local/bin` (record/org/lane) |
| `HERDR_MONITOR_ENTRY_BIN` | `$HERDR_MONITOR_HOME/entry/bin` |
| `HERDR_MONITOR_CODEX` | Native Codex found on PATH; `-` skips it |
| `HERDR_MONITOR_CLAUDE` | Native Claude found on PATH; `-` skips it |
| `HERDR_MONITOR_SUPERVISOR_HARNESS` | Codex if installed, otherwise Claude |

Entry installs `codex`, `monitor-codex`, and, when available, `claude` and
`monitor-claude`, plus the `monitor` command, into its dedicated directory. It appends a removable PATH snippet
to zsh's `.zshenv` and `.zshrc` (under the current `ZDOTDIR` or HOME), Bash's
`.bashrc`, and its first existing login file (`.bash_profile`, `.bash_login`,
`.profile`, or a new `.bash_profile`). Fresh login and non-login interactive
shells discover the adapters without a user PATH edit. Existing shell processes
need a fresh pane. Custom shells, later shell PATH overrides, aliases/functions,
or a later change to ZDOTDIR can bypass this transport.

`rollback` installs the previous release's adapter bytes and policy path;
rolling back to a release without discovery removes adapters and PATH snippets.
`restore` removes entry, restores the original launchers/service, and unlinks
the release plugin. Shell restoration preserves the original bytes and mode,
removes originally absent files when empty, and preserves edits outside the
unchanged snippet. An edited snippet/adapter or file symlink refuses preflight
before the release pointer or removal changes. Original native CLIs stay intact.
Immutable release copies and durable project records remain available.

Native user hooks are installed in `$CODEX_HOME/hooks.json` and/or
`$CLAUDE_CONFIG_DIR/settings.json`, defaulting to `~/.codex` and `~/.claude`.
Only the managed SessionStart group is added or removed. Removal restores original
bytes when the rest of the document is unchanged; later settings edits are kept.
Changed managed hooks refuse preflight. These config writes share entry's journal
and rollback. Originally missing config directories are removed only when empty.
Codex users review new/changed hooks through `/hooks`, as required by
[native hook trust](https://learn.chatgpt.com/docs/hooks); installation never writes
trust records. No project hook or project setup file is installed.
Release activation points the hook command at
`$HERDR_MONITOR_HOME/current/herdr/native-entry.mjs`. Its command stays the same
across upgrades and rollback, so changing the release directory alone does not
request a new review. Switching an older release-specific command to this stable
path is itself a hook change and requires operator review once in each profile.
Other hook-command changes still require Codex's own review.
Hooks join the fleet and provide adapter guidance for native-path/desktop sessions;
the bounded worker parent still comes from `monitor-codex` or `monitor-claude`.
Scripts must be installed on the host running the session.

Entry holds one installation lock before recovery, machine-state reads, runtime
existence checks and planning, through completion or rollback. Concurrent calls
wait up to 30 seconds; a terminated owner's lock is reclaimed without removing
a newer owner's lock. Entry runs the selected discovery
installer into a scratch bin with the original installer flags, so older
releases such as v0.1.4 do not need `--check`. It validates the complete plan's
before-state and write access, then syncs `.monitor-recovery.json` before copying
a new runtime or changing any adapter, shell snippet or installation receipt.
Each destination keeps its first inspected bytes and mode for ownership checks,
replacement planning and rollback. Changes during planning, including edits to
otherwise unchanged destinations, refuse before a journal is published.
Shell files stay buffers throughout reading, appending, splicing and writing;
both shell receipts and journals encode their bytes as base64, including content
that is not valid UTF-8. Legacy installed shell receipts remain removable and
upgrade to the new encoding while preserving current shell bytes.

The journal records each file's prior bytes and mode and durable write intent;
a failed write rolls back only started changes. Recovery compares the exact
before and after bytes and mode before preserving a caller's chmod of untouched
before-bytes, so a mode-only replacement still restores the inspected mode.
New runtime directories carry the transaction's ownership token, so rollback
never removes another owner's runtime. After a terminated install, `node herdr/entry-install.mjs
--recover` (or the next install/remove) restores the previous state. A live
owner or edits to files needing recovery refuse without overwriting them. A
pending journal from the older installer must be recovered with that original
installer before upgrading: its text encoding and absent ownership information
cannot establish safe recovery with this format. Stable runtimes include an
explicit asset allowlist, including `lanes/docs/REVIEW_TEMPLATE.md`, and remain
after successful removal, alongside retained releases.

To remove entry, run `node /installed/release/herdr/entry-install.mjs --remove`
(release `restore` does this too). An older installation from the removed Herdr
plugin can still use that plugin's **restore-entry** action before uninstalling it.

The project supervisor enters through the installed adapter
(`monitor-codex --repo PROJECT --role supervisor`), which verifies the canonical
Git checkout. Its installed policy directs that supervisor to start default
housekeeping; ordinary fresh native Herdr starts are workers, whose policy forbids
the loop. Installation and shell startup never start a project scheduler, and
project entry opens no panes. Running sessions and schedules retain their own
lifetime when entry is restored or rolled back.

See [project entry](../discovery/README.md) for project overrides and launch
coverage. No release is pushed or published by these commands.
