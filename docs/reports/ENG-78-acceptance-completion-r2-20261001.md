---
run: R-68
outcome: done
summary: |
  Fixed all four acceptance review findings. The scratch cutover now changes eleven files, including cleanup that closes only eligible recorded workers and preserves blocked and needs_human reports. Case 18 executes the actual copied tidy/cleanup path against real idle PTY workers; all ten subchecks pass and rollback restores every byte and mode. Recovery keeps a bounded tail from each run, retirement scans nested Python and executable sources, and dependent cases retain prerequisite causes. The final main gate passes 23/23; v0.1.3 reports 7 passes, 6 failures and 10 pending cases on the same harness. No live switch was performed.
headline: The scratch cutover preserves workers that still need decisions
blockers: []
proposals: []
learnings:
  - "An idle worker with a recorded blocked or needs_human report must remain available; a report file alone is not a recorded completion."
  - "Tidying cannot bypass the recorded-outcome guard through workspace labels, branch absence or an agentless sweep."
  - "A single tail after concatenating run logs can hide a late notice in an older run; bound each run's tail independently."
  - "Retirement must scan nested Python and executable sources, including notify-watch itself. Only unreferenced historical backups belong outside executable caller trees."
  - "Missing optional copies and unavailable supervisor fixtures must preserve prerequisite reasons and pending classification in dependent cases."
artifacts:
  - "Commit: Preserve protected workers in the executed scratch cutover"
  - "Commit: Report protected cleanup and acceptance review fixes"
  - "acceptance/cutover.mjs; acceptance/run.mjs; acceptance/limits.mjs; acceptance/README.md"
  - "acceptance/test/cutover.test.mjs; acceptance/test/results.test.mjs"
  - "docs/reports/ENG-64-one-watcher-20261001.md: amended eleven-file reversible cutover plan"
  - "docs/reports/ENG-78-acceptance-evidence-r2-20261001/{main,v0.1.3}/{screen.txt,summary.json}"
  - "npm test: 410 passed, zero failed, two explicit skips; native acceptance boundary suite: 38 passed"
decisions:
  - text: Add the copied cleanup helper as an eleventh mandatory cutover edit and remove sweeps that bypass its outcome guard.
    category: design
    why: The original copied script can close idle blocked or needs-human workers. Its replacement requires a latest recorded done or unreported abandoned run and protects mixed tabs, open, unknown and unrecorded workers.
  - text: Execute copied tidy with mutations and inspect successful native topology lists for one cleanup cycle.
    category: prover
    why: Separate housekeeping or a dry run cannot establish the installed copied path's behavior. Positive list receipts distinguish a real closure from a native read failure.
  - text: Archive only proven unreferenced timestamped backups outside scratch executable caller trees.
    category: tooling
    why: The copier retains active Python and executable sources recursively, including transitive backup references; the retirement scanner itself has no backup or notify-file exclusion.
questions: []
challenges:
  - premise: A green dry-run recovery check and separate housekeeping check establish copied cleanup safety.
    verdict: wrong
    evidence: The old selector treated recorded blocked and needs-human reports as finished. The plan and copied helper now change, and an actual copied tidy/cleanup cycle closes the done worker while preserving both idle decision workers.
  - premise: Ten edits suffice for the planned watcher cutover.
    verdict: wrong
    evidence: close-finished-agents.sh is now an eleventh mandatory edit, captured and restored with the original mode; broad workspace and agentless sweeps are removed so they cannot bypass that edit.
---

Rebased onto main before editing, including **Brief for ENG-87: every review yields a public copy**. Implemented in **Preserve protected workers in the executed scratch cutover**; this report and the final screens are committed as **Report protected cleanup and acceptance review fixes**. The independently supplied findings file remains in scratch and was not copied into the repository.

All four findings are addressed:

| Finding | Change and executed evidence |
| --- | --- |
| Copied cleanup could close blocked/needs-human workers. | The cutover now installs a new close-finished-agents.sh. Latest recorded run sequence determines eligibility; only done or an abandoned run without a report permits idle-tab closure. Open, unrecorded, unknown and decision workers remain. A protected agent protects its entire tab. Broad tidy workspace/watch-tab and agentless sweeps are removed. Case 18 invokes actual copied tidy without dry-run: its dispatched done canary closes, while real idle PTY workers with pre-ingested blocked and needs_human fixture reports remain. cutover-cleanup.json records successful before/after topology receipts; cutover-cleanup.txt records the actual tab close. |
| Recovery lost notices across multiple run logs. | Tidy retains a labelled bounded tail from every run. The actual copied script and offline regression both recover a late notice from an older log alongside a newer log containing 200/100 stale lines. Per-run tails are bounded independently. |
| Retirement ignored Python and exempted notify-watch. | Copier and scanner share recursive source enumeration for sh, mjs, py and other executable files. The scanner has no notify-watch exclusion and refuses symlinks. Case 19 plants an executable nested Python contrib caller, witnesses refusal with the blob intact, removes it, then retires only after zero callers and a delivered switched canary. Offline coverage also checks executable extensionless callers and active notify-watch. Timestamped historical backups are archived only when no active source references them, including transitive references through other backups; any referenced backup remains active. |
| Missing prerequisites became product failures. | Case 19 requires case 18's result, and the default-cycle case requires the supervisor fixture after checking candidate capabilities. Dependent cases retain the prior reason, status and origin. The no-Herdr/no-optional-copy run reports cases 18/19 pending for omitted bch-cloak and case 22 pending with the original harness limitation; no false product failures. Missing candidate modules still produce explicit product failures. |

The major check deliberately keeps all three workers idle/done so report outcomes, rather than a busy UI state, decide cleanup. In the authoritative main run, R-3 is recorded done and its tab/pane disappear; R-4 is recorded blocked and R-5 needs_human, both idle, and both tabs/panes remain. The two decision reports are trusted pre-ingested fixtures; they do not claim additional watch deliveries. The done canary separately witnesses actual copied dispatch/arm/watch delivery and ingestion. Case 12 independently continues to test released housekeeping. Eleven switched files restore exact bytes and modes, followed by the restored routing/wrapper checks and actual legacy notify canary on R-6.

The final commands use this lane's revised harness against product snapshots, with real sandboxed discovery on the declared gpt-5.6-luna low route:

```sh
node acceptance/run.mjs --candidate main --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
```

Main product snapshot at **Brief for ENG-87: every review yields a public copy**:

```text
Release acceptance: main (352s) — 23 pass / 0 fail / 0 pending — READY
PASS    01 Candidate snapshot
PASS    02 New project: record discovers and populates
PASS    03 New project: routes resolve without config
PASS    04 New project: installed supervisor entry and record bootstrap
PASS    05 Real Herdr boundary and configured fixture
PASS    06 Configured cycle: dispatch/report/ingest/promote/close
PASS    07 Failure path: missing worker
PASS    08 Failure path: invalid worker
PASS    09 Failure path: blocked worker
PASS    10 Fix round: same worker, fresh durable run
PASS    11 Watch cutover: idle grace and exclusive watcher
PASS    12 Housekeeping closes only eligible finished workers
PASS    13 Scratch release build/activate/rollback/restore
PASS    14 Full console dependency build (offline)
PASS    15 Existing project: copy live calls and inventory drift
PASS    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PASS    18 ENG-64: every file switch and rollback
PASS    19 ENG-64: final contrib removal and restoration
PASS    20 Real discovery: concurrent lanes and promotion
PASS    21 Real discovery: routing question waits and answer applies
PASS    22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-FPp4Xz/evidence (NN.jsonl; summary.json has reasons)
```

v0.1.3 product snapshot at **Add the console-fold review, round 2 (PASS)**, on the identical final harness:

```text
Release acceptance: v0.1.3 (117s) — 7 pass / 6 fail / 10 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
PENDING 03 New project: routes resolve without config
PENDING 04 New project: installed supervisor entry and record bootstrap
PASS    05 Real Herdr boundary and configured fixture
PENDING 06 Configured cycle: dispatch/report/ingest/promote/close
PENDING 07 Failure path: missing worker
PENDING 08 Failure path: invalid worker
PENDING 09 Failure path: blocked worker
PENDING 10 Fix round: same worker, fresh durable run
PENDING 11 Watch cutover: idle grace and exclusive watcher
PENDING 12 Housekeeping closes only eligible finished workers
PASS    13 Scratch release build/activate/rollback/restore
PASS    14 Full console dependency build (offline)
PASS    15 Existing project: copy live calls and inventory drift
PENDING 16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
FAIL    18 ENG-64: every file switch and rollback
FAIL    19 ENG-64: final contrib removal and restoration
FAIL    20 Real discovery: concurrent lanes and promotion
FAIL    21 Real discovery: routing question waits and answer applies
FAIL    22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-7jbClf/evidence (NN.jsonl; summary.json has reasons)
```

Main exits 0. v0.1.3 exits 1; cases 18/19 fail because the candidate lacks the split supervisor entry, and case 22 fails because dispatch is absent. Other absent capabilities remain pending. No harness limit hides the three required cases in either full run.

Before edits, npm test passed 410 tests with two explicit skips. After the final implementation, npm test again passed 410 with zero failures and two skips; all 38 offline native boundary tests passed. The generated cleanup regression covers done, blocked, needs_human, unrecorded report files, unknown state, abandonment, latest fix/regression rounds, mixed protected tabs, supervisor/foreign cwd protection and a failed record read. The last action after checking and committing this report is lane check. No lane implementation changed in this round; the earlier run's 146-test lane-suite result is not presented as a new round-two run.

Raw numbered commands, PTY transport, notices, source attribution, usage, ownership and cleanup evidence remain at:

- /private/tmp/herdr-acceptance-FPp4Xz/evidence — authoritative main, 352 seconds; cutover-switches.json contains ten passing subchecks, eleven exact restorations, actual cleanup and multi-log recovery receipts.
- /private/tmp/herdr-acceptance-7jbClf/evidence — authoritative v0.1.3, 117 seconds.
- /private/tmp/herdr-acceptance-2RKdvv/evidence — initial main, 346 seconds, 21/2/0. The first extra scripted blocked canary produced no report before timeout, and the broadened source scan included an unreferenced timestamped old backup. These findings led to the direct recorded cleanup fixtures and proven historical-archive handling; its failed screen is retained rather than presented as a pass.
- /private/tmp/herdr-acceptance-QjaEWy/evidence — initial v0.1.3 comparison, 7/6/10.
- /private/tmp/herdr-acceptance-8xVz1T/evidence — final omitted-copy/unavailable-supervisor classification check, 6/0/17; no Herdr session inspected and no model calls. Earlier check: /private/tmp/herdr-acceptance-1Rpcf4/evidence.
- /private/tmp/eng78-r2-final2-tests.log and /private/tmp/eng78-r2-boundary2-tests.log — final offline suites.

All four full runs report empty owned-workspace/cleanup-error lists, no credential residue and no retained discovery roots. No keep mode was used. No live bch-cloak repository, record or workspace, shared lane configuration, activated release, operator bin, launchd or unowned pane was changed. No housekeeping loop was started. contrib/settle-watch.mjs in this checkout remains unchanged; only the scratch candidate blob is retired and restored before restoring legacy callers. Model-written discovery code and Git verification retain the existing native confinement boundary.

Measured round-two discovery usage includes the initial and authoritative reruns:

| Run | Sessions | Input | Cached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial main | 4 | 555,005 | 460,800 | 9,838 | 842 |
| Initial v0.1.3 | 3 | 264,517 | 226,304 | 4,099 | 1,019 |
| Final main | 4 | 618,892 | 537,344 | 10,740 | 986 |
| Final v0.1.3 | 3 | 285,997 | 240,640 | 4,486 | 947 |
| Total | 14 | 1,724,411 | 1,465,088 | 29,163 | 3,794 |

All fourteen real sessions returned one complete measured turn and exit 0 on gpt-5.6-luna low. Mechanics/cleanup/default-cycle workers are scripts and call no model. Cached input is included in input; reasoning output is a reported subset of output. Cache-write input is zero. No billing estimate is inferred. Aggregate receipt: /private/tmp/eng78-r2-discovery-usage.json.
