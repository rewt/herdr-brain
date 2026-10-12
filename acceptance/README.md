# Local release acceptance

Run from a Herdr pane, with Node 20+, Git, Bash, zsh, ripgrep (`rg`), Python 3
(`python3`), tar, npm, macOS `sandbox-exec`, Herdr and the installed Codex CLI.
Startup probes every required executable; missing tools produce a named PENDING
result before executing candidate or copied code.

The `lessons-entry` gate case also requires the installed native Claude CLI. It
plants an active area lesson in a scratch record, then launches fresh Codex and
Claude processes through the candidate's installed automatic entry. The shared
receipt machinery retains the actual native prompt arguments and policy source.
Codex must reach a live interactive UI. Without an explicitly configured Claude
profile, Claude proves lesson delivery at the native launch input and native
process start only, even if it subsequently exits for missing login. The case
reports PASS with a visible LIMITATION in the screen and JSON summary; it does
not claim Claude interactive readiness. PASS retains the two delivery proofs
and Codex readiness instead of skipping the whole case.

Supply `--claude-profile DEDICATED_PROFILE` only for an operator-authorized,
credentialed profile to require the full Claude interactive readiness proof.
The directory is copied into the owned temporary `claude-runtime` profile
(symlinks are refused); the original is never written. The copy is removed on
success, failure and interruption, including with `--keep`, and residue is
reported alongside Codex credentials. No profile is discovered from the
environment, user home or Keychain. Both full UI proofs reject banner/prompt
then exit, including when adapter cleanup is delayed. The default canary uses scratch
homes, no operator credentials, no task prompt, no model turn and a boundary that
denies network and writes outside owned scratch/profile/terminal devices.
Created panes and processes use the gate's existing ownership and producer
cleanup. Evidence is
`lessons-planted.json`, `lessons-{codex,claude}.entry.json` and corresponding
`.screen.txt` files. Missing native tools or `--skip-live` keep the gate pending.

Offline tests in `test/plugin-install.test.mjs` cover real v0.1.3/v0.1.4 scratch
releases, namespaced rollback, read-only shell files and durable recovery after
failed/terminated writes. Absolute native paths, desktop/remote entry and other
shells need their own entry transports; see
[installation coverage](../herdr/README.md). The Herdr plugin and its
installed-entry canary were removed on 2026-10-12.

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /path/to/live/bch-cloak
```

`--candidate` accepts a Git tag/ref or an existing release directory. `--source`
selects the Git repository for tags/refs. The runner snapshots the candidate;
it never modifies that source or an activated release. `main` means the commit
resolved at startup, not a moving branch during the test.

The gate records machine load in `evidence/load.jsonl`: all three load averages,
CPU capacity and the heavy-load threshold, with timestamps. It samples every
second while the event loop is free, on every wait poll, and before/after each
blocking child command. `summary.json` retains the run peak and each case's load
window. Heavy load means the one-minute average is at least the available CPU
count. A report-wait or child-command timeout with heavy
load measured during that operation is harness PENDING with the load named;
the gate remains NOT READY until it passes on a usable machine. A candidate
that never reports at normal load remains product FAIL. Earlier contention in
an unrelated case cannot excuse a later timeout. Focus-monitor timeouts retain
their existing harness classification and name the run's measured contention.
Safety refusals and incorrect product behaviour remain FAIL at any load. Waits
and child commands scale their base allowances once at each operation using
`lib/deadline.mjs`, with CPU capacity capped at four. Load 24 on a host with at
least four CPUs gives a factor of six (60 seconds becomes 360 seconds). A hung
child is forcibly killed at its finite deadline; load never creates unlimited
retries. Command evidence records the effective `timeoutMs`. See
[the complete deadline inventory](DEADLINES.md), including deliberate fixed
watchdog timers and observation cadence.
Retry context preserves the original timeout type and operation samples. The
delegated settle and supervisor cases use the same load-aware waits for report
and queue receipts, and measure each bounded fixture command. Ordinary child
output cannot establish a process timeout: timeout words in successful test names
or diagnostics never downgrade an independent failed assertion. A child deadline
requires the process API's typed `ETIMEDOUT`; native harness limits retain their
existing classification. Fixture cleanup is registered before setup commands and
awaited before either delegated case returns.

After auditing the snapshot, the runner adds owner read/write permission to its
files and owner read/write/traverse permission to its directories, preserving
executable bits. This applies to both Git archives and immutable release copies
inside scratch; source modes and bytes remain untouched. Environment I/O errors
(including permission and disk-space errors) naming this run's scratch paths
are PENDING with `[HARNESS]`, including errors from child commands. Explicit
product safety refusals retain precedence and remain FAIL with `[SAFETY]`.
All temporary roots created by the runner, including separate discovery projects,
session temps and verification temps, are registered before setup. Classification
uses that shared registry and resolves real paths before checking containment.
Parent traversal, dangling symlinks, mixed foreign paths or other uncertainty
remain product failures; a scratch-looking path alone is insufficient.

The `operator-focus` case watches the server's focused pane from before the
candidate snapshot through owned-workspace cleanup. A separate read-only process
samples global focus through `pane.current` without a caller ID every 200 ms,
including while the runner blocks in child commands, and
subscribes to `pane.focused` and handles native `pane_focused` event envelopes
so an owned or call-correlated change restored between samples also fails.
Herdr 0.8.2 replays retained lifecycle events when subscribing. Before candidate
work starts, the monitor retains these as `subscription-startup` diagnostics,
then takes its baseline after either four quiet 100 ms polling cycles or at
least 512 focus events. Herdr 0.8.2 (protocol 20) retains at most 512 lifecycle
events across all kinds, so the latter exhausts replay even while the operator
keeps navigating. The monitor verifies that version before using the bound;
unknown bounds or a stream exceeding the load-adjusted 60-second startup deadline
are PENDING. `startupDrain` records the server, completion reason and elapsed
time. Candidate work waits for readiness, and events are never discarded after
monitoring starts.
`focus-trace.jsonl`, `focus-calls.jsonl` and `focus-summary.json` retain the initial
and current baselines, case, timestamps, samples, events and actual/requested
Herdr calls. Failure details also name the previously observed pane, whether it
belonged to the scratch receipts or the operator, and the nearest recorded
harness and candidate product calls (with their age and actor), even when they
are too old or unrelated to establish correlation. Calls from other clients are
not visible through the scoped adapter. A move into a harness-owned pane or workspace fails, including late
panes absent from the pane ledger. A change correlated with an active or recently
completed harness/candidate call fails only when its destination is the specific
pane or workspace that call targeted or created, and names that call. Mere time
overlap with an unrelated call is retained in `nearbyCalls` as diagnostic context.
Creation-result receipts retain opaque IDs before ownership registration and
through cleanup. Other changes are recorded as external activity and re-baseline
the monitor, so the operator
and unrelated projects can navigate during a run. Ownership receipts are retained
through cleanup. Missing samples, unresolved destinations or a broken subscription
are PENDING, never proof of preserved focus. The monitor never restores focus.
Forbidden focus attempts also produce typed receipts and fail the case even if
the caller suppresses the refusal and exits successfully. Late observations
correlate against the most recent matching completion for one second after that
call ends.

The model-free stand-in renders a real shaded, padded empty Codex composer before
reporting idle; reads still use the native PTY screen and the production composer
check. Shared product tab cleanup preserves globally focused tabs, including at
the final recheck. The previous unattributed focus change is not treated as proof
of that cleanup cause.

On Herdr 0.8.2, `--no-focus` covers workspace/worktree/tab creation, worktree open,
pane split/move and plugin pane open; it is not an option for agent start, pane run
or terminal input. Those input operations preserve focus. `worktree remove`
unconditionally focuses its parent, so lane closure instead retains the verified
background workspace ID, removes the checkout through Git, then closes that
workspace only after successful removal. A Git refusal preserves its panes.
Explicit focus/attach and zoom
are reserved for operator navigation, never background dispatch or acceptance.

The primary cases enter new Git projects without `.org`, `.lane.json`, routes or
agent instructions. Missing product capabilities fail. Genuine environment limitations remain pending. `supervisor-entry` executes installed supervisor entry and record bootstrap in a
dedicated untouched project. It verifies the generated cold start and final-notice
handler through the same assertion used by the offline installed-entry test;
it does not claim a dispatch/watch cycle. `default-cycle` executes the default supervisor dispatch/watch/ingest cycle in another untouched project: the scripted supervisor in a real PTY executes entry and record bootstrap, dispatches on the suggested engineer route, consumes watch's single final notice, and runs the record CLI to check and ingest it. Default lane validation and fast-forward promotion also execute. Only an ordinary package test script and a scratch HOME are provided, with no workflow config. The delivery target is an owned scratch stand-in rather than a live supervisor name. The configured mechanics
fixture is a separate case: its record, route, validation command and ignored
session registry are explicit test setup, never evidence that defaults work.

The settle case separately executes report → settle → correction run → watch
delivery → settle → promotable in a project with no route/lifecycle configuration.
Git, record, lane review/check, dispatch and watch are actual candidate code;
Herdr and model transport and the independent claim check are scripted. It does
not establish live review quality, real PTY transport or the default supervisor
cycle. Run this case alone offline with `node acceptance/settle.mjs [CANDIDATE_DIR]`.

The `supervisor-cycle` case adds cold starts for fresh, populated and restarted
supervisor entries, final watch notice routing, independent finding and fix,
actual queued promotion/closure and guarded record completion. Promotion authority
is the scripted supervisor's explicit judgment; mechanics need no executive model.
Duplicate notices/enqueues reuse receipts, including final reports delivered after
the promoted lane is removed. Run it alone offline with
`node acceptance/supervisor.mjs [CANDIDATE_DIR]`.

Two real sessions receive overlapping greeting changes in the same new project.
A third receives a routing task in another new project. Their prompts provide
tasks and scratch safety boundaries; they do not name lanes, record setup,
route defaults or promotion commands. The default is the operator's lowest
declared route, `gpt-5.6-luna` at `low`; `--discovery-model` and
`--discovery-effort` can select another available route. The harness does not
automatically escalate models. Each session has a load-adjusted 180-second
runtime allowance followed by a load-adjusted one-second TERM-to-KILL grace.
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

Validation transport composes the product's read-only shared-state exclusions
with the gate profile, rather than replacing its lifetime identity. On macOS it
grants read access to one verified private inert probe, retains the second probe's
denial, and forwards the owner's readiness descriptor. Probe directories remain
unreadable, session paths outside the validation checkout remain read-only, and
Git metadata and network restrictions remain in force. Verified product write
exceptions inside the checkout, including its validation TMPDIR, stay writable;
redirected paths and grants covering protected state or Git metadata refuse.
Offline native transport regressions run in `npm run test:acceptance` without
authentication or model calls.

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
raw evidence. `existing-wrappers` executes the frozen contrib wrappers to retain their
identity refusal when metadata is absent, then changes only the audited scratch
launcher's entry target to `supervisor/open-session.mjs` (the ENG-64 switch).
Both wrapper dry runs and routing tests must pass through the candidate's native
`worktree list --cwd` identity lookup and select the created background workspace.
The launcher bytes and mode are restored before later cases, and the switch,
legacy results and restoration receipt are retained in
`workspace-identity-cutover.json`. This proves the supervisor entry switch's
background lookup; the remaining ENG-64 switch canaries stay independently gated.

The promotion queue case uses a fresh project without lane/promotion configuration or
a record, runs two default npm gates in FIFO order, keeps a dirty refused lane, and
requires all three notices at the owned supervisor PTY. It retains queue and gate
logs under the scratch evidence directory. The gate's test-slot token and both
slot paths survive scratch environment scrubbing, including the PTY supervisor's
child dispatch, so nested validation runs inside the gate's existing host slot.


Release mechanics build immutable copies with the candidate release script in a
scratch repository/home/bin, then activate, reactivate, roll back and restore.
They include a `before/` directory that predates the `record` launcher.
Plugin linking and launchd are excluded by the brief's boundary. The product has
no npm dependencies, so no dependency build runs.

The thirteen ENG-64 switches (including cleanup, retirement of the legacy notify section
of the mixed se-test, and the event-service comment correction) are applied to the audited live-script copies and executed,
then rolled back byte-for-byte with their original executable modes. Raw live
bytes/checksums remain in a separate backup; executed baselines are relocated.
Legacy temporary files and worktree constants all resolve inside scratch. Fixed
workspace and supervisor names are bound to this run's creation receipts, so
neither switched nor restored scripts can target a live supervisor. The native
socket endpoint is pinned in the ownership ledger before changing HOME.

`cutover-switches` executes naming/restart and missing-target refusal, routed launcher tests,
executive dry run, real busy-session refusal and same-request retry, real copied
dispatch through the new arm wrapper, watch-log recovery through tidy across multiple run logs, one mutating copied
tidy/close-finished-agents cycle with recorded done, blocked and needs-human workers (all idle), released
notice constructors, zero-caller notify retirement, exact rollback, legacy wrapper
tests and a real restored notify-watch canary. The normal application's build is
outside this watcher switch: its trusted empty lane is prebuilt before legacy
dispatch, which still uses the actual copied lane/routing/dispatch code. Every
subcheck has a stable key and is retained in `cutover-switches.json`. Recovery and
copied cleanup require `switched-canary`; a pending canary preserves its cause and
classification through both dependents and final retirement. An independent product
failure takes precedence over a separate harness limitation. The final notice must actually arrive before
a canary qualifies for retirement. Documentation contract assertions supplement
the executed consumers; they do not establish an agent's interpretation of prose.

`contrib-retirement` first plants an extra caller and proves contrib removal refuses, then
removes it, scans both caller trees, retires the snapshot's compatibility blob only
after zero callers and a delivered switched canary, executes the split routing
suite without contrib, and restores the exact blob/mode before restoring legacy
callers. The checkout's contrib file is untouched. Missing split modules in older
candidates are product FAIL in these three cases, rather than permanent pending
coverage. Notifications are captured as scratch evidence without showing host UI.
The busy-retry check resolves the copied launcher's actual existing-project
workspace from its native canonical lookup and checks it against the creation
receipt. Refusal must leave its tabs/panes unchanged, with no successful creation
or received prompt anywhere in the owned fixture. Retry must produce exactly one
new destination tab/pane, one registered executive and one matching scripted PTY
prompt receipt. Exit status alone cannot establish a retry. Both stages retain
native topology, creation and input receipts in `cutover-busy-retry.json`. Offline
controls reject a leaking refusal (even when the configured workspace stays
unchanged), a leak closed before the final topology read, an exit-zero no-op retry,
and missing or misdirected session/prompt receipts.

Legacy detached watcher PIDs come from a scratch nohup adapter's creation receipt;
cleanup does not discover processes by names or global scans.

Housekeeping uses the actual released one-pass entrypoint against a promoted,
ingested done worker alongside blocked and needs-human workers, with no optional
housekeeping configuration. Candidates without that module leave the case pending.
Late panes inside an owned workspace use verified membership/cwd receipts, not a
guessed child ID. No project-wide loop is started.

Keep only `summary.json` and `screen.txt` per candidate in the repository. All
numbered logs, prompts, transcripts, source/permission receipts and usage stay
under the printed scratch evidence path and must be named in the report.
The screen lists each case and points to its numbered JSONL evidence. `summary.json`
contains stable case keys, reasons, candidate commit and elapsed time. Case keys
and declared prerequisites live in `acceptance/cases.mjs`; numbered IDs and log
filenames are presentation only. Dependencies resolve by key, so inserting or
reordering unrelated cases cannot redirect them. Offline regressions insert a case
at every position in the current merged ordering and compare all keyed outcomes
and executed bodies. Any failure **or pending**
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
Creation replies (including linked worktree open/create replies) are appended and
synced to `creations.jsonl` before topology or shell-startup probes. Cleanup replays
that journal even when ownership folding failed, attempts each receipt-owned
workspace independently, and audits the raw native workspace list. A failed
workspace get never counts as proof of closure. `cleanup-residue.json` retains
the before/after inventories and names every remaining owned or scratch workspace
by ID and label; an unreceipted scratch workspace is reported, never granted
closure authority. Before any cleanup snapshot, a durable stop marker refuses
new adapter and worker commands. Cleanup awaits every registered PTY worker and
adapter (including native calls already in flight), then collects and stops
recorded watchers and awaits their exit. A producer drain timeout refuses the
snapshot and retains scratch for recovery. Workers stop after any bounded active
candidate command completes; the live worker terminates and awaits its owned
model child. `producers-drained.json` records this barrier completion.
Herdr can implicitly open the main checkout during `worktree create/open --cwd`.
Before **every** `workspace create` and `worktree create/open` call, with either
`--cwd` or `--workspace`, the adapter syncs a creation intent containing baseline
IDs, canonical confined destination paths and the requested label. When no label
was supplied, it adds a unique recovery label. Recovery accepts only new native
IDs at those exact paths, or that unique label when path metadata is absent.
Caller-supplied labels alone never grant ownership: missing workspace metadata
requires native pane identity and exact cwd proof. Contradictory foreign paths
and baseline IDs never gain ownership. Cleanup replays receipts and reconciles
intents after draining, closes owned workspaces, then reconciles again and closes
newly visible creations before the final raw inventory audit. These paths have
offline lost-reply SIGINT/SIGTERM coverage while creation is active, including a
supervisor in default-cycle dispatch; release-only live validation remains required.
Every discovery/verification root that still exists is listed in the summary and
on the cleanup screen line regardless of keep; a failed non-keep cleanup never
hides retained paths.

`--skip-live` is for mechanics debugging: discovery becomes pending, so this
cannot approve a release. Omitting `--bch-cloak` reports the five existing-project
compatibility cases as SKIP, with a visible reason in the screen and JSON summary.
These skips do not block READY; all other failures and pending cases still do.
No live repository location is assumed for other projects. Supplying the option
keeps every existing-project copy, wrapper, PATH, switch and retirement requirement
in force, including their prerequisites; a bad configured project is never skipped.

Offline checks of the test boundary, also separate from `npm test`:

```sh
node --test acceptance/test/*.test.mjs
```

The scratch cutover plan also changes `close-finished-agents.sh`: only a latest
recorded done or unreported abandoned run permits closing an idle worker tab.
Blocked, needs-human, open, unknown, unrecorded workers and mixed protected tabs
remain; the old agentless sweep and tidy label/branch-based workspace sweep are
removed so they cannot bypass the outcome guard. `cutover-switches` executes the copied installed
cleanup through tidy with real mutations, independently of `housekeeping`.
Recovery retains a labelled bounded tail from every run, so a late notice in an
older run cannot be hidden by a long newer log. Dependent cases retain prerequisite
causes: failed Herdr fixtures remain pending rather than becoming product failures;
missing candidate modules still fail explicitly.

The cutover arm wrapper uses the candidate's reusable `supervisor/arm-watch.sh`
with the copied project's own record, checkout and named supervisor. Its notice
contract requires the record JSONL inbox, `notice-autopilot/v1`, preservation of
the old plain-text inbox, and stopping the legacy supervisor-events consumer
before arming the new path. Rollback starts that consumer only after new senders
and pending delivery have drained. The rehearsal never controls the live launchd
daemon. `watch/test/existing-project.test.mjs` separately proves journal and
autopilot binding plus named exception delivery with real Git/record state and
scripted offline settle/Herdr transport.

The existing-project copier recursively discovers untracked supervisor scripts
and support documents/configuration (including nested files and newly required
documents such as `no-poll-waiting.md`). Every copied file has a raw byte/mode
backup and a SHA-256 manifest entry. Logs, outbox/inbox, queues, locks, process
receipts, caches and current handoff snapshots stay out of the rehearsal. Source
and support symlinks are refused. The copy still undergoes path relocation and
the transitive audit before execution.

For focused offline checks against a current read-only bch-cloak checkout:

```sh
TMPDIR=/private/tmp ACCEPTANCE_BCH_CLOAK=/path/to/bch-cloak node --test acceptance/test/cutover.test.mjs acceptance/test/cutover-housekeeping.test.mjs
```

The live premise check snapshots every current cutover input, relocates and
audits the copy, checks the switched contracts and restores its bytes/modes.
Housekeeping executes the copied dispatch and cleanup against scripted Herdr.
The other regressions retain the pinned inventory. Exact equivalent replacement
clauses are accepted unchanged; tidy also accepts whitespace inside the existing
dry-run command substitution. Unrelated drift, duplicate cleanup calls and
ambiguous deletion/shared-label premises still refuse.

The rehearsal does **not** exercise dispatch's process-based in-flight cap:
host `ps` can be denied by the sandbox, and a successful dispatch does not prove
that count was observed. This limitation appears in the switch case result and
`cutover-switches.json`. The sandbox grants stay unchanged; the offline dispatch
test proves cap matching and refusal for legacy and switched watcher argv with
deterministic `ps` output, separately from the real kernel-lock checks.

The copier archives timestamped script backups outside the executable caller tree
only after proving they have no reference from any active source, including
transitive references through other backups. Recognized timestamped shell/JS/Python
backups are enumerated regardless of executable mode: an interpreter can invoke
a readable mode-0644 backup. Referenced backups remain in the copied caller tree
with their original mode; only proven unreferenced ones qualify as historical.
The native retirement refusal probe includes a wrapper invoking a mode-0644
Python backup. The retirement scanner itself has no
backup/notify-file exemption. It conservatively retains asterisk-leading lines,
including executable shell case arms, both for callers and backup references.
These source and archive receipts stay in evidence.

Scratch cleanup drains notice senders before stopping inbox owner workers. It
uses only scratch-local owner receipts, verifies live argv, birth identity and
process group, stops owned transport children first, and retains
`inbox-cleanup.json`. Missing or ambiguous identities fail cleanup without
signalling replacements. Workspace cleanup still runs if inbox teardown fails.
The native validation adapter admits only the exact private `r-XXXXXX` temporary
directory beneath its session root named by all three temporary environment
variables; broader session writes, redirects and protected state remain denied.

Failure-path teardown holds the scripted worker's working transition until the
watcher logs the recorded abandonment. A PTY input receipt can precede notice
confirmation; returning to idle after a 300ms pulse can make the subsequent
native wait miss that transition and turn a successful notice into a timeout.
