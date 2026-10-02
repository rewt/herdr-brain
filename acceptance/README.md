# Local release acceptance

Run from a Herdr pane, with Node 20+, Git, Bash, zsh, ripgrep (`rg`), Python 3
(`python3`), tar, npm, macOS `sandbox-exec`, Herdr and the installed Codex CLI.
Startup probes every required executable; missing tools produce a named PENDING
result before executing candidate or copied code.

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /path/to/live/bch-cloak --npm-cache /path/to/npm-cache
```

`--candidate` accepts a Git tag/ref or an existing release directory. `--source`
selects the Git repository for tags/refs. The runner snapshots the candidate;
it never modifies that source or an activated release. `main` means the commit
resolved at startup, not a moving branch during the test.

The primary cases enter new Git projects without `.org`, `.lane.json`, routes or
agent instructions. Missing discovery fails; unexecuted default behavior stays
pending. Case 04 executes installed supervisor entry and record bootstrap in a
dedicated untouched project; it does not claim a dispatch/watch cycle. Case 22 separately
keeps the unconfigured default supervisor dispatch/watch/ingest cycle PENDING
until that behavior is actually executed. The configured mechanics
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

Each discovery project has a separate temporary parent containing only that
project. The native permission profile denies traversal of the parent and reads
of the harness, product checkout, ledger and authentication home. Only a stripped
runtime distribution is installed read-only; it excludes the product repository's
AGENTS.md, README, docs, tests and kit. Source assertions require witnessed CLI
output, a product-delivered project file, a witnessed installed policy file, or
a host-captured policy delivered by the actual product entry adapter. An agent's
self-report alone cannot satisfy discovery. When the candidate ships
`discovery/install.mjs`, the gate runs that machine installer and launches through
its documented `monitor-codex -- exec` machine entry for measured headless
sessions. The automatic interactive PATH shim can deliberately pass headless
`codex exec` through; it is not substituted for explicit entry. A transparent native transport captures the adapter's policy and
refuses checkout/add-dir escapes; it supplies no policy of its own. Candidates
without that installer expose only their installed CLIs and must fail if no
policy is discoverable.

The real sessions extend Codex's native workspace permission profile with only
their own project checkout and per-session temp directory writable, ephemeral
sessions, no shared daemon, and no user configuration,
rules, MCP integrations or memory profile. Isolated runtime homes receive
temporary mode-0600 authentication copies outside all tool writable roots, which
are deleted even with `--keep`. HERDR and ACCEPTANCE variables are stripped.
A native sandbox probe, run before inference, proves harness reads/writes and a
direct connect to the live Herdr socket are denied without sending a request.
The host resolves original HERDR_SOCKET_PATH with the core client fallback,
requires an existing socket before probing, and records that actual endpoint.
Neither approval bypass nor unrestricted sandbox modes are used. A pre-inference native probe must successfully commit, create a worktree and
update a ref in a disposable Git project inside the session temp, using explicit
scratch Git common-directory grants. Direct native sessions can write only
objects, refs, logs, index/lock and lifecycle files and worktree registrations;
Git config and hooks remain read-only, including denied worktree config paths.
The pre-inference probe also requires actual config/hook write denials. Installed sessions keep the product
Git protections and perform writes through its actual bounded session parent;
project validation always keeps Git metadata read-only. Failed capability probes
and prerequisites, interruptions or pane-layout receipt failures are PENDING
with `[HARNESS]` on the screen. Candidate safety violations (capability leaks,
sandbox bypass, foreign roots, unowned targets or outside-scratch paths) are
product FAIL with `[SAFETY]`; an installer missing its documented entry also
fails. Only explicit adapter capability refusals carry the product-boundary marker.
Plain native Herdr failures (including forwarded commands), malformed layout
receipts, stand-in registration and PTY acknowledgement timeouts, and cleanup
I/O failures remain harness errors. Cleanup still preserves a real capability
refusal as a product failure; wrapping it must not hide its cause. Successful discovery still requires actual integration. An initial nested-sandbox experiment cannot establish
discovery: the model must actually read the project and report token usage.

After any real session starts, every harness Git operation on its project runs
inside native acceptance confinement with a read-only checkout/Git metadata,
a fresh verification temp, network disabled, hooks disabled by an absolute
/dev/null hooksPath, and fsmonitor disabled. Final node --test on promoted
model-written code uses that same sandbox. Filters/configuration cannot execute
on the host through evidence capture. The actual installed Git binary is resolved
before entry; macOS /usr/bin/git is a developer-tools launcher that this narrow
profile may not be able to resolve. Trusted record inspection and the scripted
human answer also run under a kernel sandbox with a pinned project .org write
root; redirecting .org cannot write a foreign record. No model-written project
module is imported by host verification.

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
before starting scripts or sending agent keys, and disallows service/plugin/focus commands. Worktree
creation has no environment override; its initial shell/default layout remains a
host-startup isolation limit, and default layouts may add a late pane. A late pane is granted under the ledger
lock only after native pane get proves its current workspace was created by this
run and its cwd lies inside scratch; foreign or out-of-scratch panes are denied. Ownership
updates are locked and atomic for concurrent creation. Explicit workspace/tab
creation uses a scratch zsh startup and waits for its file receipt before sending
a command; a background pane screen alone is not a reliable startup receipt.
The scheduler may close
only recorded watcher PIDs and created workspaces. It does not install plugins,
change launchd or use the operator's bin or release home. The existing Herdr
server still records its normal runtime logs; this is not an isolated Herdr server.

The existing-project case copies live bch-cloak scripts into scratch, records
SHA-256 checksums/modes, and retains a scan of additional callers. Only absolute
path constants and temporary-file locations are relocated. A required launcher
replacement must match, and every copied file is audited again before every
execution; residual live repository/record/release/home paths and symlinks refuse
execution. All copied invocations require a pinned scratch ORG_DIR, with record
shims rejecting changed pins and symlink escapes. An independent kernel boundary
restricts writes to scratch and denies reads of the operator's home, preventing
computed paths from executing live code or writing live records. Route declarations
and forwarded model/effort arguments remain intact. Persona resolution is a
scratch environment-only stand-in. Both supervisor wrappers run in dry-run mode;
the close script consumes actual `org status` from PATH, and apply-settle actually
runs its record commands and ingest, then deliberately stops at a missing Draft
section before any review desk dispatch. The full settle/review handoff remains
unproven. A background workspace omitted from `workspace list` metadata is a
failure only after a bounded 15-second metadata poll. The shell cwd must first equal the copied project, just as in the configured
fixture; each metadata sample includes the fixture comparison. Every sample is
raw evidence; wrappers execute only after canonical checkout metadata appears.

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
behavior. Housekeeping uses the actual released one-pass entrypoint against a promoted,
ingested done worker alongside blocked and needs-human workers, with no optional
housekeeping configuration. Candidates without that module leave the case pending. Late panes inside an
owned workspace use verified membership/cwd receipts, not a guessed child ID.
The cutover coverage gaps keep the gate closed until their behavioral fixtures are
implemented; the current runner cannot approve a release.

Keep only `summary.json` and `screen.txt` per candidate in the repository. All
numbered logs, prompts, transcripts, source/permission receipts and usage stay
under the printed scratch evidence path and must be named in the report.
The screen lists each case and points to its numbered JSONL evidence. `summary.json`
contains reasons, candidate commit and elapsed time. Any failure **or pending**
case exits 1. Passing mechanics never overrides failed discovery or pending
cutover work. A full run usually takes a few minutes; network latency and the
real-session timeouts can make it longer.

By default the runner closes every workspace it created and removes everything
except evidence under `/tmp/herdr-acceptance-*/evidence`. `--keep` retains other
scratch files for debugging, including separate discovery project parents and per-session temps, but still
closes created workspaces and removes authentication copies. SIGINT/SIGTERM
remove credentials before shutting down owned workspaces, remove them again
afterward, and emit an interrupted summary with cleanup errors and credential
residue. Forced SIGKILL cannot run a handler. `ACCEPTANCE_TMPDIR` can select another scratch parent.
If cleanup fails, the summary identifies the failure and scratch ownership ledger.
Every discovery/verification root that still exists is listed in the summary and
on the cleanup screen line regardless of keep; a failed non-keep cleanup never
hides retained paths.

`--skip-live` is for mechanics debugging: discovery becomes pending, so this
cannot approve a release. Omitting `--bch-cloak` leaves that compatibility case
pending; no live repository location is assumed for other projects.

Offline checks of the test boundary, also separate from `npm test`:

```sh
node --test acceptance/test/*.test.mjs
```
