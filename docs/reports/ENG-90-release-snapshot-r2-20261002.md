---
run: R-91
outcome: done
summary: |
  Rebased onto main and fixed both review findings with tests. Scratch classification now rejects uncertain paths, resolves native real paths before containment checks, and recognizes every registered run-owned temp root.
  Both requested offline acceptance runs finished at 22 pass, zero fail and two intentionally skipped discovery cases; console build and contrib retirement passed. The immutable release's bytes, symlinks and modes remained unchanged.
  npm test and all 59 offline acceptance regressions pass. The supervisor's prior full main comparison is recorded as 24/0/0; this fix round launched no model sessions.
headline: Both review findings are fixed and the offline candidate comparisons match.
blockers: []
proposals: []
learnings:
  - Parent segments must be rejected before ownership inference; lexical normalization can erase a foreign symlink before resolving its parent segment.
  - Missing children can qualify through a real owned ancestor, but dangling links and unresolved existing entries cannot prove scratch ownership.
  - The scratch-root registry must remain shared through case execution so newly allocated discovery, session and verification roots are visible when setup throws.
artifacts:
  - "Fix commit: Fail closed on scratch path uncertainty and register all acceptance temp roots"
  - "Report commit: Report release snapshot review fixes and offline comparisons"
  - acceptance/limits.mjs
  - acceptance/temp.mjs
  - acceptance/run.mjs
  - acceptance/live.mjs
  - acceptance/verify.mjs
  - acceptance/cases.mjs
  - acceptance/test/snapshot.test.mjs
  - acceptance/test/verification.test.mjs
  - docs/reports/ENG-90-acceptance-evidence-r2-20261002/main/summary.json
  - docs/reports/ENG-90-acceptance-evidence-r2-20261002/main/screen.txt
  - docs/reports/ENG-90-acceptance-evidence-r2-20261002/v0.1.4/summary.json
  - docs/reports/ENG-90-acceptance-evidence-r2-20261002/v0.1.4/screen.txt
  - /private/tmp/herdr-acceptance-TMZKuy/evidence
  - /private/tmp/herdr-acceptance-bylbGq/evidence
  - /private/tmp/eng90-r2-baseline-tests.log
  - /private/tmp/eng90-r2-final-npm-tests.log
  - /private/tmp/eng90-r2-acceptance-final-tests.log
  - /private/tmp/eng90-r2-release-before.json
  - /private/tmp/eng90-r2-release-after.json
  - /private/tmp/eng90-r2-preserved-review/11153fb-r1.md
decisions:
  - text: Reject parent traversal and other unresolved or mixed foreign paths before classifying environment I/O as scratch-owned, using native realpath for containment.
    category: security
    why: The operator explicitly requires fail-closed classification whenever ownership is uncertain; lexical normalization must not hide a symlink escape.
  - text: Register each temp root immediately after creation and pass the same registry through command failures, case bodies and cutover subchecks.
    category: tooling
    why: Harness setup may throw before candidate execution in a separate owned root; a live registry preserves that ownership evidence through classification.
  - text: Run both requested comparisons with skip-live and retain their two pending discovery checks.
    category: tooling
    why: This is the requested fix-round scope; the supervisor already completed the full main comparison.
questions: []
challenges:
  - The rebase added a housekeeping import to the record CLI; its confined verification fixture archived only bin, lib and lanes. Adding housekeeping to that archive restored the existing confinement regression.
  - Main advanced after the initial rebase. Its acceptance snapshot is the newer Report MCP omitted-arguments regression fix, while v0.1.4 remains Report readable backup and exact launch acceptance proof; both offline results match.
  - An untracked round-one review already existed in the worktree. It was preserved unchanged in scratch for the required clean-worktree gate; the supplied findings file was read in place and was not copied into the repository.
---

The lane was rebased onto main before implementation, incorporating **Report
round-two housekeeping fixes and regression evidence**. The fix commit is
**Fail closed on scratch path uncertainty and register all acceptance temp
roots**.

The first finding is fixed by rejecting any parent component before ownership
inference and calling `fs.realpathSync.native` on the root and candidate ancestor
before comparing containment. The classifier preserves the raw path until that
resolution; it never calls path.resolve on an error path. Missing children may
use their nearest existing real ancestor. An unresolved existing entry, dangling
link, loop, relative path, missing ownership root or mixed foreign path fails
closed. Every reported path must resolve inside some registered owned root.
Explicit product safety refusals retain their product FAIL classification.

The second finding is fixed with a shared scratch-root registry and one temp
factory used by all four allocation sites: primary runner root, discovery
project parent, session temp and verification temp. The factory registers the
new directory immediately after mkdtemp and before realpath or later setup can
throw. Separate roots remain in the existing cleanup list. Command failures,
top-level case bodies and cutover subchecks receive the live registry, so roots
allocated during a case are visible when its exception is classified.

Four added regressions exercise the review fixes:

- An actual foreign-file EACCES through a scratch symlink followed by `..`, plus
  a command EPERM for that path, remain product FAIL; the foreign file is unchanged.
- Dangling links, loops, benign parent traversal, relative paths, missing roots
  and mixed foreign paths fail closed, while a real alias into scratch qualifies.
- The actual discovery setup creates separate parents, then an injected ENOSPC
  aborts initRepo before candidate/model execution. Both cases become
  `PENDING [HARNESS]`, and an unregistered foreign root remains FAIL.
- Actual session/verification temp creation is registered; direct EACCES and
  npm-style errors there become harness PENDING, and explicit safety refusals
  still fail. The existing native verification tests use the same registry.

`npm test` passed before changes with 474 pass, four explicit skips and zero
failures (42.6 seconds). The final run passed with the same counts (60.7 seconds).
The complete offline acceptance suite passed all 59 tests, zero failures or
skips (34.8 seconds). It includes native socket and sandbox-exec confinement
checks and makes no model calls. Its initial run was 58/1 because the rebased
record CLI's housekeeping dependency was missing from the confined archive;
the corrected fixture keeps that existing regression effective. The initial
log is `/private/tmp/eng90-r2-acceptance-tests.log`.

The completed commands were:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm --skip-live
node acceptance/run.mjs \
  --candidate /Users/rewt/.local/share/herdr-monitor/releases/v0.1.4 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm --skip-live
```

Main captured **Report MCP omitted-arguments regression fix** at startup. Its
one-screen is:

```text
Release acceptance: main (129s) — 22 pass / 0 fail / 2 pending — NOT READY
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
PENDING 21 Real discovery: concurrent lanes and promotion
PENDING 22 Real discovery: routing question waits and answer applies
PASS    23 New project: default supervisor dispatch/watch/ingest cycle
PASS    24 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-TMZKuy/evidence (NN.jsonl; summary.json has reasons)
```

The immutable v0.1.4 directory contains **Report readable backup and exact launch
acceptance proof**. Its one-screen is:

```text
Release acceptance: /Users/rewt/.local/share/herdr-monitor/releases/v0.1.4 (134s) — 22 pass / 0 fail / 2 pending — NOT READY
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
PENDING 21 Real discovery: concurrent lanes and promotion
PENDING 22 Real discovery: routing question waits and answer applies
PASS    23 New project: default supervisor dispatch/watch/ingest cycle
PASS    24 Cleanup and scope audit
Evidence: /private/tmp/herdr-acceptance-bylbGq/evidence (NN.jsonl; summary.json has reasons)
```

Each command exits 1 because --skip-live deliberately leaves both discovery
cases pending. All 22 executed checks pass, including actual offline npm ci,
zero-caller contrib retirement, split routing tests and exact compatibility-blob
restoration. The R-91 brief records the supervisor's prior full main comparison
as 24 pass / zero fail / zero pending (334 seconds), matching the prior full
v0.1.4 run. This round executes the requested offline verification scope and
incurs no model-session usage.

Release SHA-256/mode/symlink manifests match before and after across 5,964
entries. Both runs closed all their owned workspaces and have empty credential
residue and retained-discovery-root arrays. Raw numbered command logs,
ownership, cleanup, launch, switch and restoration receipts remain under:

- `/private/tmp/herdr-acceptance-TMZKuy/evidence` — main, 129 seconds.
- `/private/tmp/herdr-acceptance-bylbGq/evidence` — v0.1.4, 134 seconds.

Only summary.json and screen.txt per candidate are committed. The existing
untracked round-one review was moved intact to
`/private/tmp/eng90-r2-preserved-review/11153fb-r1.md`; the supplied private
findings were read at their original scratch path. No source release, bch-cloak,
shared lane configuration, operator bin or foreign pane was changed. Nothing
was pushed or published.

The report is checked with read-only `record check`, then committed as **Report
release snapshot review fixes and offline comparisons**. The final action is
`node lanes/lane.mjs check`; its result is delivered at turn completion, after
which this run stops.
