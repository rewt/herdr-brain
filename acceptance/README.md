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
Only native UI/model responses and a fixture acceptance input are scripted;
real installed record, lane, dispatcher, watcher and finite line code run. The
fixture binding creates no launchd job, and its synthetic READY input certifies
no release coverage. These results prove mechanics, never independent model
judgment, live adoption or final-release readiness. Failed scratch is retained.
