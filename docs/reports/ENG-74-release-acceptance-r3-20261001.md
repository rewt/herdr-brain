---
run: R-52
outcome: blocked
summary: |
  Fixed all six round-two review findings and exercised the actual installed project-entry adapters with their bounded Git parent. The discovery candidate passes concurrent lane discovery, conflict recovery, fast-forward integration, recorded work, and a routing question that waits for a human before a real agent applies the answer. Main remains 14 pass / 6 fail / 2 pending; v0.1.3 remains 7 / 4 / 11; the discovery candidate is 19 / 1 / 2. The remaining background workspace identity gap persists after cwd readiness, and cutover behavioral coverage still keeps the release gate closed. Only summary/screen pairs are retained in Git; raw evidence and measured token costs are in scratch.
headline: Installed discovery passes, but release acceptance remains blocked
blockers:
  - "Main and v0.1.3 do not ship installed project discovery. The separate discovery candidate passes cases 20 and 21 but is not promoted to main. Existing follow-up: ENG-77."
  - "Case 16 remains a real bounded idle/background workspace identity gap after the shell cwd is ready: main and the discovery candidate omit its metadata throughout 15 seconds while their active configured fixture has it in every comparison sample. Both wrappers are refused before execution. Existing follow-up: ENG-79."
  - "Cases 18 and 19 still lack the ten cutover behavioral canaries and safe final contrib retirement. Housekeeping now passes on main and the discovery candidate. Default supervisor dispatch/watch execution in an unconfigured project is not established by the entry-policy smoke check. Existing acceptance follow-up: ENG-78."
proposals: []
learnings:
  - "The installed adapter requires its worktree root outside existing Git checkouts. Use each session's own temporary directory, and allow the native transport to enter that assigned lane."
  - "Probe native Git commit, worktree creation and ref updates before inference. Direct sessions need explicit scratch Git-common grants; installed sessions retain Git protection and use the product's bounded parent. Validation keeps Git metadata read-only."
  - "Captured product developer instructions are direct delivery evidence. Preserve their actual text and source instead of requiring a model to quote them without paraphrasing; behavior still has to demonstrate adoption."
  - "Herdr can add a pane after a creation receipt. Grant it only after real pane get returns the exact opaque ID, an owned workspace and scratch cwd; update the ownership ledger under its lock."
  - "The actual socket premise needs the original HERDR_SOCKET_PATH, the core fallback, host isSocket verification and a denied native connect to that endpoint."
  - "SIGINT and SIGTERM remove copied credentials before and after cleanup, attempt all owned workspace closures and report errors/residue. Keep preserves separate project/session scratch directories, never authentication copies."
  - "The copied-code sandbox needs literal ancestor-directory reads for the product's safe directory-FD traversal. That must not grant descendant live code reads or external record writes."
artifacts:
  - "Commit: Make installed discovery acceptance passable and classify harness limits"
  - "Commit: Report installed discovery acceptance and remaining release gates"
  - acceptance/run.mjs
  - acceptance/live.mjs
  - acceptance/security.mjs
  - acceptance/probe.mjs
  - acceptance/herdr.mjs
  - acceptance/native-transport.mjs
  - acceptance/signal-cleanup.mjs
  - acceptance/README.md
  - acceptance/test
  - docs/reviews/release-acceptance/9655e45-r2.md
  - docs/reports/ENG-74-release-acceptance-r3-20261001.md
  - docs/reports/ENG-74-acceptance-evidence-r3-20261001
  - docs/reports/ENG-74-release-acceptance-r2-20261001.md
  - docs/reports/ENG-74-release-acceptance-20261001.md
  - "/private/tmp/herdr-acceptance-U2srxh/evidence"
  - "/private/tmp/herdr-acceptance-mYNJu7/evidence"
  - "/private/tmp/herdr-acceptance-eHsyXb/evidence"
  - "/private/tmp/eng74-r52-all-discovery-costs.json"
  - "/private/tmp/eng74-r52-profile-result.json"
  - "npm test before: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r52-before.log"
  - "npm test after: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r52-after.log"
  - "Separate acceptance boundary suite: 15 passed, zero failed; /private/tmp/eng74-r52-boundary-final-verified.log"
  - "Record check this report, commit it, then node lanes/lane.mjs check last; the final result is reported at turn completion"
decisions:
  - decision: Exercise the actual machine-installed headless entry and its bounded Git parent.
    why: The candidate installer supplies monitor-codex; the gate invokes its documented -- exec interface. Normal automatic interactive PATH entry deliberately passes headless codex exec through. Project workflow configuration is never supplied by the fixture.
  - decision: Separate harness refusal from candidate failure on the one-screen.
    why: Capability, ownership, native transport and interrupted-session limits become PENDING with [HARNESS] and a reason. Missing shipped discovery remains a product FAIL after native capability checks pass.
  - decision: Treat the captured adapter delivery as the authoritative policy source.
    why: A real host transport records the candidate's supplied developer instructions and installed source. Model paraphrases cannot manufacture or invalidate that receipt; the real case additionally requires separate lanes, recorded work and successful integration.
  - decision: Narrow the existing workspace identity handoff instead of declaring a startup race fixed.
    why: Correct cwd readiness does not clear the 15-second failure. Compare the active configured fixture with the idle copied-project workspace and investigate publication by activity/focus without synthesizing metadata or targeting operator panes.
questions: []
challenges:
  - premise: A rerun against a discovery candidate would settle the round-two discovery verdict.
    verdict: wrong
    evidence: The old profile denied Git writes, the lane root was inside a checkout, and the transport rejected external assigned lanes. Those were harness defects. The corrected installed candidate now passes both real discovery cases.
  - premise: An exact model quotation is required to establish receipt of product developer instructions.
    verdict: wrong
    evidence: Actual adapter delivery is captured outside the model's writable roots. An intermediate run integrated both changes but failed on paraphrased quotations; the gate now uses the original captured policy and retains all behavioral requirements.
  - premise: Case 16 fails only because its initial shell cwd is transient.
    verdict: wrong
    evidence: The final three shells were already in the copied checkout after 25-26 ms, before polling. All comparison samples still omit that idle background identity. The main/discovery configured fixtures have metadata in every sample.
  - premise: Scripted mechanics establish every native agent interaction.
    verdict: wrong
    evidence: Real headless Codex sessions establish policy receipt and work/promotion here. Native interactive startup, idle/blocked detection and interactive prompt timing are not established by scripted PTY workers or these headless sessions.
---

All six findings in the [round-two review](../reviews/release-acceptance/9655e45-r2.md)
are addressed by **Make installed discovery acceptance passable and classify
harness limits**. The independent positive control is essential: a candidate
shipping discovery can now pass case 20. Release acceptance itself remains
blocked; no release, shared routing file, live record or bch-cloak checkout was
changed, and nothing was pushed.

Main was **Brief for ENG-77: agents discover the workflow in any project**.
v0.1.3 was **Add the console-fold review, round 2 (PASS)**. The additional
committed `lane/discovery` snapshot was **Report discovery review fixes and
scratch verification**, containing **Harden project entry and preserve existing
agent launches** and **Provide installed project entry with isolated lanes and
bounded Git promotion**. This tests that committed candidate, not another lane's
uncommitted files.

The final commands were:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate v0.1.3 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate lane/discovery \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm --keep
```

All exit 1 because any failure or pending case closes the gate. Main took
175 seconds, v0.1.3 102 seconds, and the installed candidate 365 seconds.
The actual screens are reproduced below. Only these screens and their summary
JSON files are copied to [the round-three evidence directory](ENG-74-acceptance-evidence-r3-20261001).

```text
Release acceptance: main (175s) — 14 pass / 6 fail / 2 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
FAIL    03 New project: routes resolve without config
FAIL    04 New project: discover dispatch/watch/default cycle
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
FAIL    20 Real discovery: concurrent lanes and promotion
FAIL    21 Real discovery: routing question waits and answer applies
PASS    22 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-U2srxh/evidence (NN.jsonl; summary.json has reasons)
```

```text
Release acceptance: v0.1.3 (102s) — 7 pass / 4 fail / 11 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
PENDING 03 New project: routes resolve without config
PENDING 04 New project: discover dispatch/watch/default cycle
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
PASS    22 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-mYNJu7/evidence (NN.jsonl; summary.json has reasons)
```

```text
Release acceptance: lane/discovery (365s) — 19 pass / 1 fail / 2 pending — NOT READY
PASS    01 Candidate snapshot
PASS    02 New project: record discovers and populates
PASS    03 New project: routes resolve without config
PASS    04 New project: discover dispatch/watch/default cycle
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
PASS    22 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-eHsyXb/evidence (NN.jsonl; summary.json has reasons)
```

The six review fixes and their evidence:

| Finding | Change and verification |
| --- | --- |
| Unpassable Git/promotion boundary | Before inference, a native sandbox commits, adds a worktree and updates a ref in a disposable Git fixture inside the session temp. Explicit grants are confined to project/temp, including symlink checks. Installed sessions use the actual product parent for Git writes and retain read-only Git metadata in model/validation commands. Both real agents promoted in case 20. |
| Late default-layout pane | Native pane get must return the exact requested ID, an owned workspace and scratch cwd before the ledger grants ownership under its lock. Foreign and outside-cwd tests refuse it. Released one-pass housekeeping passes on main and the installed candidate. |
| Vacuous socket probe | Resolve original HERDR_SOCKET_PATH with the core fallback, stat it on the host and require isSocket, then prove EPERM/EACCES for a native connect to that endpoint without sending a request. Custom socket, ordinary-file and absent-path regressions pass. |
| Keep discarded discovery projects | Discovery parents/session temps are removed only without keep. All six final installed-run retained paths exist, and its codex-runtime directory is absent. |
| Interrupt credential residue | SIGINT/SIGTERM delete credentials first, attempt owned cleanup, delete again and summarize errors/residue. Two subprocess regressions use synthetic 0600 credentials and a deliberately failed cleanup; both remove copies and record the failure. Normal real runs close every owned workspace; the final installed cleanup receipt has empty workspaces/errors and zero credential residue. |
| Case-16 cwd race | Wait for pane foreground_cwd to equal the copy before polling. Record both the copied workspace and configured fixture in each sample. The failure persists as detailed below; ENG-79 remains a real gap. |

`[HARNESS]` is now visible on a named PENDING line for prerequisite, capability,
transport, ownership and interrupted-session failures; the missing-rg regression
asserts that actual screen text and summary origin. The final three runs have no
harness PENDING lines. Cases 18/19 are product/coverage pending. Case 16 is an
observed host integration failure, not evidence that candidate wrapper code ran
and failed.

Installed discovery used two unrelated scratch project parents, each containing
only its project. No .org, .lane.json, routes or agent instructions were supplied.
Both application fixtures have an ordinary English greeting and a real Node test;
a routing-only README fixture would leave no meaningful validation command for
promoting approved configuration. No workflow configuration is added to make it
pass. Each model receives only its project/assigned lane and own temp as writable
roots, a stripped read-only installed distribution, and an environment with no
HERDR/ACCEPTANCE variables. The pre-inference receipts prove parent listing,
candidate AGENTS, harness reads/writes and direct live socket access are denied.

The source actually delivered to each installed session is
`/private/tmp/herdr-acceptance-eHsyXb/installed-product/discovery/policy.mjs`.
The four `discovery-*.entry.json` files retain the exact adapter arguments, cwd,
source and full developer policy; `*.sources.json` records the witnessed delivery.
The product policy includes:

```text
Do all work in your own lane. Never start project housekeeping, dispatch other agents, push, delete lanes or change another checkout directly.
```

The gate does not substitute product-repository AGENTS.md or model paraphrases
for that source. The French and German agents actually started distinct R-1/R-2
runs on ENG-1/ENG-2, used separate lane branches/checkouts, committed and checked
their work, and requested promotion through the installed client. One integrated
first; the other resolved the resulting greeting/test rebase conflict through
rebase/continue, checked again and fast-forwarded. Main contains Bonjour and
Hallo, remains clean, has no merge commits, and its three tests pass. Both done
reports are ingested in the product-created shared record. The project is
`/private/tmp/herdr-discovery-2mYUaD/project`; events, transcripts and
`discovery-git.txt` retain this evidence.

In `/private/tmp/herdr-discovery-I4cLkU/project`, installed entry created one
HUM-1 question proposing the portable preset: engineer gpt-6.1-sol high and
independent review opus, with the other roles listed. The first real agent left
it pending and recorded needs_human. Its category is other and the fresh record's
default/category resolves to ask. The harness then supplied the explicitly
scripted human yes; a second real session resumed the recorded work as R-2,
applied the approved routes in its own lane, validated and promoted .lane.json,
and finished done. This establishes human-waiting routing adoption on the
installed candidate; it does not configure the operator's shared project.

The strict native read profile prevents the installed safe-directory reader's
ancestor-FD opens for direct org show/check in these model sessions; the
transcripts contain EPERM. This is a harness read-profile limitation, not a
finding that installed record commands fail under normal machine permissions.
The actual bounded parent still validates/ingests reports and checks/promotes
both task changes and approved routes. Those required behaviors passed. The
headless monitor-codex machine interface is exercised; automatic interactive
PATH launch and interactive Herdr agent prompt timing are not claimed. Case 04
is an entry-policy/record-bootstrap smoke check, not execution of an unconfigured
supervisor dispatch/watch cycle. The configured end-to-end mechanics are case 06.

Case 16 and the narrowed ENG-79 handoff:

| Candidate | Cwd ready before poll | Metadata samples | Copy with identity | Configured fixture with identity |
| --- | --- | ---: | ---: | ---: |
| main | exact copy, 25 ms | 75, last 15,022 ms | 0 | 75 |
| v0.1.3 | exact copy, 25 ms | 74, last 15,025 ms | 0 | 0 |
| installed discovery | exact copy, 26 ms | 75, last 14,983 ms, then timeout | 0 | 75 |

Each poll is bounded at 15 seconds. The native worktree-list receipt resolves the
copied checkout's canonical Git identity, but workspace-list does not publish it.
The main/discovery comparison fixture has activity and reports focused, whereas
the copied workspace is idle/background; the older run's idle configured fixture
also lacks metadata. This suggests activity/focus-dependent publication but does
not distinguish those factors or prove indefinite absence. The missing initial
cwd wait was real and is fixed; it did not clear this gap. ENG-79 should reproduce
that specific idle/background publication difference and make canonical identity
available without requiring focus or manufactured metadata. Both wrapper dry
runs and the copied routing tests are refused before execution, so their behavior
remains unproved. The original ENG-79 proposal and round-two report now carry this
correction, and the historical round-two false candidate inferences are withdrawn.

All copied scripts are still re-audited immediately before execution, pin a
scratch ORG_DIR, and run under the independent kernel write/read boundary.
The additional ancestor-directory permission is literal directory access only;
the regression still denies external code reads and event writes. Case 17 now
also passes against the installed candidate's safe file reader. Current copied
calls include more than the original inventory (dispatch, notify, tidy, settle,
stage and promotion/desks); checksums and caller scan stay in scratch.
No live copied path is executed.

Checks: npm test before and after each passed 371 tests with one explicit skip
and zero failures (31.2 and 32.4 seconds). The separate acceptance safety suite
passed all 15 tests in 7.8 seconds, including late panes, socket premises,
credential signals, path/record escapes, actual kernel confinement and source
attribution. The standalone pre-inference native Git proof is retained in
`/private/tmp/eng74-r52-profile-result.json`. Discovery and acceptance remain
outside npm test. Record check and the final lane check are the remaining
report/commit sequence; their final result is reported at turn completion.

Measured token cost, including every exploratory acceptance run in R-52, is
below. All sessions use gpt-5.6-luna at low; no automatic model escalation was
used. Cached input is included in input. Reasoning is the separately reported
usage field and is not added again to output. No unverified currency estimate is
made. The raw per-session usage and every retained discovery directory are named
in `/private/tmp/eng74-r52-all-discovery-costs.json`.

| Scratch run | Purpose | Measured sessions | Input | Cached input | Output | Reasoning |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| herdr-acceptance-CG99uW | Mechanics only | 0 | 0 | 0 | 0 | 0 |
| herdr-acceptance-SzLzhS | Installed startup/root mismatch; no inference | 0 | 0 | 0 | 0 | 0 |
| herdr-acceptance-Yb3CNh | Initial main | 3 | 234,536 | 184,832 | 4,624 | 758 |
| herdr-acceptance-6mAcIi | Initial older release | 3 | 243,343 | 197,888 | 4,342 | 811 |
| herdr-acceptance-bRHYVK | Installed integration; quote attribution trial | 3 | 632,732 | 539,392 | 9,174 | 1,142 |
| herdr-acceptance-U2srxh | Final main | 3 | 273,797 | 207,104 | 4,158 | 839 |
| herdr-acceptance-mYNJu7 | Final older release | 3 | 199,541 | 176,640 | 3,908 | 927 |
| herdr-acceptance-eHsyXb | Final installed discovery | 4 | 743,531 | 641,536 | 13,642 | 1,861 |
| **All R-52 runs** | | **19** | **2,327,480** | **1,947,392** | **39,848** | **6,338** |

The earlier installed root-mismatch and quotation failures were harness defects,
not negative ENG-77 findings; their costs remain accounted for. The final ten
sessions across the three candidates total 1,216,869 input (1,025,280 cached),
21,708 output and 3,627 reported reasoning tokens.

Raw evidence resides at `/private/tmp/herdr-acceptance-<suffix>/evidence` for each
scratch run named in the table. In particular the final paths are
`/private/tmp/herdr-acceptance-U2srxh/evidence`,
`/private/tmp/herdr-acceptance-mYNJu7/evidence`, and
`/private/tmp/herdr-acceptance-eHsyXb/evidence`. Numbered command logs, boundary
probes, shell/metadata samples, source receipts, model transcripts, usage,
ownership and cleanup receipts remain there. Only summary.json and screen.txt
per final candidate are in Git. Keep deliberately retains three exploratory/
final installed scratch roots and their 16 separate project/session directories,
listed in the cost JSON and corresponding summaries; all authentication copies
are deleted and all owned workspaces are closed. Main/older normal runs retain
only evidence. The standalone native proof also names its retained scratch
fixture paths in its result JSON.

ENG-77's committed candidate clears the primary real discovery cases. ENG-79
remains a specific host identity gap and ENG-78's cutover coverage still keeps
all three candidates NOT READY. No duplicate follow-on items are proposed.
