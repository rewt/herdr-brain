# Release acceptance

`node acceptance/run.mjs --candidate TAG|REF|DIRECTORY [--source REPO] [--keep]`
is the optional live candidate gate (`release.sh build TAG --live`). Run it at most
once per release candidate from the operator's
release context. Lane workers run focused offline tests and never run the live gate.
Tests never call a model.

The gate snapshots candidate code into owned scratch storage and exercises:

- Record discovery and population, default routes and foreground supervisor context.
- Scripted workers and supervisor in real Herdr panes, dispatch, watch, final report
  ingestion, fix rounds, and lane validation, promotion and closure.
- Promotion queue order, refusal, notices and housekeeping cleanup.
- Immutable scratch release build, activation, rollback and three launcher links.
- Offline settle and supervisor cycles using real product modules and scripted transport.
- Owned process, inbox and workspace cleanup, plus operator focus preservation.

Native Codex and Claude are launched by the product through Herdr; the acceptance
workers simulate lifecycle reports without starting either model. Acceptance owns
only scratch project roots, records, workspace receipts and subprocesses. Its
Herdr transport refuses foreign paths, panes and workspaces, journals creation
intent before calls, and reconciles lost replies before cleanup. Stop producers
before reading journals so late replies cannot escape ownership accounting.

An explicitly assigned live harness repair can run just its affected cases with
`--cases configured-cycle,missing-worker,invalid-worker,blocked-worker,fix-round,watch-grace,housekeeping,default-cycle`.
Selection uses stable case keys and automatically includes prerequisites, the
candidate snapshot, cleanup and focus controls. Other cases are recorded as
unrun/SKIP. A focused summary always has `ready: false`; `selectionPassed` reports
only that selection's outcome. It cannot qualify a release or reuse prior live
coverage with `--continue`.

Stand-ins wait for an idle owned-pane inventory receipt before direct lookup;
native failures still stop startup. Their raw PTY prompts include an explicit
newline before Enter and require the worker's input receipt. Correction rounds
dispatch a fresh allocation from the saved author branch, then integrate and
retire both workers. A process-cwd KEEP is accepted only with the exact lane and
a matching native worker shell/foreground PID.
The stand-in puts its owned PTY in raw mode before readiness, matching native
model input and avoiding canonical line-buffer loss on long dispatch briefs.
Raw Ctrl-C keeps the existing graceful stop behavior. The input trace retains
bounded byte tails and lifecycle completion for diagnosing pending delivery.

`--skip-live` is retained as a compatibility option. The former real-model cases,
entry installation probes, generated permission-profile verification and copied
bch-cloak cutover rehearsals have been removed. The release lane supplies the
small offline consumer contract check.

The copied-project inventory (`existing-project.mjs`) and its cutover tests were
deleted in commit `013f691d63c2790a8d4989059dfb83eff1b9ada5`. The follow-ups to
remove that copier's support-file extension allowlist and extract its BCH runtime
snapshot names (ENG-240) are superseded by that removal; they describe no current
acceptance behavior. See [the closeout evidence](../docs/reports/ENG-240-cutover-copy-R-867.md).

The run retains numbered command logs, load samples and a summary under its
scratch evidence directory. PASS means the case completed. Product failures are
FAIL; unavailable host prerequisites and measured load timeouts are PENDING.
Cleanup failures retain their owned roots for inspection. `--keep` retains scratch
artifacts; credentials are always removed. Successful cleanup leaves only evidence.
The build passes `--summary-file FILE` to retain an exact copy of the final
summary before sealing its bundle; the ordinary evidence summary is still written.

The gate needs Node, Git, Bash, zsh, rg, tar, npm and Herdr. It never mutates a live
project record or operator pane. Focus monitoring and ownership checks remain
required for a complete live gate. Run `node --test acceptance/test/FILE.test.mjs`
for the changed offline contract tests.

`node test/helpers/run.mjs acceptance/test/release.test.mjs` runs the isolated
scratch release step without launching the live gate. It also checks the two
slot fixtures under acceptance's scratch HOME, XDG, TMPDIR and checkout layout.
The tagged switch fixtures declare their small release gate in
`.lane.validation.json`, the declaration consumed by the release builder.

The focus gate keeps every observation in `focus-trace.jsonl` and its classified
changes in `focus-summary.json`. A move to a call's destination while it is active
or within five seconds of its completion fails, even during operator navigation.
For an owned destination, a call targeting any pane in the same workspace also
attributes the move, including a new pane after a split or a sibling after a send.
This uses native pane ID workspace prefixes and applies only to owned destinations.
This fixed attribution window includes delayed create, split and send effects;
it extends the previous one-second completion window and is not load-scaled.
An unexplained move into a harness-owned pane or workspace also fails by default.

A distinct, uncorrelated move between two panes outside harness ownership is
evidence of operator activity for the next 60 seconds. During that window an
unexplained move into a harness workspace is retained as `not-attributable`,
including the preceding operator move, its age, ownership and nearest calls.
The check can pass with a visible `WARNING: NOT-ATTRIBUTABLE` count in its detail
and release screen. Such a warning means the source is unknown, not that focus
preservation was proved for that move. Sixty seconds covers the observed
55-second operator navigation gap without exempting the rest of a long build.
Harness visits, unchanged samples and returns from harness panes never renew the
window. Attributed moves, forbidden focus attempts and incomplete traces still
fail or remain pending as before; no later operator activity erases a failure.

The reusable installed-consumer witness is
`node test/helpers/run.mjs acceptance/test/installed-cycle.test.mjs` (pinned Node
20.19.4, macOS). Set `INSTALLED_CYCLE_EVIDENCE=/absolute/archive` to retain its
per-case config, manifests, command/stage logs, record and cleanup receipts outside
the disposable folders. It replays exact ENG-1020 pre-fix/fixed payloads, then
runs the current committed payload through installed dispatch, source landing,
watcher/report intake, one record-queued review after producer-folder removal,
review completion and cleanup. A separate lost-prompt-reply action must retain
its original journal, input count and folder on another line pass.

Each case has private Git objects, org, HOME/XDG/config/release homes, in-process
and child fleet, a nonexistent development source and a refusal-only socket.
`sandbox-exec` denies network and the real account home except the pinned Node
directory, with both in-process and child denial probes before product calls.
Native UI/model responses, scratch OS account/process/file observations and the fixture
acceptance input are scripted;
real installed record, lane, dispatcher, watcher and finite line code run. The
fixture binding creates no launchd job, and its synthetic READY input certifies
no release coverage. These results prove mechanics, never independent model
judgment, live adoption or final-release readiness. Failed scratch is retained.

Scripted shells and workers have distinct private PIDs above one billion and
stable numeric birth identities. Only that namespace is simulated by the native
process-source observation seam; real controller/watcher birth reads still use
the installed kernel helper. Worker exit removes its process row. The canary
checks the committed launch binding at the first prompt. A separate scratch PID,
visible only in the controller process, verifies that reuse, absence and malformed
births fail continuity and that the original birth recovers. These controls never
rewrite shared `native.json` or fault the live producer; its continuity is checked
throughout. The installed pre-prompt binding rule is unchanged.

The current case also migrates through the existing stopped-service path, then
advances to a second immutable fixture root while the first producer and watcher
are live. It moves project main and lets the successor line start its next
child: native landing evidence has already queued the producer's one original
review, so that review is the successor-root child, started before the producer
report. The case rolls back before either report is published; the restored
line then ingests both and must not queue a second review. The scratch pin and
main commits queue canonical reviews too, so later stages observe the line's own
selection rather than a fixture-chosen order. Every captured dispatch file must keep
its exact digest, both watchers retain their captured roots, and the original
installation/plist bytes are restored. Both roots contain the same committed
payload: this tests root selection and lifecycle mechanics; the historical
stale-fold refusal is a separate runtime compatibility control. Scripted
launchctl observations are retained in `scripted-controls.jsonl`; executable
paths in `executables.jsonl`; roots, plans and job digests in `stages.json`.

The frozen-candidate extension uses the same scenario and project runner:

```sh
INSTALLED_CYCLE_BUNDLE=/absolute/read-only/bundle \
INSTALLED_CYCLE_COMMIT=FULL_SOURCE_COMMIT \
INSTALLED_CYCLE_TREE=FULL_SOURCE_TREE \
INSTALLED_CYCLE_MANIFEST_SHA256=ORIGINAL_MANIFEST_SHA256 \
INSTALLED_CYCLE_EVIDENCE=/absolute/archive/unique-attempt \
node test/helpers/run.mjs --test-name-pattern='^installed-only canary ' acceptance/test/installed-cycle.test.mjs
```

Use pinned Node 20.19.4 through the owning lane's `check --cmd`. Supply a
previously frozen bundle, never a mutable `current` symlink. The commit, original
manifest digest and complete runtime inventory are verified before effects;
the source tree comes from the retained validation metadata, or the coordinator's
explicit tuple for an unqualified scratch build. No source fallback occurs in
this mode. Without an explicit bundle the canary case is SKIP/UNRUN. Historical
broken/fixed witnesses are reused, not replayed by this selection.

`brain.installed-canary/v1` is the packet contract for probation and soak owners.
`outcome.json` names the original `brain.installed-candidate/v1` tuple, S0–S8
and shared-observer results, immutable consumer base/head, original review and
zero reviewer suites. `stages.json` includes UTC boundaries and monotonic spans;
`commands.jsonl`, `executables.jsonl`, the complete scratch record and dispatch
journals retain actual commands, runtime roots, attempts and effect receipts.
`candidate-equivalence.json` compares every runtime file/hash/mode with the
original bundle; both manifests are retained separately. Fixture READY changes
only scratch release metadata and never qualifies the original runtime.

S1/S2 finish two ordinary units with A's source/session/folder retired before
its original review starts, B starts/completes while that verdict is pending,
and the original cap1 review then completes without suites. Canonical reviews
of scratch policy/pin commits are separately accounted. S3/S5 retain lost and
refused original input, missing-folder evidence and scripted legacy UNKNOWN
qualification/reused-lane/session controls using the installed implementation.
The legacy facts are visibly synthetic, not historical success receipts.
S4 places independent selection, promotion and report-cleanup STOP/HOLD controls.
S6 runs real proposal intake/disposition and an exhausted original finite turn.
S7 uses the existing archived upgrade/rollback intent with a live captured
producer/watcher, plus a refused missing-target control. S8 uses supported
record selection policy on the same installed release as its explicit equivalent
to the owner-held ENG-1041 live demo. Unlanded branches and dirty/UNKNOWN work
are retained in the durable archive before disposable scratch is removed.

The shared case starts the candidate's actual `watch/observer.mjs`, dispatches
with `--watch-mode shared`, and uses original finite `watch --step` consumers.
Its Codex workers have no session at registration; the first prompt establishes
one and the real dispatch commits `run.session_bound` before observation and
report cleanup use that session. The original registration remains unchanged.
Native snapshots/subscription acknowledgement use a declared in-memory protocol
22 seam, while native and file hints are deliberately dropped. The unchanged
30-second safety timer must recover blocked, vanished and report observations;
the report is ingested once and physical cleanup is verified. A vanished duty's
original failure remains held, never replaced. Consumer concurrency remains two.
This extends mechanics evidence only; genuine native execution, probation,
the real-work soak, activation and adoption remain with their recorded owners.

For an affected shared-observer correction after retaining the original
lifecycle packet, add `INSTALLED_CYCLE_SHARED_ONLY=1` to that focused command.
It returns `brain.installed-shared-control/v1`, explicitly marking the whole
canary UNRUN; it cannot turn a failed original candidate into a canary PASS.
Before dropping each hint, the control waits for a durable waiting step and an
idle observer. It then requires the actual safety-repair row, and retains the
vanished consumer's durable failed step and original held registration.

After a fixture correction with a retained passing S7 packet on the same exact
candidate, `INSTALLED_CYCLE_SKIP_PASSED_CASES=S7` omits the S7
upgrade/rollback case from the lifecycle rerun. No other case can be omitted by
this selector. Isolation and candidate equality are prerequisites on every new
scratch allocation. The result uses `brain.installed-lifecycle-control/v1`, lists
only executed cases and marks `wholeCanary: UNRUN`; combine it with the original
S7 evidence explicitly, preserving the original red gate. S1 waits for the
original completed closeout evaluation and native workspace absence as well as
folder removal, within the unchanged 120-second limit.

S7 is not state-independent of the later lifecycle cases: it runs after A lands
and before A reports, adds two pin-selection commits to scratch main, and stops
and restarts the scratch launchd service. With S7 omitted, the later cases run
on scratch main with two fewer commits and without that preceding maintenance
cycle. Combining the retained S7 evidence with the subset therefore does not
prove those later cases after S7's maintenance. The impact is limited because
line passes run in-process via `service(0).pass()` and S7 restores the scenario
pin; retain this limitation alongside the combined case evidence.
