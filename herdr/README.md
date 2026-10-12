# Machine release tools

The product has no npm dependencies. `install.sh` checks Node.js 20+ during an
archive build. `release.sh build TAG` creates an immutable tagged copy; activation
manages the `record`, `org` and `lane` launchers. `rollback` selects the previous
release; `restore` restores the remembered launcher destinations.

Set `HERDR_MONITOR_HOME`, `HERDR_MONITOR_BIN` and `HERDR_MONITOR_REPO` for isolated
release tests. Keep installed releases separate from development: a commit does
not activate a release. Existing regular launcher files are never overwritten.
The operator controls activation and publishing.

Native Codex and Claude launches use their own configuration. Project chats use
the [fleet command](../discovery/README.md). Release tools install no harness
wrappers, shell PATH snippets or native SessionStart hooks. The non-setuid process
reader under `lib/native` remains bundled for process birth identity checks.

Run focused offline tests in lanes. Promotion runs merge checks once, and release
preparation runs the offline release suites once per candidate. The release
acceptance harness belongs to release preparation, never a worker lane.
