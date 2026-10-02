---
run: R-77
outcome: done
summary: |
  Fixed both round-three review findings with regression tests. Recognized timestamped script backups are now enumerated regardless of execute bit, retained through active references and scanned before retirement. Busy refusal and retry now inspect the copied launcher's actual destination, native creation receipts, live topology, registered executive and received PTY prompt; leaking refusals and exit-zero no-op retries fail. Rebased onto main again when the priorities changes landed, preserving both sides of two test conflicts. The final main acceptance gate passes all 24 cases, the rebased npm suite passes 465 tests with four explicit skips, and all 51 acceptance boundary tests pass. The installed copied cleanup still preserves blocked and needs_human workers.
headline: Acceptance now proves readable callers and one prompted retry session
blockers: []
proposals: []
learnings:
  - "An interpreter can invoke a mode-0644 timestamped script backup. Source enumeration must include recognized backup names before resolving active references."
  - "A refused launch can leak a tab outside the configured fixture. Inspect the canonical existing-project destination and creation receipts, including creations subsequently closed."
  - "An exit-zero retry proves no session behavior by itself. Require one new destination tab and pane, one registered executive and one matching received prompt."
  - "Native JSON creation replies have one result envelope. A helper that already unwraps it must not be followed by another result lookup."
artifacts:
  - "Commit: Retain readable backups and verify copied launch receipts"
  - "Commit: Report readable backup and exact launch acceptance proof"
  - "acceptance/cutover.mjs; acceptance/launch.mjs; acceptance/run.mjs; acceptance/README.md"
  - "acceptance/test/cutover.test.mjs; acceptance/test/launch.test.mjs"
  - "docs/reports/ENG-78-acceptance-evidence-r4-20261001/main/{summary.json,screen.txt}"
  - "docs/reviews/acceptance-completion/0c04123-r3.md: already-provided public review, preserved unchanged"
  - "npm test: 465 passed, zero failed, four explicit skips; offline acceptance boundary suite: 51 passed, zero skipped"
decisions:
  - text: Enumerate readable timestamped script variants before resolving their active references.
    category: design
    why: Interpreters can run mode-0644 files. The copier and retirement guard must retain referenced sources independently of their execute bit.
  - text: Verify busy refusal and retry through the actual destination, native topology and received prompt receipts.
    category: prover
    why: The configured fixture and copied launcher destination are different. Native creation history catches transient leaks, and a registered executive with one matching PTY input proves the successful retry did work.
  - text: Preserve main's test actors alongside the lane's timeout and child-process cleanup protections during rebase.
    category: tooling
    why: The priorities changes overlapped earlier lane test changes. Both actor identity and deterministic cleanup must survive the merge.
questions: []
challenges:
  - premise: Timestamped script variants without an execute bit cannot be active callers.
    verdict: wrong
    evidence: A wrapper invoking python3 can reach a readable backup and its compatibility call. Offline coverage and the final native retirement probe both refuse removal for referenced mode-0644 sources.
  - premise: An unchanged configured-workspace tab count and an exit-zero retry establish launch behavior.
    verdict: wrong
    evidence: The final native resolver selects w1NW for the existing project while the configured fixture is w1NJ. A leaking-refusal control and a successful no-op retry both fail the production verifier; the actual retry creates one registered and prompted executive in w1NW.
---

Both findings are fixed in **Retain readable backups and verify copied launch receipts**. This report and the final screen are committed as **Report readable backup and exact launch acceptance proof**. The private scratch findings were read in place and not copied. The public review file already existed untracked when this run began and is included unchanged.

The initial rebase was up to date. Main then advanced during the final rerun; rebased again onto **Briefs for ENG-80 (with ENG-76), ENG-81, ENG-75 and ARCH-14**, including **Fix priority proposal ingestion, review scrolling and test actors**. Resolved test conflicts by combining main's actor environment with the lane's ten-second refusal-test bound and detached watcher cleanup. No lifecycle protection was discarded.

| Finding | Implementation and regression proof |
| --- | --- |
| Non-executable backups were dropped before reference analysis. | One shared recognized-backup pattern admits timestamped sh/mjs/py files regardless of mode in callerFiles and callerInventory. The copier retains active sources with their original modes; only proven unreferenced backups become historical. The new mode-0644 regression covers a wrapper -> Python backup -> JavaScript backup chain, unreferenced shell backup classification, the readable Python backup's own compatibility call, refusal and blob preservation. The full native contrib-retirement case now plants an executable wrapper invoking a mode-0644 Python backup, checks active inventory, witnesses refusal, removes the probe, and then executes zero-caller retirement and exact restoration. |
| Busy-retry observed a different workspace and accepted a no-op. | Native worktree lookup resolves the canonical copied project and must match its workspace creation receipt. Refusal checks exact destination tab/pane identities, no successful creation receipts anywhere in the owned fixture and no new received prompt. Retry requires exactly one native tab creation in that destination, exactly one new tab/pane in live topology, one registered executive, and one received prompt attributed to that same pane/name with the continue protocol. The production verifier regressions reject a leaking refusal while the configured workspace stays unchanged, a leak subsequently closed, an exit-zero no-op, multiple sessions, missing registration/prompt, wrong destination and wrong prompt attribution. Native envelope parsing has its own regression. |

The final native busy-retry receipt is /private/tmp/herdr-acceptance-4MO8LS/evidence/cutover-busy-retry.json. It records the resolver, original configured workspace, before/after topology, cumulative successful creation receipts, agent lists, received inputs and command replies. All handles below come from those receipts.

| Stage | Destination tabs | Destination panes | Successful creations | Received worker inputs |
| --- | ---: | ---: | ---: | ---: |
| Before refusal | 1 | 1 | 22 | 12 |
| After refusal | 1 | 1 | 22 | 12 |
| Before retry, after idle/wait | 1 | 1 | 22 | 12 |
| After retry | 2 | 2 | 23 | 13 |

The launcher destination is w1NW; the configured supervisor fixture is w1NJ. Retry creates w1NW:t2 and w1NW:p2, registers exec-0056 and delivers one matching orchestrator prompt containing Mode: continue and the pinned scratch ORG_DIR. The fixture runs a scripted worker in a real PTY and calls no model; this establishes actual creation and prompt transport, not Codex/Claude interactive recognition. The native tests remain constrained by the ownership adapter and copied-script kernel sandbox.

All ten keyed cutover subchecks pass; all eleven file bytes/modes restore exactly. The installed copied tidy/cleanup path executes with mutations and closes recorded done while retaining idle blocked and needs_human report workers. The delivered switched and restored legacy canaries, multi-log tidy recovery, independent released housekeeping, zero-caller retirement and unconfigured default supervisor cycle continue to pass.

The authoritative command uses this lane's revised harness and the frozen product snapshot at **Briefs for ENG-80 (with ENG-76), ENG-81, ENG-75 and ARCH-14**:

```sh
node acceptance/run.mjs --candidate main --bch-cloak /Users/rewt/development/bastian/bch-cloak --npm-cache /Users/rewt/.npm
```

Final main screen, exit 0:

```text
Release acceptance: main (399s) — 24 pass / 0 fail / 0 pending — READY
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
Evidence: /private/tmp/herdr-acceptance-4MO8LS/evidence (NN.jsonl; summary.json has reasons)
```

Round four requested a main rerun. v0.1.3 was not rerun in this round. Its prior comparison, from **Report stable acceptance dependencies and round-three evidence** (R-75), is retained here as inherited evidence only:

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

Before editing, npm test passed 456 tests with four explicit skips on the initial main base. The corrected implementation also passed 456 with four skips before the second rebase. After rebasing, the final plain npm test passes 465 with zero failures and four skips (469 total). All 51 offline acceptance boundary tests pass after rebase, with zero failures/skips. Seven new acceptance tests cover this round's findings and the native-envelope correction. No new separate lane-suite run is claimed. Record check precedes the report commit; lane check is the last action and retains its result in the lane gate receipt.

The first full attempt, /private/tmp/herdr-acceptance-BmtkgL/evidence, reports 22 pass / 2 fail / 0 pending in 332 seconds. The stronger verifier observed the actual new session and received prompt, but my initial host parser unwrapped result twice and discarded the native creation payload. This implementation mistake failed busy-retry and its dependent retirement; it is not evidence of a candidate product regression. Fixed it before the implementation commit and added the native-envelope regression. The final run above is the authoritative result.

Two earlier npm attempts also remain in scratch: the first post-change run encountered empty JSON receipt reads in two existing discovery lifecycle tests; their isolated seven-test recheck passed. The first rebased npm run, concurrent with native boundary and acceptance work, hit three short timeouts in housekeeping, brain-start and watch. The final plain npm run after acceptance cleanup passed. Those failed attempts are retained and are not substituted with inherited passes.

Raw evidence and logs:

- /private/tmp/herdr-acceptance-4MO8LS/evidence — authoritative main, 399 seconds; cutover-busy-retry.json, keyed subchecks, copied cleanup, exact restorations, retirement refusal commands, model source attribution, permissions and usage.
- /private/tmp/herdr-acceptance-BmtkgL/evidence — initial failed attempt, 332 seconds; actual topology/prompt receipts and the corrected parser mistake.
- /private/tmp/eng78-r4-baseline-tests.log — baseline npm test.
- /private/tmp/eng78-r4-final-tests.log; /private/tmp/eng78-r4-lifecycle-recheck.log; /private/tmp/eng78-r4-final2-tests.log; /private/tmp/eng78-r4-final3-tests.log — initial failure, isolated lifecycle recheck and corrected pre-rebase passes.
- /private/tmp/eng78-r4-rebased-tests.log; /private/tmp/eng78-r4-rebased-final-tests.log — concurrent timeout attempt and final rebased npm pass.
- /private/tmp/eng78-r4-boundary2-tests.log; /private/tmp/eng78-r4-rebased-boundary-tests.log — final 51-test boundary passes before/after rebase.

Only the authoritative main summary.json and screen.txt are newly tracked. Both full attempts report empty owned-workspace and cleanup-error lists, no credential residue and no retained discovery roots. No keep mode was used. The existing native confinement and ownership protections remain; model-written code and Git verification never run unsandboxed. The checkout's contrib/settle-watch.mjs is unchanged. No live bch-cloak repository, record or workspace, shared lane configuration, activated release, operator bin, launchd or unowned pane was changed. No project-wide housekeeping loop or live cutover was started, and no lane was promoted or pushed.

Measured discovery usage includes both attempts on the declared gpt-5.6-luna low route:

| Attempt | Sessions | Input | Cached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial main | 4 | 480,589 | 395,520 | 9,821 | 1,010 |
| Final main | 4 | 556,144 | 434,944 | 11,552 | 1,019 |
| Total | 8 | 1,036,733 | 830,464 | 21,373 | 2,029 |

All eight real sessions returned one complete measured turn and exit 0. Cached input is included in input; reasoning output is a reported subset of output. Cache-write input is zero. No billing estimate is inferred. Aggregate receipt: /private/tmp/eng78-r4-discovery-usage.json. Mechanics, copied executive/worker sessions, cleanup and default-cycle workers are scripts and call no model.
