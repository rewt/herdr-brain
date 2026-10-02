# Local release acceptance

Run from a Herdr pane, with Node 20+, Git, Bash, zsh and the installed Codex CLI:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /path/to/live/bch-cloak --npm-cache /path/to/npm-cache
```

`--candidate` accepts a Git tag/ref or an existing release directory. `--source`
selects the Git repository for tags/refs. The runner snapshots the candidate;
it never modifies that source or an activated release. `main` means the commit
resolved at startup, not a moving branch during the test.

The primary cases enter new Git projects without `.org`, `.lane.json`, routes or
agent instructions. Missing discovery/defaults fail. The configured mechanics
fixture is a separate case: its record, route, validation command and ignored
session registry are explicit test setup, never evidence that defaults work.

Two real sessions receive overlapping greeting changes in the same new project.
A third receives a routing task in another new project. Their prompts provide
tasks and scratch safety boundaries; they do not name lanes, record setup,
route defaults or promotion commands. The default is the operator's lowest
declared route, `gpt-5.6-luna` at `low`; `--discovery-model` and
`--discovery-effort` can select another available route. The harness does not
automatically escalate models. Each session has a 180-second runtime timeout.
`discovery-usage.json` records the CLI's measured input, cached input, output and
reasoning tokens per session. Billing rates are not inferred.

The real sessions use the native `workspace-write` sandbox with only scratch
roots writable, ephemeral sessions, no shared daemon, and no user configuration,
rules, MCP integrations or memory profile. Isolated runtime homes receive
temporary mode-0600 authentication copies, which are deleted even with `--keep`.
Neither approval bypass nor unrestricted sandbox modes are used. Native Git
metadata protection can block commits; that is recorded as an execution limit,
never silently bypassed. An initial nested-sandbox experiment cannot establish
discovery: the model must actually read the project and report token usage.

Mechanics use real Herdr PTYs running Node scripts, real Git, record, dispatch,
watch and lane code. The Herdr adapter replaces `agent start` with the script.
Scripts publish explicit lifecycle states via `pane report-agent`. Herdr rejects
`agent prompt` to a foreground script, so the adapter transports these prompts
through `pane send-text`/`send-keys` and waits for script receipts. This proves
coordination and PTY transport, **not** Codex/Claude detection or interactive
prompt timing. The live cases use actual Codex sessions; neither kind of case is
part of `npm test`.

Every mutation uses opaque IDs returned by this run's creation calls. The adapter
filters global workspace/agent lists to those receipts, rejects foreign targets,
rejects paths and symlink escapes outside scratch, verifies the foreground cwd
before starting scripts, and disallows service/plugin/focus commands. Ownership
updates are locked and atomic for concurrent creation. The scheduler may close
only recorded watcher PIDs and created workspaces. It does not install plugins,
change launchd or use the operator's bin or release home. The existing Herdr
server still records its normal runtime logs; this is not an isolated Herdr server.

The existing-project case copies live bch-cloak scripts into scratch, records
SHA-256 checksums/modes, and retains a scan of additional callers. Only absolute
path constants and temporary-file locations are relocated. Route declarations
and forwarded model/effort arguments remain intact. Persona resolution is a
scratch environment-only stand-in. Both supervisor wrappers run in dry-run mode;
the close script consumes actual `org status` from PATH, and apply-settle actually
runs its record commands and ingest, then deliberately stops at a missing Draft
section before any review desk dispatch. The full settle/review handoff remains
unproven. A background workspace omitted from `workspace list` metadata is a
failure of the real wrapper path, not replaced with fake metadata.

Release mechanics build immutable copies with the candidate release script in a
scratch repository/home/bin, then activate, reactivate, roll back and restore.
They include a `before/` directory that predates the `record` launcher.
Plugin linking and launchd are excluded by the brief's boundary. The console's
actual `npm ci --offline` runs separately using copies of the supplied cache's
indexes and lockfile tarballs. Missing cache content fails; omitting
`--npm-cache` leaves the full dependency build pending.

The ten ENG-64 file switches are enumerated individually in
`cutover-switches.json`, including exact byte/mode rollback probes. Unapplied
switches and their behavioral canaries remain pending, as does final contrib
retirement while a live copied caller still uses it. This is an explicit
coverage limit: marker inspection and restoration do not establish switch
behavior. Housekeeping remains pending until its released entrypoint and live
fixture are integrated. These pending cases keep the gate closed; they cannot be
turned green by the current runner.

The screen lists each case and points to its numbered JSONL evidence. `summary.json`
contains reasons, candidate commit and elapsed time. Any failure **or pending**
case exits 1. Passing mechanics never overrides failed discovery or pending
cutover work. A full run usually takes a few minutes; network latency and the
real-session timeouts can make it longer.

By default the runner closes every workspace it created and removes everything
except evidence under `/tmp/herdr-acceptance-*/evidence`. `--keep` retains other
scratch files for debugging, but still closes created workspaces and removes
authentication copies. `ACCEPTANCE_TMPDIR` can select another scratch parent.
If cleanup fails, the summary identifies the failure and scratch ownership ledger.

`--skip-live` is for mechanics debugging: discovery becomes pending, so this
cannot approve a release. Omitting `--bch-cloak` leaves that compatibility case
pending; no live repository location is assumed for other projects.

Offline checks of the test boundary, also separate from `npm test`:

```sh
node --test acceptance/test/*.test.mjs
```
