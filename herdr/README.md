# Machine installation and releases

The release is independent of development: `release.sh build TAG` archives a Git
tag, installs console dependencies in the archive, renames it to its final path
and makes it read-only. Building never installs entry adapters from `.partial`.
`release.sh activate TAG` installs entry from the final release, manages the
record/org/lane launchers, switches `current`, reloads an existing Brain service
and re-links the Herdr plugin. Development merges do not change that release.

```sh
bash herdr/release.sh build TAG
bash herdr/release.sh activate TAG
bash herdr/release.sh rollback
bash herdr/release.sh restore
```

Only the operator/supervisor performs machine installation. Lane tests set their
own scratch `HOME`, `ZDOTDIR`, release home and bin; they skip plugin registration
and launchd. `RELEASE_NO_NPM=1` skips dependency installation only. It does not
skip entry. `MONITOR_INSTALL_BUILD_ONLY=1` is the archive build's internal
dependency-only step. The manifest's normal `herdr/install.sh` build installs
both dependencies and entry.

Native Codex must already be available; Claude is optional and uses Codex for
worker validation. The installer resolves native executables from PATH and
retains their receipts across upgrades, without replacing them. No harness user
configuration is changed. Defaults require no project or machine settings:

| Environment override | Default |
| --- | --- |
| `HERDR_MONITOR_HOME` | `$HOME/.local/share/herdr-monitor` |
| `HERDR_MONITOR_BIN` | `$HOME/.local/bin` (record/org/lane) |
| `HERDR_MONITOR_ENTRY_BIN` | `$HERDR_MONITOR_HOME/entry/bin` |
| `HERDR_MONITOR_CODEX` | Native Codex found on PATH |
| `HERDR_MONITOR_CLAUDE` | Native Claude found on PATH; `-` skips it |

Entry installs `codex`, `monitor-codex`, and, when available, `claude` and
`monitor-claude` into its dedicated directory. It appends a removable PATH snippet
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

For a Herdr GitHub installation, use the manifest's **restore-entry** action,
or `node /installed/plugin/herdr/entry-install.mjs --remove`, before uninstalling
the plugin. Monitor's restore command is separate from Herdr's
[unlink/uninstall commands](https://herdr.dev/docs/cli-reference/). The documented
[manifest](https://herdr.dev/docs/socket-api/) has no uninstall callback; an
unregister operation alone cannot reverse shell changes. Local `plugin link`
skips builds, so use release activation or run `herdr/install.sh` explicitly.

The explicit **supervisor** pane launches entry in the canonical checkout.
Its installed policy directs that supervisor to start default housekeeping;
ordinary fresh native Herdr starts are workers, whose policy forbids the loop.
Installation and shell startup never start a project scheduler. Running sessions
and schedules retain their own lifetime when entry is restored or rolled back.

See [project entry](../discovery/README.md) for project overrides and launch
coverage, and [the native canary](../acceptance/README.md) for the bounded scratch
test. No release is pushed or published by these commands.
