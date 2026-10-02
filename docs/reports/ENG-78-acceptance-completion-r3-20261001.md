---
run: R-75
outcome: done
summary: |
  Fixed all three round-two review findings after rebasing onto current main. Acceptance cases and cutover subchecks now have stable keys and keyed prerequisites; inserting unrelated cases cannot redirect dependencies. Canary harness limitations propagate through recovery, copied cleanup and retirement without manufactured product failures. The retirement and backup-reference scanners retain executable shell case arms. Main passes all 24 cases; v0.1.3 reports 7 passes, 6 product failures and 11 pending cases on the same harness. The installed copied cleanup still closes only the recorded done worker and preserves blocked and needs_human workers.
headline: Acceptance dependencies now survive inserted cases and preserve failure causes
blockers: []
proposals: []
learnings:
  - "Case ordinals and numbered evidence files are presentation; prerequisites must resolve stable case keys. A merge that inserts a case must not change any dependency."
  - "Dependent checks must retain a canary's status, origin and cause before touching its receipt; an absent receipt after a harness limit is not another product failure."
  - "Asterisk-leading shell case arms execute commands and must remain visible to both zero-caller retirement and backup reachability scans."
  - "Concurrent copied executive wrappers can collide on their minute-based agent names; retain the harness limitation and rerun the affected scratch fixture alone."
artifacts:
  - "Commit: Use stable acceptance keys and preserve canary failure causes"
  - "Commit: Report stable acceptance dependencies and round-three evidence"
  - "acceptance/cases.mjs; acceptance/limits.mjs; acceptance/run.mjs; acceptance/live.mjs; acceptance/cutover.mjs; acceptance/README.md"
  - "acceptance/test/cases.test.mjs; acceptance/test/results.test.mjs; acceptance/test/cutover.test.mjs"
  - "docs/reports/ENG-78-acceptance-evidence-r3-20261001/{main,v0.1.3}/{summary.json,screen.txt}"
  - "docs/reviews/acceptance-completion/c85f18f-r2.md: already-provided public review, preserved unchanged"
  - "npm test before and after: 456 passed, zero failed, four explicit skips; acceptance boundary suite: 44 passed, zero skipped"
decisions:
  - text: Give every acceptance case and cutover subcheck a permanent identifier and declare dependencies in the production case catalog.
    category: design
    why: The merged promotion-queue case shifted ordinals and redirected copy and retirement guards. Only case identifiers determine prerequisites; ordinals remain display and evidence filenames.
  - text: Gate tidy recovery and copied cleanup on the switched-canary result and preserve its classification through the aggregate and retirement.
    category: design
    why: A native transport limitation must remain harness PENDING and keep the original cause. Independent genuine product and safety failures still take precedence.
  - text: Conservatively retain asterisk-leading source lines in both caller and backup-reference scans.
    category: design
    why: Shell case arms can execute compatibility calls or referenced backups. Conservatism prevents retirement from relying on an incomplete zero-caller claim.
  - text: Repeat the omitted-cache integration alone after a concurrent executive name collision.
    category: prover
    why: The first attempt correctly stayed harness PENDING; a fresh isolated fixture can establish whether console cache omission blocks actual copied cutover execution.
questions: []
challenges:
  - premise: Acceptance case numbers can safely identify prerequisites across merges.
    verdict: wrong
    evidence: The promotion-queue insertion moved console, copy, org PATH, switches and retirement. The insertion regression now covers every position in the actual merged catalog, while native omission controls verify the current runner.
  - premise: A missing canary receipt after a transport limitation establishes a product failure in dependent cleanup.
    verdict: wrong
    evidence: The shared production executor skips dependent bodies and preserves the canary limitation through recovery, cleanup, aggregate and final retirement; an incorrect product canary still fails.
---

Rebased onto main first, including **Brief for ENG-89: priorities the operator owns and agents serve** and **Make unchanged route saves inert and show launch-resolved effort**. Implemented in **Use stable acceptance keys and preserve canary failure causes**. This report and the final screens are committed as **Report stable acceptance dependencies and round-three evidence**. The private scratch findings were read in place and not copied. The separate public review file already existed untracked when this run began and is included unchanged with the report.

All three findings are fixed:

| Finding | Fix and proof |
| --- | --- |
| Insertion redirected numeric prerequisites. | `acceptance/cases.mjs` defines stable keys for every top-level case and cutover subcheck. The runner and discovery use these definitions; copy dependents require `existing-copy`, retirement requires `cutover-switches`, and fixture dependents require `herdr-fixture`. Summary rows retain keys. The production executor regression inserts an unrelated case at every position across four fault scenarios (100 insertions), comparing all keyed outcomes, prerequisite identities and executed bodies. Optional console never gates copy or cutover; failed switches prevent retirement even when `org-path` passed. |
| Canary harness PENDING became dependent product FAIL. | `tidy-recovery` and `copied-cleanup` require `switched-canary` before touching its receipt. The shared production executor and aggregate regression inject a native transport/layout HarnessLimit and verify pending status, harness origin, original cause and skipped recovery/cleanup/retirement bodies. Separate incorrect-product-canary and independent safety-failure controls retain FAIL precedence. |
| Shell case arms escaped the caller and backup scans. | Both scans retain asterisk-leading lines. The regression plants `*) node "$CURRENT/contrib/settle-watch.mjs"`; retirement refuses and preserves the blob. A second arm invokes a timestamped Python backup; it remains active rather than historical and also prevents retirement. |

The full main run executes all ten keyed cutover subchecks and restores eleven files with exact bytes and modes. `copied-cleanup` runs the installed copied tidy -> close-finished-agents path with mutations: R-3 recorded done loses its tab/pane; R-4 recorded blocked and R-5 recorded needs_human remain idle with their tabs/panes intact. This is independent of released `housekeeping`. `contrib-retirement` still witnesses a planted-caller refusal, zero-caller removal, split routing tests without contrib, exact compatibility restoration, and legacy caller restoration. `default-cycle` still executes the unconfigured supervisor bootstrap, dispatch, watch delivery, CLI check/ingest, default validation and fast-forward.

The authoritative commands use this lane's committed harness against frozen product snapshots, with confined real discovery on the declared gpt-5.6-luna low route:

```sh
node acceptance/run.mjs --candidate main --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
```

Main product snapshot at **Brief for ENG-89: priorities the operator owns and agents serve** (exit 0):

```text
Release acceptance: main (317s) — 24 pass / 0 fail / 0 pending — READY
PASS    01 Candidate snapshot
PASS    02 New project: record discovers and populates
PASS    03 New project: routes resolve without config
PASS    04 New project: installed supervisor entry and record bootstrap
PASS    05 Real Herdr boundary and configured fixture
PASS    06 Configured cycle: dispatch/report/ingest/promote/close
PASS    07 Unconfigured promotion queue: FIFO, notices and refusal
PASS    08 Failure path: missing worker
PASS    09 Failure path: invalid worker
PASS    10 Failure path: blocked worker
PASS    11 Fix round: same worker, fresh durable run
PASS    12 Watch cutover: idle grace and exclusive watcher
PASS    13 Housekeeping closes only eligible finished workers
PASS    14 Scratch release build/activate/rollback/restore
PASS    15 Full console dependency build (offline)
PASS    16 Existing project: copy live calls and inventory drift
PASS    17 Existing project: routing and both wrapper dry runs
PASS    18 Existing project: org PATH consumers
PASS    19 ENG-64: every file switch and rollback
PASS    20 ENG-64: final contrib removal and restoration
PASS    21 Real discovery: concurrent lanes and promotion
PASS    22 Real discovery: routing question waits and answer applies
PASS    23 New project: default supervisor dispatch/watch/ingest cycle
PASS    24 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-FDyX9w/evidence (NN.jsonl; summary.json has reasons)
```

v0.1.3 product snapshot at **Add the console-fold review, round 2 (PASS)** (exit 1):

```text
Release acceptance: v0.1.3 (117s) — 7 pass / 6 fail / 11 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
PENDING 03 New project: routes resolve without config
PENDING 04 New project: installed supervisor entry and record bootstrap
PASS    05 Real Herdr boundary and configured fixture
PENDING 06 Configured cycle: dispatch/report/ingest/promote/close
PENDING 07 Unconfigured promotion queue: FIFO, notices and refusal
PENDING 08 Failure path: missing worker
PENDING 09 Failure path: invalid worker
PENDING 10 Failure path: blocked worker
PENDING 11 Fix round: same worker, fresh durable run
PENDING 12 Watch cutover: idle grace and exclusive watcher
PENDING 13 Housekeeping closes only eligible finished workers
PASS    14 Scratch release build/activate/rollback/restore
PASS    15 Full console dependency build (offline)
PASS    16 Existing project: copy live calls and inventory drift
PENDING 17 Existing project: routing and both wrapper dry runs
PASS    18 Existing project: org PATH consumers
FAIL    19 ENG-64: every file switch and rollback
FAIL    20 ENG-64: final contrib removal and restoration
FAIL    21 Real discovery: concurrent lanes and promotion
FAIL    22 Real discovery: routing question waits and answer applies
FAIL    23 New project: default supervisor dispatch/watch/ingest cycle
PASS    24 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-Xt3Nvi/evidence (NN.jsonl; summary.json has reasons)
```

The six old-release failures are product evidence: zero-setup record discovery is missing; `cutover-switches` lacks the split supervisor entry; `contrib-retirement` inherits that failed switch; both real discovery cases lack witnessed product policy sources; `default-cycle` lacks dispatch. The added `promotion-queue` case is pending because the old candidate lacks that module. No harness limitation hides the required cutover/retirement/default-cycle results in either authoritative run.

Native regression controls, all using the current 24-case ordering:

| Control | Result | Relevant behavior |
| --- | --- | --- |
| No Herdr environment; no optional copy/cache; live skipped | 6 pass / 0 fail / 18 pending | Fixture-dependent cases preserve the original harness cause. No session inspected and no models called. |
| Real fixture; optional copy/cache omitted; live skipped | 16 pass / 0 fail / 8 pending | `existing-copy`, its consumers, `cutover-switches` and `contrib-retirement` remain pending with the omitted-copy cause. |
| Real fixture and copies; cache omitted; live skipped, isolated final run | 21 pass / 0 fail / 3 pending | `console-build` is pending; `existing-copy`, `cutover-switches` and `contrib-retirement` execute and pass. Only console and the two deliberately skipped discovery cases remain pending. |

The first no-cache attempt ran concurrently with main and reported 19 pass / 0 fail / 5 pending. Its actual copied canary, recovery, protected cleanup and rollback passed, but `busy-retry` collided on executive name exec-0021 with the other owned acceptance fixture. Native refusal remained harness PENDING and retirement correctly inherited it. No foreign target was mutated to clear the collision. The final isolated rerun above establishes the no-cache regression; neither skip-live control approves a release.

Before editing, npm test passed 456 tests with four explicit skips. After the implementation, npm test again passed 456 with no failures and four skips; all 44 offline acceptance boundary tests passed without skips. Logs: /private/tmp/eng78-r3-baseline-tests.log, /private/tmp/eng78-r3-final-tests.log, /private/tmp/eng78-r3-boundary-tests.log. No lane implementation changed; a new separate lane-suite run is not claimed. This report is checked with the record CLI before committing; lane check is the last action, with its result retained in the lane gate receipt.

Raw evidence (only summary.json and screen.txt from the authoritative full runs are tracked):

- /private/tmp/herdr-acceptance-FDyX9w/evidence — main, 317 seconds; ten keyed passing cutover subchecks, eleven exact restorations, cutover-cleanup.json and actual copied tidy output, discovery attribution/permission probes and usage.
- /private/tmp/herdr-acceptance-Xt3Nvi/evidence — v0.1.3, 117 seconds.
- /private/tmp/herdr-acceptance-iLpQti/evidence — final isolated no-cache integration; no model calls.
- /private/tmp/herdr-acceptance-TpZ8lR/evidence — initial concurrent no-cache control and preserved name-collision limitation; no model calls.
- /private/tmp/herdr-acceptance-wOBOmM/evidence — real-fixture omitted-copy control; no model calls.
- /private/tmp/herdr-acceptance-2gtfwt/evidence — unavailable-fixture control; no model calls.

Every native run reports empty owned-workspace and cleanup-error lists, no credential residue and no retained discovery roots. The unavailable-fixture control creates no workspace ledger. No keep mode was used. All existing confinement, ownership and cleanup protections remain; no model-written discovery code or Git verification runs unsandboxed. The checkout's contrib/settle-watch.mjs is unchanged. No live bch-cloak repository, record or workspace, shared lane config, activated release, operator bin, launchd or unowned pane was changed. No project-wide housekeeping loop was started, and no release or lane promotion was performed.

Measured discovery usage for this round:

| Candidate | Sessions | Input | Cached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main | 4 | 591,270 | 504,320 | 10,627 | 1,073 |
| v0.1.3 | 3 | 270,631 | 211,200 | 4,519 | 997 |
| Total | 7 | 861,901 | 715,520 | 15,146 | 2,070 |

All seven sessions returned one complete measured turn and exit 0 on gpt-5.6-luna low. Cached input is included in input; reasoning output is a reported subset of output. Cache-write input is zero. No billing estimate is inferred. Aggregate receipt: /private/tmp/eng78-r3-discovery-usage.json. Mechanics, omission controls, cleanup and default-cycle workers are scripts and call no model.
