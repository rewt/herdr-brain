# Machine releases

The product has no npm dependencies. Node.js 20+, Git, Bash, tar and npm are
needed to build a release; npm runs the offline test scripts without installing
packages. Herdr and native Codex or Claude supply agent panes when used.

```sh
bash herdr/release.sh build TAG
bash herdr/release.sh build TAG --live
bash herdr/release.sh activate TAG
bash herdr/release.sh rollback
bash herdr/release.sh status
```

Build copies exactly `git archive TAG` into `releases/TAG.partial`, runs
`npm run test:release` inside that snapshot, then renames it and makes it
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
blocks. Their cleanup is an operator task; current releases keep no restoration
receipts. Preserve existing records, lane worktrees and native harness settings.
