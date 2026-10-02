---
run: R-83
outcome: needs_human
summary: |
  Made audited candidate snapshots owner writable inside scratch and classified scratch environment I/O failures as harness PENDING, preserving explicit product safety failures.
  The immutable v0.1.4 release passed all 24 acceptance cases; its bytes, symlinks and modes remained unchanged. Matching main passed all 22 model-free checks, including console build and contrib retirement.
  Automatic approval review rejected the full main comparison's real discovery sessions. Explicit approval of their payload and model destination remains pending, so the required full comparison is incomplete.
headline: Release acceptance passes, but the full main comparison needs model-session approval.
blockers:
  - Automatic approval review requires explicit authorization for the full main comparison's four real discovery sessions through installed Codex to the OpenAI model service; the approval question remains unanswered.
proposals: []
learnings:
  - fs.cpSync preserves an immutable release's read-only modes, so scratch candidate directories and files must receive owner permissions before writable acceptance cases run.
  - npm reports scratch permissions through stderr, while direct filesystem operations provide structured errors; both paths need scratch-aware classification.
  - Matching main is pinned in a scratch bare repository to the release's recorded commit; the shared main branch and release directory were never changed.
artifacts:
  - "Implementation commit: Make acceptance snapshots writable and classify scratch I/O failures"
  - "Report commit: Report release snapshot proof and pending main discovery approval"
  - acceptance/snapshot.mjs
  - acceptance/limits.mjs
  - acceptance/cases.mjs
  - acceptance/run.mjs
  - acceptance/test/snapshot.test.mjs
  - docs/reports/ENG-90-acceptance-evidence-20261002/v0.1.4/summary.json
  - docs/reports/ENG-90-acceptance-evidence-20261002/v0.1.4/screen.txt
  - docs/reports/ENG-90-acceptance-evidence-20261002/main-offline/summary.json
  - docs/reports/ENG-90-acceptance-evidence-20261002/main-offline/screen.txt
  - /private/tmp/herdr-acceptance-Q1RvIy/evidence
  - /private/tmp/herdr-acceptance-ocGRUu/evidence
  - /private/tmp/herdr-acceptance-omazyz/evidence
  - /private/tmp/eng90-release-before.json
  - /private/tmp/eng90-release-after.json
  - /private/tmp/eng90-baseline-tests.log
  - /private/tmp/eng90-final-tests.log
  - /private/tmp/eng90-acceptance-native-tests.log
decisions:
  - text: Add owner read/write access to audited scratch snapshot files and read/write/traverse access to directories, retaining executable bits and skipping symlinks during chmod.
    category: security
    why: The ask explicitly authorizes writable scratch copies while forbidding changes to release directories; containment and lstat keep permission changes within that boundary.
  - text: Classify scratch permission, storage and file-resource errors as harness PENDING across child commands, case bodies and cutover subchecks.
    category: tooling
    why: Harness environment errors cannot establish a product defect; explicit capability refusals still take precedence as product FAIL.
  - text: Complete main mechanics with the documented skip-live flag after automatic approval review rejected the full comparison, leaving both discovery cases pending.
    category: tooling
    why: This completes unaffected authorized verification while keeping the rejected model sessions unexecuted and their checks explicitly pending.
questions:
  - question: Authorize the full matching-main comparison's four gpt-5.6-luna low-effort discovery sessions through installed Codex/OpenAI, sending synthetic greeting and routing tasks, scratch project content and installed product policy/code?
    category: security
    recommend: yes
    why: Automatic approval review rejected the full run because explicit payload and destination authorization was missing; this completes the requested comparison with source repositories and private records excluded by the harness.
challenges:
  - The full release run was approved and completed, but automatic approval review rejected the later equivalent main run for model payload and destination authorization. No discovery sessions were launched for main; its full 24-case result remains unproven in this run.
  - The first main mechanics attempt had a native agent_not_found harness error in copied-cleanup, making cutover-switches and contrib-retirement pending. One model-free retry passed both; the first attempt remains preserved in scratch evidence.
  - The outer sandbox prevented five existing offline native socket and sandbox-exec probes. The same complete suite passed outside that outer sandbox without any test changes.
---

The implementation commit is **Make acceptance snapshots writable and classify
scratch I/O failures**. After the existing snapshot symlink audit, both directory
copies and Git archives pass through a scratch-contained permission walk. It
adds owner permissions to regular files and directories while preserving their
executable bits. It uses `lstat` and skips links, so chmod cannot follow a link
back into the release or another source directory.

The harness passes its scratch root into command failure handling, top-level
cases and cutover subchecks. Structured filesystem errors and npm-style stderr
for EACCES, EPERM, EROFS, ENOSPC, EDQUOT, EMFILE, ENFILE and EIO become
`PENDING [HARNESS]` when their paths resolve inside this scratch root. Existing
ancestors are resolved for missing paths such as `console/node_modules`;
foreign paths, prefix lookalikes, traversal and symlink escapes do not qualify.
Explicit product boundary markers retain precedence and remain `FAIL [SAFETY]`.
Dependent cases preserve their prerequisite's harness classification.

Four new offline regressions exercise immutable copied modes, actual scratch
EACCES, npm stderr, cutover/prerequisite propagation, Git archive executable
bits, source preservation, skipped symlinks and foreign-path/safety controls.
The immutable-copy test creates console/node_modules, edits a copied regular
file, and removes/restores the copied compatibility blob while proving the
source bytes and modes remain unchanged.

`npm test` passed before the change: 465 pass, four explicit skips, zero failures
(54.9 seconds). It passed afterward with the same counts (58.9 seconds).
`node --test acceptance/test/*.test.mjs` passed all 55 tests with no skips or
failures (37.2 seconds) outside the outer sandbox. The initial outer-sandbox
attempt had 50 passes and five environment failures: scratch sockets could not
listen and nested sandbox-exec could not apply its profile. Its original log is
`/private/tmp/eng90-acceptance-tests.log`.

Both candidates use **Report readable backup and exact launch acceptance proof**,
the commit recorded in v0.1.4. At setup, canonical main was **Brief for ENG-90:
the harness runs against a release directory**, differing only by that brief.
To make this an exact commit comparison, a no-hardlinks bare clone under
`/private/tmp/eng90-main-source-c42nIX/repo.git` has its own main ref pinned to
the release commit. Shared Git refs remain untouched. The updated lane harness
tests these unchanged candidate versions.

Completed release command:

```sh
node acceptance/run.mjs \
  --candidate /Users/rewt/.local/share/herdr-monitor/releases/v0.1.4 \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

```text
Release acceptance: /Users/rewt/.local/share/herdr-monitor/releases/v0.1.4 (347s) — 24 pass / 0 fail / 0 pending — READY
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
Evidence: /private/tmp/herdr-acceptance-Q1RvIy/evidence (NN.jsonl; summary.json has reasons)
```

The release run exits 0. Cases 15 and 20 now pass, including actual offline
`npm ci` and negative-caller refusal, zero-caller removal, split-module routing
tests and exact blob restoration. SHA-256/mode/symlink manifests before and
after match across all 5,964 entries in the release tree. The comparison files
are `/private/tmp/eng90-release-before.json` and
`/private/tmp/eng90-release-after.json`.

Completed matching-main command (two model-free attempts):

```sh
node acceptance/run.mjs --candidate main \
  --source /private/tmp/eng90-main-source-c42nIX/repo.git \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm --skip-live
```

```text
Release acceptance: main (114s) — 22 pass / 0 fail / 2 pending — NOT READY
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
Evidence: /private/tmp/herdr-acceptance-ocGRUu/evidence (NN.jsonl; summary.json has reasons)
```

This result exits 1 because skipped discovery keeps the release gate closed.
The first mechanics attempt at `/private/tmp/herdr-acceptance-omazyz/evidence`
was 20 pass / 0 fail / 4 pending: native lookup could no longer find the owned
switched canary agent before the copied-cleanup precondition snapshot. It
rendered a harness error and propagated that cause to retirement. The single
retry shown above passes all 22 non-model checks. Both console build and
contrib retirement pass for directory and Git-archive candidates.

Automatic approval review rejected the main command without `--skip-live`,
stating: "the user did not explicitly authorize that payload and destination."
The identified risk is exporting repository-derived product content to an
external model destination during real discovery. An explicit approval question
was presented for four `gpt-5.6-luna` sessions at `low` effort through installed
Codex/OpenAI: two synthetic greeting changes, one routing question, and one
application of the scripted answer. It remains unanswered. No main discovery
session was launched, and no workaround performs that rejected action.

The release's four authorized sessions completed measured turns. Their usage
totals were 614,050 input tokens (536,064 cached input), 11,064 output tokens,
and 1,041 reported reasoning-output tokens. Cached input is included in input;
reasoning is an output subset. No currency estimate is inferred. Full prompts,
transcripts, source receipts, usage, numbered command logs, ownership receipts
and cleanup evidence stay under the three scratch evidence paths above. Only
summary.json and screen.txt for the release and final main mechanics attempt
are committed. All three completed attempts have empty credential-residue and
retained-discovery-root arrays, and closed their created workspaces.

No release, bch-cloak, shared lane configuration, operator bin, or foreign pane
was modified. Nothing was pushed or published. The report is checked with
read-only `record check`, then committed as **Report release snapshot proof and
pending main discovery approval**. The final action is `node lanes/lane.mjs
check`; its result is delivered at turn completion, after which this run stops.
