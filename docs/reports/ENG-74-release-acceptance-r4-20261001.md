---
run: R-54
outcome: blocked
summary: |
  Fixed all four round-three review findings: every post-model project verification executes sandboxed, direct Git grants exclude config and hooks, candidate safety refusals fail the product, and cleanup names every retained root. Renamed case 04 to the supervisor entry/bootstrap behavior it actually executes in an untouched project, and added a separately pending default supervisor cycle. Main is 14 pass / 6 fail / 3 pending; the current committed discovery candidate is 19 / 1 / 3 and passes both real discovery cases under the tightened sandbox. The workspace metadata gap and cutover coverage remain, and the unconfigured default cycle is explicitly unproved. Only summary/screen pairs are tracked; all raw evidence and measured token costs remain in scratch.
headline: Discovery passes the tightened sandbox, but the default cycle remains unproved
blockers:
  - "Main still fails fresh-project record, routes and installed supervisor entry, and both real discovery cases. The separately committed discovery candidate passes them; promotion to main remains ENG-77's responsibility."
  - "The unconfigured default supervisor dispatch/watch/ingest cycle has not been executed. Case 22 stays PENDING independently of the entry/bootstrap smoke and configured-cycle passes. Existing acceptance follow-up: ENG-78."
  - "Case 16 still lacks canonical idle/background workspace metadata after correct shell cwd and a 15-second comparison poll. Both wrapper dry runs are refused before execution. ENG-79 remains a real observed gap, not a startup-race explanation."
  - "Cases 18 and 19 still lack behavioral execution of every cutover switch and safe final contrib retirement. Existing follow-up: ENG-78; no live cutover is authorized by these results."
proposals: []
learnings:
  - "Git reads can invoke model-configured helpers. Route every harness Git call on a project into verification confinement before starting its first real session, including later concurrent-session setup. Disable hooks with an absolute /dev/null hooksPath and disable fsmonitor on every such call."
  - "Direct sessions need objects, refs, logs, index/lock and worktree registration writes, not a writable Git common directory. Real native tests prove config, config.lock, hooks and per-worktree config writes are denied while commit, worktree and ref operations succeed."
  - "Final tests on promoted model output need a fresh private verification temp, read-only project/Git, stripped environment and network denial. A hostile Git filter can run inside that boundary, but cannot write an external canary; fsmonitor remains disabled."
  - "The trusted record CLI's safe directory-FD traversal needs literal ancestor-directory reads. Kernel confinement with a pinned project .org allows the scripted human answer and refuses a redirected foreign record."
  - "Candidate-originated capability leaks, bypass flags, foreign roots, unowned targets and paths outside scratch are product FAIL. Missing prerequisites, pre-inference capability failures, interruptions and missing layout receipts remain PENDING with HARNESS attribution."
  - "Installed adapter developer instructions are a valid product source when captured outside model-writable roots. Real discovery still requires measured successful sessions and separate lanes, durable runs, validation and fast-forward integration."
  - "Always report actually existing discovery/verification roots after cleanup, regardless of keep. SIGINT and SIGTERM credential-removal regressions remain green."
artifacts:
  - "Commit: Sandbox discovery verification and keep the default cycle release-gated"
  - "Commit: Report sandboxed release acceptance and the pending default cycle"
  - acceptance/run.mjs
  - acceptance/live.mjs
  - acceptance/verify.mjs
  - acceptance/security.mjs
  - acceptance/probe.mjs
  - acceptance/native-transport.mjs
  - acceptance/herdr.mjs
  - acceptance/limits.mjs
  - acceptance/results.mjs
  - acceptance/test
  - acceptance/README.md
  - docs/reviews/release-acceptance/a6b67c9-r3.md
  - docs/reports/ENG-74-release-acceptance-r4-20261001.md
  - docs/reports/ENG-74-acceptance-evidence-r4-20261001
  - docs/reports/ENG-74-release-acceptance-r3-20261001.md
  - "/private/tmp/herdr-acceptance-wALNGt/evidence"
  - "/private/tmp/herdr-acceptance-yaCg0r/evidence"
  - "/private/tmp/eng74-r54-all-discovery-costs.json"
  - "npm test before: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r54-before.log"
  - "npm test after: 371 passed, one explicit skip, zero failed; /private/tmp/eng74-r54-after.log"
  - "Separate acceptance boundary suite: 21 passed, zero failed or skipped; /private/tmp/eng74-r54-boundary-final.log"
  - "Record check this report, commit it, then node lanes/lane.mjs check last; the final result is reported at turn completion"
decisions:
  - decision: Keep all execution of model-written code and model-configurable Git helpers inside a sandbox.
    why: Merely constraining model sessions leaves the host exposed during evidence capture. Verification is installed before the first model launch and reused for every later project Git operation and final test; trusted record reads and the scripted answer have a separate kernel boundary.
  - decision: Match case 04's name to its executed behavior and reserve a distinct gate for the default cycle.
    why: Supervisor policy-only entry actually bootstraps a dedicated untouched project, but does not dispatch, arm watch or ingest. Case 22 explicitly remains pending until that behavior runs on unconfigured defaults; other future fixes cannot silently turn this gate green.
  - decision: Treat candidate safety refusals as product failures.
    why: Leaking capabilities or requesting bypass, foreign roots or unowned panes is candidate behavior. A fake installed entry passing --yolo is refused before native launch and renders FAIL with SAFETY attribution, while genuine capability/layout limits retain HARNESS attribution.
  - decision: Rerun main and the current committed discovery head as the round-four comparison.
    why: The latest operator instruction selects these two candidates. The discovery head contains its round-three path compatibility and entry cleanup changes. Older v0.1.3 results remain historical; it was not rerun in this round.
questions: []
challenges:
  - premise: Sandboxed model sessions alone prove that the operator's panes are unreachable.
    verdict: wrong
    evidence: The round-three harness ran final model-written tests and Git helpers on the host. Those old safety claims are withdrawn. Native adversarial tests now prove external writes and socket connects are denied during verification as well as before inference; hooks/config grants are narrowed.
  - premise: An entry-policy wording match proves the default supervisor cycle.
    verdict: wrong
    evidence: The renamed entry/bootstrap case executes only that behavior in a separate pristine project. A new explicit pending gate covers default dispatch, armed watch and ingestion, which this run does not execute.
  - premise: Every boundary refusal is a harness limitation.
    verdict: wrong
    evidence: The actual native transport refuses a fake product's bypass flag before launching its native binary; the same classification used by cases produces product FAIL and a SAFETY screen marker. Capability, interruption and layout receipt limits remain separately attributed.
  - premise: Case 16 is just an initial shell cwd race.
    verdict: wrong
    evidence: Main reaches the exact copied checkout after 32 ms and discovery after 28 ms. During the subsequent bounded poll, all 72 main and 73 discovery idle-workspace samples lack worktree metadata while their configured comparison workspaces have it in every sample.
---

**Correction, round five (2026-10-01):** the subsequent review found that the
adapter's broad product-boundary catch also mislabeled native Herdr errors,
stand-in timeouts and cleanup failures as safety violations. The [round-five
report](ENG-74-release-acceptance-r5-20261001.md) records explicit capability-error
typing and operational-error regressions. The prior comparison scope followed
the supervisor's round-four instruction to rerun main and the discovery head;
it was not an engineer omission. Round five reruns the older release as well.
The original results below remain historical.

All four findings in the [round-three review](../reviews/release-acceptance/a6b67c9-r3.md)
are addressed by **Sandbox discovery verification and keep the default cycle
release-gated**. The resulting gate remains **NOT READY** for both candidates.
No live record, bch-cloak checkout, shared routing file or activated release was
changed; nothing was pushed. The real Herdr server records its normal runtime
logs for the scratch workspaces.

Main's committed subject is **Brief for ENG-77: agents discover the workflow in
any project**. The `lane/discovery` head is **Report discovery path compatibility
and entry cleanup verification**, containing **Restore operator path compatibility
and clean unused entry lanes**, **Harden project entry and preserve existing agent
launches**, and **Provide installed project entry with isolated lanes and bounded
Git promotion**. These were committed snapshots, not uncommitted files from the
other lane. The recorded candidate identities are in the summary pairs; commits
are cited here by subject.

The latest round-four instruction replaces the generic brief's older-release
comparison with the current discovery head. v0.1.3 was not rerun; its earlier
one-screen remains in the round-three report. The two actual commands were:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
node acceptance/run.mjs --candidate lane/discovery \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

Both exit 1 because any failure or pending case closes the gate. Main took
153 seconds; discovery took 279 seconds. Neither used keep. Only the following
summary/screen pairs are in Git:

- `docs/reports/ENG-74-acceptance-evidence-r4-20261001/main/`
- `docs/reports/ENG-74-acceptance-evidence-r4-20261001/lane-discovery/`

Main:

```text
Release acceptance: main (153s) — 14 pass / 6 fail / 3 pending — NOT READY
PASS    01 Candidate snapshot
FAIL    02 New project: record discovers and populates
FAIL    03 New project: routes resolve without config
FAIL    04 New project: installed supervisor entry and record bootstrap
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
PENDING 22 New project: default supervisor dispatch/watch/ingest cycle
PASS    23 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-wALNGt/evidence (NN.jsonl; summary.json has reasons)
```

Current discovery candidate:

```text
Release acceptance: lane/discovery (279s) — 19 pass / 1 fail / 3 pending — NOT READY
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
Evidence: /private/tmp/herdr-acceptance-yaCg0r/evidence (NN.jsonl; summary.json has reasons)
```

The four review corrections and their verification:

| Finding | Change and evidence |
| --- | --- |
| Host execution after model sessions | Every project Git call after entry, including concurrent-session setup, uses native sandbox verification with read-only project/Git, a fresh private temp, no network, stripped HERDR/ACCEPTANCE environment, disabled hooks and fsmonitor. The final promoted `node --test` uses the same boundary. Direct session grants leave common config/hooks read-only and deny worktree config. The actual pre-inference probes deny config/hook writes and still commit, create a worktree and update a ref. An adversarial native regression runs a poisoned Git filter and hostile test, proves external canary/socket access denied, and proves fsmonitor/hook helpers never run. |
| False default-cycle pass | Case 04 is renamed installed supervisor entry and record bootstrap. Its new dedicated project begins without `.org`, `.lane.json` or agent instructions, independently of cases 02/03; actual policy-only supervisor entry creates its record. New case 22 remains PENDING for unconfigured default-route dispatch, armed watch and ingestion. Configured mechanics and real worker promotion do not satisfy it. |
| Candidate refusal mislabeled HARNESS | Explicit product-boundary markers map to FAIL, including legacy guard markers; genuine prerequisites, capability probes, interruptions and layout receipt failures retain HARNESS. Native transport marks leaked capabilities, bypass flags and foreign roots as product refusals, Herdr marks unowned/outside-scratch targets likewise, and a missing documented monitor-codex entry is a product failure. The actual fake-product bypass regression renders FAIL with SAFETY before native launch. Neither final candidate encountered a SAFETY or HARNESS refusal. |
| Hidden cleanup residue | Summary and cleanup screen derive retained roots from filesystem existence regardless of keep. An injected non-keep cleanup error reports both existing roots and omits the deleted root. Existing real SIGINT/SIGTERM regressions remove authentication copies before/after cleanup and report failures. Both final runs closed their owned workspaces and have empty credentialResidue and retainedDiscoveryRoots. |

No model-written module is imported by host verification. Git's filters and
configuration can still influence commands, so disabling hooks/fsmonitor alone
is insufficient: those commands also stay sandboxed. The installed Git binary
is resolved before entry; the macOS `/usr/bin/git` developer-tools shim failed
an initial narrow-profile regression and was replaced with the real installed
binary. Record inspection and the scripted human answer use the trusted installed
CLI inside a kernel sandbox, with writes pinned to the project's `.org`; a
regression redirects that path and proves the foreign record unchanged. The
initial verification-fixture failures were repaired before the final passing
suite and involved no model calls.

The discovery projects start under separate temporary parents containing only
an ordinary project, with no product repository or policy siblings. An ordinary
app and test are seed content, not workflow configuration. Pre-inference native
probes deny parent listing, canonical candidate policy reads, harness reads and
writes, and connection to the actual existing host Herdr socket. Only the session's
project and own temp are writable; the installed runtime is read-only, excludes
repository instructions/docs/tests/kit, and temporary credentials are outside
all model-accessible roots. Product discovery remains available through the
actual installed adapters, not through nearby repository files or supplied
workflow prompts.

For case 20 on discovery, both sessions were started before either was awaited.
The host/native transport captured the actual developer instructions from
`installed-product/discovery/policy.mjs`; the `.entry.json` and `.sources.json`
receipts preserve the original supplied policy and source. French and German
agents used distinct `lane/entry-*` branches and distinct checkouts under their
own session temps, started durable `ENG-1/R-1` and `ENG-2/R-2`, requested lane
check and promotion, and integrated both greetings with no merge commits and a
clean main checkout. The German session resolved the overlapping greeting/test
changes before promotion. Final independent sandbox verification ran all three
English/French/German tests successfully. This is the positive control for ENG-77:
a candidate shipping discovery can pass under the gate's real installed-machine
boundary. Main's agents completed measured turns but lacked a witnessed product
policy source and failed the discovery assertions.

The raw Git receipt also lists two prunable worktree registrations whose lane
paths no longer exist after the product entry exits. Case 20 establishes separate
lanes and successful integration; it does not establish removal of every Git
registration. ENG-77 can use this receipt when reviewing entry cleanup; the gate
removed the whole scratch project after closing its owned workspaces.

For case 21 on discovery, a separate fresh project's `HUM-1` remained open and
unanswered under category `other`, whose fresh config resolves to `ask`. The
question proposed engineer `gpt-6.1-sol` high and independent review `opus` high,
with the portable routes for other roles. The first real agent left it waiting
and wrote durable work. The harness's scripted human answered yes through the
confined record CLI; a fourth real session applied the approved `.lane.json`
and validated it. The product preset is a suggestion until that human answer,
not inherited operator configuration. Main failed before an answer/apply phase.

Case 16 still fails after waiting for the shell's exact cwd, as the configured
fixture does. Main's copied-project shell was ready at 32 ms; discovery's at
28 ms. Subsequent polls lasted about 15 seconds: 72 main samples from 65 to
14,865 ms and 73 discovery samples from 61 to 15,013 ms. Neither idle/background
workspace has canonical worktree metadata in any sample; the active configured
comparison workspace has it in every sample. No wrapper is run with guessed
identity. **ENG-79 remains a real observed publication/resolution gap in this
bounded environment.** Investigate identity availability for an idle/background
workspace before proposing a delay-only fix; the evidence does not identify the
internal cause or prove an unlimited absence. Both wrapper executions and their
forwarded routing arguments remain unproved here.

Case 22 is a separate required acceptance follow-up under ENG-78: execute the
actual supervisor dispatch/watch/ingest cycle on defaults in a project with
nothing configured. Case 04 supplies only entry/bootstrap evidence. Cases 18/19
still enumerate ten switches and byte/mode rollback checks without executing
all switched behavior; contrib retirement remains forbidden while the copied
live launcher uses it. Housekeeping itself passes on both candidates. These
pending product/coverage cases are not discounted as harness limitations.

Real-session cost is measured on `gpt-5.6-luna`, effort low, outside npm test.
There were exactly two acceptance runs and seven measured real sessions in this
round, each exiting 0 with one complete turn receipt. No exploratory model run
is excluded. All failed preliminary checks were offline native regressions.

| Candidate | Session | Input | Cached input | Output | Reasoning output |
| --- | --- | ---: | ---: | ---: | ---: |
| main | german | 78,382 | 70,144 | 1,051 | 153 |
| main | french | 128,294 | 107,520 | 1,897 | 307 |
| main | routing | 51,164 | 44,032 | 991 | 179 |
| lane-discovery | french | 146,309 | 124,672 | 2,431 | 218 |
| lane-discovery | german | 174,543 | 150,784 | 3,327 | 164 |
| lane-discovery | routing | 113,325 | 92,416 | 2,019 | 141 |
| lane-discovery | routing-apply | 168,186 | 142,592 | 2,480 | 219 |
| main total | 3 sessions | 257,840 | 221,696 | 3,939 | 639 |
| discovery total | 4 sessions | 602,363 | 510,464 | 10,257 | 742 |
| Round total | 7 sessions | 860,203 | 732,160 | 14,196 | 1,381 |

Cached input is included in input; reasoning output is a reported output subset,
not an additional charge added to output. Cache-write input was zero. No currency
estimate is inferred. Raw per-run usage is in each evidence directory's
`discovery-usage.json`; the round aggregate is
`/private/tmp/eng74-r54-all-discovery-costs.json`.

Raw evidence remains only in:

- `/private/tmp/herdr-acceptance-wALNGt/evidence`
- `/private/tmp/herdr-acceptance-yaCg0r/evidence`

Those directories contain numbered command receipts, copied-script manifests,
cutover inventory, cwd and metadata samples, real prompts/transcripts, sandbox
proofs, installed source/policy receipts, the routing question, verification
results and cleanup ownership receipts. Normal cleanup leaves only evidence;
all separate project/session/verification roots and authentication copies were
removed. SIGKILL cannot run a cleanup handler; no SIGKILL occurred in these runs.

Offline npm tests remain unchanged: 371 passed, one explicit skip, zero failures
before the change (40.3 seconds) and after it (35.2 seconds). The separate
acceptance boundary suite passed all 21 tests without failures/skips in
8.5 seconds; its native tests do not call a model and it remains outside npm test.
The report is checked against the live record using read-only `record check`,
then committed as **Report sandboxed release acceptance and the pending default
cycle**. The requested final action is `node lanes/lane.mjs check`; its result is
reported when this run stops.

The round-three report now carries a dated correction withdrawing its broad
host-verification safety claim, its blanket boundary-as-harness attribution and
its implication that case 04 covered the default cycle. Its original screens
remain historical. Scripted PTY lifecycle states still do not establish native
interactive Codex/Claude idle/blocked detection or prompt timing; these real
headless sessions establish installed policy receipt and work/promotion only.
