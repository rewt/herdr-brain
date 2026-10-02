---
run: R-56
outcome: blocked
summary: |
  Fixed both round-four review findings. Explicit capability refusals alone carry the safety marker; native Herdr failures, stand-in registration and PTY acknowledgement timeouts, missing receipts and cleanup errors remain harness errors, with regressions for each class. Reran main, v0.1.3 and the captured current discovery head. Discovery was promoted and its lane ref removed during the run, so its captured commit was selected by subject; both it and main are 19 pass / 1 fail / 3 pending and pass both real discovery cases. v0.1.3 is 7 / 4 / 12. The default supervisor cycle, cutover coverage and background workspace identity still keep acceptance blocked. Only summary/screen pairs are tracked; raw evidence and all measured token costs remain in scratch.
headline: Discovery now passes on main, but release acceptance remains blocked
blockers:
  - "Case 22 does not execute the unconfigured default supervisor dispatch/watch/ingest cycle and stays PENDING. The passing entry/bootstrap and configured-cycle cases cannot satisfy it. Existing follow-up: ENG-78."
  - "Case 16 still lacks canonical background workspace identity after exact shell cwd readiness and a bounded 15-second poll. Main and the captured discovery head have metadata in every active configured comparison sample and none for their idle copied-project workspace. Existing follow-up: ENG-79."
  - "Cases 18 and 19 still lack behavioral execution of every cutover switch and safe final contrib retirement. Existing follow-up: ENG-78. The older release additionally lacks fresh-project discovery and newer cycle modules."
proposals: []
learnings:
  - "Use an explicit capability-refusal error type in the adapter. Generic native errors, malformed receipts, filesystem failures and stand-in timeouts must never acquire a product safety marker through a catch-all."
  - "Wrap both non-zero native replies consumed by body() and directly forwarded non-zero replies as harness errors. Regressions cover pane get, agent get, pane run, send-text, send-keys and cleanup workspace close."
  - "A missing live cwd receipt is a harness limit; a confirmed foreign workspace or cwd outside scratch is a capability refusal. Neither may authorize a late pane without its live ownership proof."
  - "Cleanup wrapping preserves actual capability-refusal markers as product FAIL, while ordinary close errors remain HARNESS. Ordinary missing product entry or source-attribution gaps remain product FAIL without a safety marker."
  - "A development lane ref may disappear after promotion. Record-confinement regression fixtures now archive this lane's committed CLI at HEAD, and use fresh other-category defaults to prove the question awaits a human without requiring a newer branch-only wait flag."
  - "The captured discovery head was promoted to main during this run. Main and the separate discovery-head rerun therefore tested the same committed subject with independent projects and real sessions; the failed vanished-ref snapshot made no model call."
artifacts:
  - "Commit: Distinguish capability refusals from acceptance harness failures"
  - "Commit: Report corrected acceptance attribution and all three candidates"
  - acceptance/herdr.mjs
  - acceptance/live.mjs
  - acceptance/native-transport.mjs
  - acceptance/test/boundary.test.mjs
  - acceptance/test/results.test.mjs
  - acceptance/test/verification.test.mjs
  - acceptance/README.md
  - docs/reviews/release-acceptance/70cc9f7-r4.md
  - docs/reports/ENG-74-release-acceptance-r5-20261001.md
  - docs/reports/ENG-74-acceptance-evidence-r5-20261001
  - docs/reports/ENG-74-release-acceptance-r4-20261001.md
  - "/private/tmp/herdr-acceptance-FUJd7V/evidence"
  - "/private/tmp/herdr-acceptance-UjpraG/evidence"
  - "/private/tmp/herdr-acceptance-XXYqDU/evidence"
  - "/private/tmp/herdr-acceptance-f28DjH/evidence"
  - "/private/tmp/eng74-r56-all-discovery-costs.json"
  - "npm test before: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r56-before.log"
  - "npm test after: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r56-after-final.log"
  - "Separate acceptance boundary suite: 27 passed, zero failed/skipped; /private/tmp/eng74-r56-boundary-final.log"
  - "/private/tmp/eng74-r56-attribution.log"
  - "/private/tmp/eng74-r56-verification.log"
  - "Record check this report, commit it, then node lanes/lane.mjs check last; the final result is reported at turn completion"
decisions:
  - decision: Type the actual capability checks rather than infer safety violations from every adapter exception.
    why: Herdr unavailability, slow stand-ins and cleanup failures describe the harness. Unowned targets, outside-scratch paths, unsupported operations, forced removal, focus changes and arbitrary pane commands describe refused candidate requests. Native capability leaks, sandbox bypass and foreign roots retain their existing refusal markers.
  - decision: Keep ordinary product functionality gaps distinct from safety violations.
    why: An installer missing its documented entry and a policy missing its installed source still fail the product, but their messages no longer carry a safety marker. This preserves the failure while making the one-screen's attribution accurate.
  - decision: Rerun all three requested comparisons and select the retired discovery head by its captured subject.
    why: The supervisor's round-four instruction selected main and discovery; the omitted older-release rerun was that scope instruction, not an engineer omission. Round five explicitly restores v0.1.3. Discovery's lane ref was removed after promotion, so its captured committed head is selected from main by subject and receives a separate full run.
questions: []
challenges:
  - premise: Every non-receipt adapter exception identifies candidate misbehavior.
    verdict: wrong
    evidence: Six actual fake-native command failure paths and both real stand-in timeout loops now render PENDING with HARNESS and no SAFETY marker. Refused candidate requests still render product FAIL with SAFETY, including when wrapped by cleanup.
  - premise: The absent older-release rerun was an engineer omission.
    verdict: wrong
    evidence: The supervisor's round-four message explicitly requested main and lane/discovery's current head. The round-five supervisor instruction confirms that provenance and requires all three; all three fresh one-screens are included below.
  - premise: The discovery comparison remains a separate branch throughout acceptance.
    verdict: wrong
    evidence: Its captured subject was promoted to main and the lane ref disappeared before snapshotting. The first attempt stopped before inference; an immutable subject selection reran that exact head. The main run captured the same commit.
  - premise: Correct shell cwd readiness resolves the existing workspace metadata failure.
    verdict: wrong
    evidence: Cwd was ready after 24-25 ms, but the subsequent main/discovery polls still contain no idle-workspace identity and 75 positive configured comparisons each. The wrapper executions remain refused before any guessed identity is used.
---

Both findings in the [round-four review](../reviews/release-acceptance/70cc9f7-r4.md)
are addressed by **Distinguish capability refusals from acceptance harness
failures**. All three candidate runs remain **NOT READY**. No live project,
record, shared route file or activated release was changed; nothing was pushed.
Scratch workspaces alone were created and closed. Herdr's server still records
its normal runtime logs.

The adapter now emits `acceptance_product_boundary` only for its explicit
capability refusals. Its catch-all emits `acceptance_harness_limit` for ordinary
native failures, malformed receipts, script timeouts and I/O errors. Directly
forwarded native failures use the same handling as failures consumed by
`body()`. A missing pane identity/cwd receipt is separately a harness limitation;
a live foreign workspace or outside-scratch cwd remains a product refusal.
No ownership or path grant was widened. Model execution, post-model Git and
final tests retain the native sandbox, stripped environment, disabled hooks and
fsmonitor, and read-only verification roots from round four.

| Regression class | Executed evidence and result |
| --- | --- |
| Native Herdr command failures | Inject non-zero replies through actual adapter calls for pane get, agent get, pane run, send-text, send-keys and workspace close. Body-consumed and forwarded replies all render PENDING with HARNESS and no SAFETY marker. |
| Stand-in registration timeout | Execute the full registration loop with a fake native agent remaining working. It reaches the actual timeout and renders HARNESS. |
| Scripted PTY acknowledgement timeout | Send through the actual adapter's owned stand-in PTY transport, then withhold its receipt. The full acknowledgement loop times out and renders HARNESS. |
| Cleanup error wrapping | A non-zero close reply remains HARNESS when wrapped by HarnessLimit and classified as cleanup. A real unowned-target refusal remains product FAIL even under that same wrapping. Existing retained-root and signal-cleanup regressions also pass. |
| Capability refusals | Refused foreign targets, outside-scratch paths, unsupported operations, forced worktree removal, focus, arbitrary pane commands and outside-scratch cwd render FAIL with SAFETY. The native fake-product bypass regression still refuses before launch; capability-leak/foreign-root classification remains covered. |
| Missing live receipt | A missing cwd receipt denies the late-pane grant and renders HARNESS, rather than claiming a candidate escape. |
| Ordinary product gaps | Missing documented product entry and missing installed policy source render ordinary product FAIL with neither SAFETY nor HARNESS. |

The final separate boundary suite passed **27 tests**, zero failures or skips,
in 35.5 seconds. It is outside npm test and calls no models. Its timeout tests
actually wait for the lifecycle deadlines. Native adversarial tests still prove
config/hooks cannot be written, commit/worktree/ref operations can run, filters
and model-style tests execute only sandboxed, external canary/socket access is
denied, and a redirected `.org` cannot change a foreign record.

One regression originally archived `lane/discovery`. Its removal exposed that
unstable fixture dependency; it now archives this lane's committed CLI at HEAD.
The older CLI does not have the newer `ask --wait` flag, so this confinement
fixture uses fresh category `other`, asserts the question is unanswered, then
answers through the confined CLI. Both preliminary fixture failures were offline
and cost no model tokens. Real case 21 still uses the candidate's actual question
policy and requires the human wait plus a real application session.

The previous older-release comparison scope came from the supervisor's
round-four instruction: “Re-run against main and lane/discovery … use its current
head.” The round-five instruction confirms that it was the supervisor's scope
choice, not an engineer omission. This report restores a fresh v0.1.3 comparison
and includes all three requested screens.

At initial inspection, main was **Brief for ENG-77: agents discover the workflow
in any project** and discovery's current head was **Report discovery lifecycle
recovery and root compatibility verification**. During checks, the latter was
promoted to main and `lane/discovery` was removed. The initial direct lane
snapshot failed before candidate execution or inference. Its raw setup evidence
is `/private/tmp/herdr-acceptance-f28DjH/evidence`; it is not the completed
discovery comparison below. The main run's snapshot and the independent
subject-selected discovery-head rerun both captured **Report discovery lifecycle
recovery and root compatibility verification**, containing **Preserve ignored
lane files and recover interrupted project entry**, **Restore operator path
compatibility and clean unused entry lanes**, and **Provide installed project
entry with isolated lanes and bounded Git promotion**. v0.1.3 remains **Add the
console-fold review, round 2 (PASS)**. Candidate identities are preserved in the
summary files; commits are cited here by subject.

The completed commands were:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs \
  --candidate 'main^{/Report discovery lifecycle recovery and root compatibility verification}' \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

All exit 1 because failure or pending closes the release gate. Main took
299 seconds, v0.1.3 took 95 seconds, and the separate captured discovery-head run
took 334 seconds. None used keep. Only `summary.json` and `screen.txt` per
candidate are tracked under
`docs/reports/ENG-74-acceptance-evidence-r5-20261001/{main,v0.1.3,lane-discovery}/`.

Main:

```text
Release acceptance: main (299s) — 19 pass / 1 fail / 3 pending — NOT READY
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
FAIL    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PENDING 18 ENG-64: every file switch and rollback
PENDING 19 ENG-64: final contrib removal and restoration
PASS    20 Real discovery: concurrent lanes and promotion
PASS    21 Real discovery: routing question waits and answer applies
PENDING 22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-FUJd7V/evidence (NN.jsonl; summary.json has reasons)
```

v0.1.3:

```text
Release acceptance: v0.1.3 (95s) — 7 pass / 4 fail / 12 pending — NOT READY
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
FAIL    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PENDING 18 ENG-64: every file switch and rollback
PENDING 19 ENG-64: final contrib removal and restoration
FAIL    20 Real discovery: concurrent lanes and promotion
FAIL    21 Real discovery: routing question waits and answer applies
PENDING 22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-UjpraG/evidence (NN.jsonl; summary.json has reasons)
```

Captured current discovery head, now on main:

```text
Release acceptance: main^{/Report discovery lifecycle recovery and root compatibility verification} (334s) — 19 pass / 1 fail / 3 pending — NOT READY
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
FAIL    16 Existing project: routing and both wrapper dry runs
PASS    17 Existing project: org PATH consumers
PENDING 18 ENG-64: every file switch and rollback
PENDING 19 ENG-64: final contrib removal and restoration
PASS    20 Real discovery: concurrent lanes and promotion
PASS    21 Real discovery: routing question waits and answer applies
PENDING 22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-XXYqDU/evidence (NN.jsonl; summary.json has reasons)
```

Main and the captured discovery head independently pass the real concurrent-lane
and routing-question cases. In each run, two overlapping greeting sessions use
distinct lane branches and checkouts, populate separate durable work/run records,
request validation and promotion, and integrate French and German through clean
fast-forwards with no merge commits and a clean main checkout. Independent final
sandbox verification passes all three greeting tests. The source witness in each
`.entry.json` and `.sources.json` is the actual installed adapter's delivered
`installed-product/discovery/policy.mjs`, captured outside model-writable roots.
Project parents contain only their ordinary project, and native probes deny
parent listing, candidate-repository policy reads, harness access, config/hook
writes and the actual existing Herdr socket connection. No workflow configuration
is supplied by the fixture.

In each positive routing case, fresh `HUM-1` uses category `other`, resolves to
`ask`, and remains open and unanswered. It proposes engineer `gpt-6.1-sol` high
and review `opus` high with the portable preset. The scripted human yes is written
through the confined record CLI, then a fourth real session applies and validates
the approved `.lane.json`. v0.1.3's three sessions have successful measured turns
but no witnessed product policy, so both discovery assertions fail before any
human-answer application phase. The older release also needs record setup and
lacks newer cycle modules; missing modules stay explicitly pending.

The raw positive Git receipts still list two prunable registrations whose lane
paths no longer exist when entry exits. Case 20 establishes separate lanes and
integration; it does not prove that every registration is removed. These receipts
remain available for discovery lifecycle review. Normal cleanup removes the
entire scratch project and its separate session roots.

Case 16 remains a bounded real identity gap, not an initial-cwd explanation:

| Candidate | Exact shell cwd ready | Subsequent metadata samples | Idle workspace has metadata | Configured comparison has metadata |
| --- | ---: | ---: | ---: | ---: |
| main | 25 ms | 75, from 49 to 14,974 ms | 0/75 | 75/75 |
| v0.1.3 | 24 ms | 74, from 51 to 14,964 ms | 0/74 | 0/74 |
| captured discovery head | 24 ms | 75, from 47 to 14,856 ms | 0/75 | 75/75 |

The positive main/discovery comparisons continue to support ENG-79's idle or
background publication/resolution investigation. The older candidate supplies
no positive configured comparison. None of these bounded observations identify
the internal cause or prove unlimited absence. Both existing-project wrapper
dry runs remain refused before execution with guessed identity.

Case 22 stays separately pending for the actual default supervisor
dispatch/watch/ingest cycle in an unconfigured project; case 04 is only actual
supervisor entry/bootstrap in a dedicated untouched project. Cases 18/19 still
lack all switch behavioral canaries and final safe contrib retirement. Main now
passes discovery, so missing discovery on main is no longer a blocker in this
run. The remaining acceptance work stays with ENG-78 and ENG-79; no live cutover
is authorized by these results. Neither completed positive comparison reports
SAFETY or HARNESS refusals.

All model calls were the eleven measured discovery sessions in the three full
runs, on `gpt-5.6-luna` low. Each session exited 0 with one complete turn receipt.
The failed vanished-ref snapshot and all offline regression attempts made no
model call. Token cost per session and per run:

| Candidate | Session | Input | Cached input | Output | Reasoning output |
| --- | --- | ---: | ---: | ---: | ---: |
| main | french | 167,249 | 152,576 | 2,446 | 314 |
| main | german | 207,002 | 166,656 | 3,275 | 381 |
| main | routing | 162,566 | 127,744 | 2,619 | 195 |
| main | routing-apply | 145,009 | 129,536 | 2,447 | 346 |
| v0.1.3 | french | 78,480 | 70,144 | 1,141 | 129 |
| v0.1.3 | german | 92,748 | 80,128 | 1,559 | 257 |
| v0.1.3 | routing | 50,668 | 44,032 | 872 | 324 |
| lane-discovery | french | 113,460 | 94,208 | 3,173 | 265 |
| lane-discovery | german | 296,278 | 255,232 | 4,267 | 259 |
| lane-discovery | routing | 81,908 | 71,168 | 2,614 | 311 |
| lane-discovery | routing-apply | 138,909 | 116,480 | 2,259 | 262 |
| main total | 4 sessions | 681,826 | 576,512 | 10,787 | 1,236 |
| v0.1.3 total | 3 sessions | 221,896 | 194,304 | 3,572 | 710 |
| discovery-head total | 4 sessions | 630,555 | 537,088 | 12,313 | 1,097 |
| Round total | 11 sessions | 1,534,277 | 1,307,904 | 26,672 | 3,043 |

Cached input is included in input; reasoning output is a reported output subset,
not an extra quantity added to output. Cache-write input was zero. No billing
rate or currency estimate is inferred. Per-run `discovery-usage.json` files
remain in raw scratch evidence, and the full round aggregate is
`/private/tmp/eng74-r56-all-discovery-costs.json`.

Raw transcripts, prompts, commands, source and boundary receipts, manifests,
cutover inventory, cwd/metadata samples and ownership/cleanup evidence stay only
under these scratch paths:

- `/private/tmp/herdr-acceptance-FUJd7V/evidence` — main
- `/private/tmp/herdr-acceptance-UjpraG/evidence` — v0.1.3
- `/private/tmp/herdr-acceptance-XXYqDU/evidence` — captured discovery head
- `/private/tmp/herdr-acceptance-f28DjH/evidence` — failed vanished-ref snapshot,
  no inference

All four attempts closed their owned workspaces and have empty credential and
retained-root arrays. Separate project/session/verification roots and temporary
authentication copies were removed. Signal regressions still prove credential
removal before/after failed cleanup; SIGKILL cannot run a handler and was not
used in these runs.

`npm test` passed before the changes (371 pass, one explicit skip, zero fail,
54.4 seconds) and after the final changes (same counts, 36.4 seconds). The final
27-test boundary suite passed in 35.5 seconds with no failures/skips. Native
interactive idle/blocked detection and prompt timing remain outside the claims
of scripted mechanics and these headless discovery sessions. The round-four
report carries a dated attribution/scope correction and keeps its original
screens as historical evidence.

The implementation commit is **Distinguish capability refusals from acceptance
harness failures**. This report is checked with read-only `record check`, then
committed as **Report corrected acceptance attribution and all three candidates**.
The requested final action is `node lanes/lane.mjs check`; its result is reported
at turn completion, after which this run stops.
