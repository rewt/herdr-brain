---
run: R-63
outcome: done
summary: |
  Replaced acceptance cases 18, 19 and 22 with executable scratch checks. The default supervisor performs entry, record bootstrap, dispatch and ingestion in a real PTY with no workflow configuration. The cutover applies all ten edits, executes switched and restored legacy canaries, restores bytes and modes, and tests zero-caller contrib retirement. After rebasing onto the workspace identity fix, main passes all 23 cases with no failures or pending coverage. The same harness reports 7 passes, 6 failures and 10 pending cases for v0.1.3. All work and release changes remain scratch-only.
headline: Every release acceptance case now passes on main
blockers: []
proposals: []
learnings:
  - "Changing HOME for copied scripts also changes Herdr's default socket discovery; pin the original socket endpoint in the ownership ledger."
  - "Legacy shell and Node worktree constants must relocate to the same scratch HOME; legacy orgctx and prep temporary files need explicit relocation too."
  - "Legacy notify-watch logs after delivery, so await both the PTY receipt and log before checking rollback evidence."
  - "An unconfigured supervisor can bootstrap, dispatch on the suggested engineer route, receive a final notice, ingest, validate and promote without adopting project routing configuration."
  - "Background launcher identity must come from verified native Git/workspace lookup; display metadata may be absent for an idle copied project."
artifacts:
  - "Commit: Execute default supervisor and scratch cutover acceptance cases"
  - "Commit: Report executed default cycle and scratch cutover acceptance"
  - "acceptance/cutover.mjs; acceptance/run.mjs; acceptance/herdr.mjs; acceptance/security.mjs; acceptance/worker.mjs"
  - "acceptance/test/cutover.test.mjs; acceptance/test/boundary.test.mjs; watch/test/watch.test.mjs; test/open-session.test.mjs"
  - "docs/reports/ENG-78-acceptance-evidence-20261001/main/screen.txt and summary.json"
  - "docs/reports/ENG-78-acceptance-evidence-20261001/v0.1.3/screen.txt and summary.json"
  - "npm test: 410 passed, zero failed, two skips; npm run test:lanes: 146 passed; acceptance boundary suite: 33 passed"
decisions:
  - decision: Test the default cycle through a scripted supervisor in a real PTY.
    why: Its product entry, dispatch, notice consumption and record check/ingest execute in the supervisor process. An ordinary package test script is the only project setup; routing and housekeeping configuration are absent.
  - decision: Bind legacy workspace and supervisor constants to opaque scratch creation receipts before switching or restoring scripts.
    why: Both directions must execute without addressing a live supervisor. Raw original bytes remain separately checksummed; executed relocated baselines restore exactly.
  - decision: Preserve the compatibility file in this checkout and retire only the candidate snapshot after zero callers and a delivered switched canary.
    why: bch-cloak's release-gated switch is still outstanding. The scratch removal and restoration establish the planned sequence without changing live callers or releases.
questions: []
challenges:
  - premise: The cutover cases must remain pending until bch-cloak itself has switched.
    verdict: wrong
    evidence: The ten edits, canaries, rollback and final compatibility retirement can execute on audited scratch copies. Main now produces product outcomes instead of a permanent coverage gap.
  - premise: A supervisor entry or configured-cycle pass establishes unconfigured default dispatch and ingestion.
    verdict: wrong
    evidence: Case 22 uses a separate untouched project and actual PTY supervisor CLI calls, with a final durable ingestion receipt and default validation/promotion.
---

Implemented in **Execute default supervisor and scratch cutover acceptance cases**. The lane was rebased onto main after **Add the category-discernment review, round 1 (PASS)** and **Add the workspace-identity review, round 1 (PASS)** landed. The latter integrates **Resolve background supervisor workspaces through native Git identity** and removes the earlier cases 16/18 product failures. The report commit is **Report executed default cycle and scratch cutover acceptance**. No push or publication was performed.

Main, captured at **Add the workspace-identity review, round 1 (PASS)**:

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
Evidence: /private/tmp/herdr-acceptance-iqAiaW/evidence (NN.jsonl; summary.json has reasons)
```

v0.1.3, captured at **Add the console-fold review, round 2 (PASS)**, using the same final harness:

```text
Release acceptance: v0.1.3 (137s) — 7 pass / 6 fail / 10 pending — NOT READY
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
Evidence: /private/tmp/herdr-acceptance-T4I8G9/evidence (NN.jsonl; summary.json has reasons)
```

Main exits 0 and is READY with no pending case. The older release exits 1: case 18 lacks `supervisor/open-session.mjs`, case 19 cannot establish the split cutover, and case 22 lacks `dispatch/dispatch.mjs`. Its ten pending cases concern other absent modules, including case 16's new supervisor entry. Cases 18, 19 and 22 now produce explicit product outcomes for both candidates. A green scratch gate provides evidence for the supervisor's release decision; this run performs no live switch.

Case 18 applies all ten proposed file edits to audited copied scripts. Naming/startup and a missing-target preflight execute against owned panes; the preflight must leave the scratch event log unchanged. The actual copied routing suite and executive wrapper execute. A controlled busy executive triggers immediate refusal with no new tab, then the same request is retried after a real Herdr wait. The copied dispatch and legacy lane/routing code launch a scripted worker through the switched arm wrapper. A held working worker allows a second arm attempt to prove exclusive watcher ownership before releasing it to deliver exactly one final notice. The actual tidy dry run reads that canary from the new per-run log. Released notice constructors supplement real missing/invalid/blocked delivery and idle-grace checks in cases 07–11; prose assertions establish the tracked protocol contract, not an agent's interpretation of it.

Rollback restores all ten relocated baselines byte-for-byte and with their original executable modes. Restored routing tests and both wrapper dry runs execute, followed by a new run through the restored copied dispatch and actual legacy notify-watch. Its legacy notice and log are witnessed and its report is ingested. The two canaries use different runs; the harness never adds two watcher implementations to one run. Original live bytes/checksums/modes are separately retained in the raw manifest. The ordinary application's build is outside this watcher switch: an empty trusted lane is prebuilt before executing the unchanged copied lane dispatch.

All nine case 18 subchecks pass on the final main. The native Git workspace identity fix allows both routed wrapper execution and the positive same-request retry to complete. Naming, switched dispatch/delivery, duplicate refusal, tidy recovery, notice contract, zero-caller notify retirement, exact rollback, restored wrapper tests and the real restored legacy canary all execute successfully. Earlier full runs retained the identity failure rather than bypassing it; rebasing onto the independently landed fix resolves it. No follow-on item is required.

Case 19 plants an extra executable contrib caller and proves removal refuses while preserving the blob. After removing the probe, both caller trees must have zero contrib callers and the switched canary must have delivered. The candidate snapshot's contrib file is then removed, the split routing suite executes without it, and the exact blob/mode is restored before restoring legacy callers. This checkout's `contrib/settle-watch.mjs` is unchanged.

Case 22 starts with no `.org`, `.lane.json`, `.housekeeping.json` or agent instructions. The real PTY supervisor invokes product supervisor entry, creates the item, and dispatches on the discovered suggested engineer route. Its worker is a script rather than a model. After watch delivers the final notice, that same supervisor process invokes record check and ingest and writes its durable receipt. The harness independently witnesses one final notice and a recorded done outcome, then executes default `npm test`, fast-forward promotion and lane closure. Project configuration remains absent. The scratch HOME and owned delivery target isolate machine paths and topology; they do not supply workflow policy.

All copied invocations retain the independent kernel write/read boundary, audited path relocation and pinned scratch record. The native socket is pinned before HOME changes. Worktree path constants agree between shell and Node; legacy fixed temporary files remain scratch-local. Tidy propagates dry-run to its cleanup helper. The naming canary excludes starting the project-wide janitor loop; the actual one-pass released housekeeping case still executes against promoted done, blocked and needs-human workers. Model-written discovery code and Git operations remain under the existing native verification sandbox. Notifications are recorded as scratch evidence, with no host notification UI. Legacy detached watcher PIDs come from the scratch nohup adapter's own creation receipt, not process-name discovery.

The offline baseline was started before edits but stalled when overloaded watcher fixtures failed before their cleanup. Only its verified process tree in this worktree was stopped. One automatic approval attempt to stop it was rejected because its root PID was not sufficiently established; read-only cwd/process evidence established ownership and the scoped retry succeeded. Fixture children now run in owned process groups with cleanup after failed assertions. Bounded fixture waits increased to ten seconds; the busy-launch regression still requires refusal without creating a session. After the final rebase, the implementation suite passed 410 tests with two explicit skips and the native acceptance boundary suite passed all 33. The lane suite passed all 146; no lane implementation changed in this run. An initial boundary invocation inside the outer workspace sandbox correctly failed its scratch socket/kernel-sandbox prerequisites; the native rerun passed. Final lane validation is the last action after checking and committing this report.

The authoritative commands were:

```sh
node acceptance/run.mjs --candidate main --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
```

Only the two screens and summaries per candidate are tracked. Raw numbered commands, PTY receipts, switch/rollback checks, watch and legacy logs, tidy output, policy and ingestion receipts, source attribution, discovery transcripts, usage, ownership and cleanup remain under:

- `/private/tmp/herdr-acceptance-iqAiaW/evidence` — authoritative current main after the workspace identity rebase, 352 seconds, 23/0/0.
- `/private/tmp/herdr-acceptance-T4I8G9/evidence` — authoritative v0.1.3 on the same final harness, 137 seconds, 7/6/10.
- `/private/tmp/herdr-acceptance-iR8Ecy/evidence` — earlier category main, 304 seconds, 21/2/0; cases 16/18 exposed the workspace identity gap.
- `/private/tmp/herdr-acceptance-5eFVm7/evidence` — earlier v0.1.3, 103 seconds, 7/7/9; before the workspace identity case 16 update.
- `/private/tmp/herdr-acceptance-a2EuUy/evidence` — complete final-harness main before category changes landed, 316 seconds; same 21/2/0 screen and actual PTY supervisor ingestion.
- `/private/tmp/herdr-acceptance-yfRULe/evidence` — initial full main, 333 seconds; exposed the legacy log-after-delivery race, repaired before the authoritative reruns.
- `/private/tmp/herdr-acceptance-{7YZODr,tT0ggL,fKWtJ0,8tROUl,P2oXTA}/evidence` — mechanics-only development experiments; no model calls. These exposed the socket, temporary-file, worktree, multiline-brief and topology-binding fixture issues corrected in the final harness.

All completed full runs and development attempts report successful owned-workspace cleanup, empty credential residue and no retained discovery/session roots. No keep mode was used. No live bch-cloak repository/record/workspace, shared lane configuration, activated release, operator bin, launchd or unowned pane was changed. No housekeeping schedule was started.

All twenty-two real sessions used the declared `gpt-5.6-luna` low route and returned one measured complete turn with exit 0. Mechanics, default-supervisor and rollback workers were scripts and made no model calls. Measured usage, including developmental full runs:

| Run | Sessions | Input | Cached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial full main | 4 | 694,968 | 603,392 | 11,593 | 1,115 |
| Final harness, earlier main | 4 | 708,222 | 616,960 | 10,997 | 1,112 |
| Category main | 4 | 566,842 | 497,152 | 11,161 | 907 |
| Earlier v0.1.3 | 3 | 230,657 | 186,368 | 3,707 | 778 |
| Current main after identity rebase | 4 | 648,661 | 470,784 | 11,664 | 1,232 |
| Final v0.1.3 | 3 | 399,611 | 322,816 | 5,131 | 994 |
| Total | 22 | 3,248,961 | 2,697,472 | 54,253 | 6,138 |

Cached input is included in input; reasoning is a reported output subset. Cache-write input was zero. No billing estimate is inferred. The aggregate is `/private/tmp/eng78-all-discovery-usage.json`, with per-session receipts in each raw evidence directory.
