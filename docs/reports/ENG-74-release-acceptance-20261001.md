---
run: R-46
outcome: blocked
summary: |
  Added an explicit local release gate that snapshots a selected candidate, uses real Herdr/Git/record/release code with scripted PTY workers for mechanics, and runs three real Luna discovery sessions in pristine projects. Main passes the configured cycle but fails fresh-project record, routing and lane discovery; v0.1.3 also lacks the newer modules. Both remain not ready. Existing wrapper lookup fails in background scratch workspaces, housekeeping is blocked by an ungranted automatically created pane, and staged cutover behavioral coverage is incomplete. Evidence and every measured discovery attempt's token cost are retained. No live project or release was switched.
headline: Fresh projects do not discover the workflow, so both releases remain gated
blockers:
  - The original discovery environment exposed neighboring candidate policy files through find ..; its no-policy inference is withdrawn. R-50 isolates project parents and requires actual product-source attribution.
  - The original wrapper probe checked metadata immediately, so it did not rule out a startup race. R-50 waits up to 15 seconds before permitting wrapper execution; see its report for the bounded result.
  - Housekeeping reaches an automatically created scratch layout pane outside creation receipts; the safety boundary refuses inspection, so closure remains unproved.
  - Ten staged cutover behavioral canaries, their behavioral rollback, and the final compatibility retirement gate are not implemented; restoration of bytes and modes alone is insufficient.
proposals:
  - role: engineer
    title: Deliver project entry discovery and zero-setup record, lane and routing adoption
    why: An installed plugin must make entering agents find a small project policy identifying the installed CLI, canonical project record, own-lane isolation, check/rebase/fast-forward promotion, dispatch/watch and housekeeping defaults. Bootstrap must populate the record from actual work without user setup. Carry today's route preset in the product and ask for operator model preferences using an existing human-wait category such as other; never rely on tooling auto-answer. Add a bounded real-session Git execution path so promotion can be proved without removing sandbox protection.
  - role: engineer
    title: Complete real scratch cutover and housekeeping acceptance coverage
    why: Apply each of the ten proposed edits to scratch copies, execute the canary and the restored legacy behavior, verify tidy recovery, stable-name restart and missing-target refusal, and retire contrib only after zero callers. Worktree creation must provide isolated shell/layout options and reliable descendant receipts so the gate can exercise housekeeping without granting unknown panes. The current two pending cutover cases permanently prevent release approval.
  - role: engineer
    title: Make background workspace identity available to release callers
    why: R-52 waits for the copied-project shell cwd before polling identity for 15 seconds. The idle background workspace still lacks identity while main's active configured fixture carries it during the same poll. ENG-79 remains a real bounded background/activity publication gap, not the initial cwd race. Investigate that specific difference without focusing operator panes, synthesizing metadata or claiming indefinite absence.
learnings:
  - A fresh record defaults approvals.default and tooling to ask; this organization's tooling auto-answer is an override. Unknown categories are rejected, so model-routing cannot be used without new configuration. The existing other category waits and accepts a scripted human answer.
  - Explicit workspace and tab creation support scratch ZDOTDIR and HISTFILE overrides; a file written by zsh startup is a reliable receipt where a background pane screen can be empty.
  - Worktree creation does not expose those environment overrides and adds a reviewr pane after its initial topology receipt. The boundary refused that pane instead of widening permission.
  - Scripted workers need raw owned PTY prompt transport; Herdr rejects agent prompt to a foreground Node script even when report-agent publishes its lifecycle. This does not establish native harness prompt timing.
  - The live bch-cloak launcher now targets current/contrib rather than the canonical checkout path described in the inventory kit. Copies and checksums must come from live scripts each run.
artifacts:
  - "Commit: Add a scratch release acceptance gate with real discovery cases"
  - "Commit: Isolate scratch shell startup and exercise released housekeeping"
  - "Commit: Report scratch release acceptance and remaining gates"
  - acceptance/run.mjs
  - acceptance/herdr.mjs
  - acceptance/worker.mjs
  - acceptance/live.mjs
  - acceptance/live-worker.mjs
  - acceptance/test/boundary.test.mjs
  - acceptance/README.md
  - docs/reports/ENG-74-acceptance-evidence-20261001
  - "npm test: 313 passed, 0 failed, 1 explicit skip"
  - "npm run test:lanes: 146 passed, 0 failed"
  - "node --test acceptance/test/*.test.mjs: 3 passed"
  - "record check of this report, then report commit, then lane check as the last command"
decisions:
  - decision: Make pristine-project discovery the primary gate and keep configured mechanics and existing-project compatibility separate cases.
    why: Passing an explicitly configured fixture cannot prove a project needs no user setup. Real agents must discover policy and populate the record from their work.
  - decision: Use native ephemeral Codex sessions on gpt-5.6-luna low only for discovery, with no automatic model escalation.
    why: This was the cheapest declared workable route and completed the overlapping coding tasks. It can establish absence of discoverable policy without paying for the engineer route. All mechanics stay scripted and outside npm test.
  - decision: Keep pending cases and harness failures visible and make any failure or pending case exit 1.
    why: The acceptance kit is delivered but incomplete. The operator must not infer that either candidate is safe to switch from passing mechanics or byte restoration.
  - decision: Restrict control to opaque creation receipts and scratch paths, retaining native workspace-write protection.
    why: Unknown targets, symlink escapes, services and focus changes are denied. Shell readiness must be fixed within scratch rather than typing into an uncertain pane or bypassing sandbox protection.
questions: []
challenges:
  - premise: Scripted stand-in workers are enough.
    verdict: partly
    evidence: They prove record/dispatch/watch/Git/release mechanics and explicit blocked/idle/done transitions. They cannot prove policy discovery, native Codex/Claude screen detection, approval handling or interactive prompt timing. Three real cheapest-route sessions per full run expose the discovery failure; a later optional interactive canary remains useful.
  - premise: Real Herdr in tests is safe.
    verdict: partly
    evidence: The adapter denies foreign targets and paths, never focuses, filters lists, and closes only created workspaces. Three offline boundary tests and real denial probes pass. Herdr still writes its normal service logs, and default worktree layout creates an ungranted pane that blocks housekeeping. The boundary is not a separate Herdr server or an atomic compare-and-act API.
  - premise: The listed bch-cloak calls are all of them.
    verdict: wrong
    evidence: The copied scripts also reveal dispatch, notify, tidy, settle, stage, promotion queue and settle/review desk consumers. The durable call inventory retains their paths; PATH smoke checks do not prove the whole settle/review handoff.
  - premise: A usable configured cycle proves zero-setup project adoption.
    verdict: wrong
    evidence: Main completes the configured cycle while pristine status/add require record init, route loading requires a file, and the original discovery agents could list the neighboring candidate AGENTS.md and module policy files; this contaminated the no-policy inference.
---

R-50 correction: the original discovery projects exposed neighboring product
policy, real-session writable roots included the harness, and wrapper lookup
had no startup wait. Treat those findings as superseded by the R-50 isolated
rerun, not proof of valid discovery isolation. Historical counts below remain
the original observations. Raw evidence has been moved to scratch.

The gate is delivered, but acceptance remains blocked. Main is **NOT READY** with
13 passes, 7 failures and 2 pending cases; v0.1.3 is **NOT READY** with 7 passes,
4 failures and 11 pending cases. No activation, bch-cloak switch, push or publish
was performed. The latest supervisor brief supersedes the run context's original
no-model requirement for discovery only.

Run from Herdr with authenticated Codex and an existing offline npm cache:

```sh
node acceptance/run.mjs --candidate main \
  --bch-cloak /Users/rewt/development/bastian/bch-cloak \
  --npm-cache /Users/rewt/.npm
```

Use `--candidate v0.1.3` or a release directory for another candidate. The kit
snapshots the chosen revision before execution. The final full runs took 148s
and 126s respectively. A final no-model mechanics rerun took 54s and reproduced
the same mechanics results while retaining the housekeeping failure log. It is
explicitly not an approval run. `--skip-live` always leaves discovery pending.

The main snapshot is the commit **Report the live one-pass housekeeping guard
fix**; v0.1.3 is **Add the console-fold review, round 2 (PASS)**. The authoritative
updated ask is **ENG-74: agents discover the lane policy side by side, promote,
and ask the operator how to route models**. Machine-readable summaries retain
the resolved revision for reproduction.

One-screen results, reproduced verbatim:

```text
Release acceptance: main (148s) — 13 pass / 7 fail / 2 pending — NOT READY
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
FAIL    12 Housekeeping closes only eligible finished workers
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
Evidence: /private/tmp/herdr-acceptance-RRjqu2/evidence (NN.jsonl; summary.json has reasons)
```

```text
Release acceptance: v0.1.3 (126s) — 7 pass / 4 fail / 11 pending — NOT READY
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
Evidence: /private/tmp/herdr-acceptance-o5AW7m/evidence (NN.jsonl; summary.json has reasons)
```

Only candidate summary.json and screen.txt remain under
[ENG-74-acceptance-evidence-20261001](ENG-74-acceptance-evidence-20261001).
R-50 archived every formerly committed raw artifact, including the mechanics
rerun and cost ledger, under `/private/tmp/eng74-r46-evidence-archive-x3zjgyx3/ENG-74-acceptance-evidence-20261001`.
The temporary paths printed above also retain original raw evidence. All final created workspaces were closed and runtime
files and temporary authentication copies removed.

What an entering agent actually found

The two real sessions started together in one new Git repository with overlapping
French/German greeting tasks. There was no `.org`, `.lane.json`, routing file or
agent instruction file. Candidate `record`/`org` and `lane` were on PATH. The
prompts supplied only tasks, a scratch safety boundary and a request to identify
policy sources; they did not disclose lane policy, routing presets or setup steps.
Their isolated native CLI runtime excluded the operator's configuration and rules.
This tests the candidate CLIs available to a fresh agent; it does not activate an
installed plugin or prove plugin entry hooks on another host.

Both main agents reported reading the project README, but their find .. commands
also listed neighboring candidate/AGENTS.md and module README files. The claim
that this was an isolated no-policy environment is withdrawn. They reported
working on branch `main` in the same checkout, and producing no record IDs. Both
modified `greetings.mjs` and added tests there. They preserved the observed other
change, but shared-checkout editing already violates lane isolation. Neither
created a lane or followed promotion. Both attempted commits, which native
workspace-write protection refused at `.git/index.lock`; promotion therefore also
has an execution limit independent of missing discovery. We did not bypass it.
The full transcripts show what was read and executed, rather than interpreting a
scripted worker as discovery evidence.

The routing agent wrote `OPERATOR_QUESTION.md` in the main scratch project,
reported no workflow entrypoint, and created no record question. A Markdown
question has no record human-wait state or answer application. Thus the scripted
operator answer and subsequent real configuration application were **not reached**.
The v0.1.3 sessions exhibited the same missing record/policy behavior. A failed
prerequisite remains failed; the harness did not initialize their records for them.

The deterministic probes likewise show `record status` and `record add` refusing
without initialization, route resolution refusing without configuration, and
explicit org/run requirements on dispatch and watch. The dispatch probe does not
mean dispatch should launch without an item: it exposes the absence of an entry
contract that discovers or bootstraps the project and carries an ordinary task
through the default cycle.

A project should carry, or receive from the installed plugin on agent entry, a
small discoverable instruction source pointing to: the installed tools; canonical
record identity and lazy initialization; separate lanes for concurrent work;
clean check/rebase/validation/fast-forward promotion; and dispatch, watch and
housekeeping startup. The product must supply this without the user hand-writing
policy. Its packaged route preset must be discoverable so the agent can ask a
concrete preference question instead of inventing models.

Human-wait category proof

`/private/tmp/eng74-r46-evidence-archive-x3zjgyx3/ENG-74-acceptance-evidence-20261001/human-question-prerequisite.json`
records a separate scripted prerequisite using a newly initialized scratch record.
Both `approvals.default` and `tooling` are `ask` there. `other` is an existing
category with `ask`: a routing-preference question remained unanswered and blocked
its parent until a scripted `yes` was recorded. This is suitable today even where
`tooling` is overridden to auto-answer. A custom `model-routing` category was
rejected as unknown, so using it would itself require hand configuration. Do not
claim default fallback supports arbitrary category names. This proof establishes
the record primitive, not real-agent discovery or applied route configuration.

What mechanics prove, and what remains open

Main's explicitly configured fixture supplies a scratch record, lane config,
validation command, worktree root and scripted route. Real Herdr PTYs dispatch a
worker, record its occupant, arm a detached watcher, commit work, write/check and
ingest a report, deliver exactly one supervisor notice, validate and promote by
fast-forward, and close the lane. Dirty and red-validation promotion is refused
without moving main; there are no merge commits. Missing, invalid and blocked
workers produce the matching intermediate notice, stay watched and are not
ingested. A blocked report followed by a fix creates a new durable run on the same
worker and pane. Duplicate watcher startup is refused. The real `900`-second idle
grace stays quiet during an observed one-second interval and wakes on resume/report;
full 900-second expiry is not measured.

Scripts publish lifecycle states with `report-agent`; unseen idle becomes `done`.
Herdr refuses `agent prompt` to the foreground Node script, so the adapter uses
raw owned PTY text/Enter with a file acknowledgement. This covers transport and
coordination, not interactive harness recognition or prompt-dialog behavior.

Housekeeping is now present on main and absent in v0.1.3. The main probe dispatches,
ingests and promotes a done worker alongside blocked and needs-human reports,
then invokes the actual default-on one-pass module without a housekeeping config.
Herdr creates an additional `reviewr` pane after the worktree creation/topology
receipt. That pane has no grant: inspection is refused before housekeeping can
complete. This is a **harness coverage failure**, not evidence of a housekeeping
policy bug. Cleanup archives the blocked/needs-human lanes through the real CLI.
The later no-model rerun retains the action/error log in `mechanics-final`.

Existing-project and release evidence

Live bch-cloak scripts were copied afresh, with SHA-256 checksums and executable
modes preserved. The existing launcher now calls the installed `current/contrib`
path; the inventory kit's canonical-checkout description is stale. Only absolute
path constants and temporary destinations were relocated in scratch; route
choices and `--model`/`--effort` forwarding were retained. Actual routing tests and
invocation construction pass. The original immediate supervisor wrapper dry runs failed when
`workspace list` omitted canonical metadata for the new background workspace;
that check did not rule out an asynchronous startup race,
although `worktree list` resolves its repository. No metadata was synthesized and
no pane was focused to make the case green.

The copied close script consumes real `org status` from scratch PATH. The copied
apply-settle script runs actual `org add` and ingest, then deliberately stops at a
missing Draft section before review-desk dispatch. This is useful PATH compatibility
coverage; the full settle/review handoff remains unproved. Additional callers and
their paths are retained in `existing-call-inventory.txt`.

Candidate release scripts build immutable scratch releases, activate and reactivate,
roll back and restore, including an install whose old `before` state predates the
`record` launcher. Console dependencies also build with actual `npm ci --offline`
using copied cache indexes and lockfile tarballs. Plugin linking, launchd and Brain
service observation are excluded by the live-system boundary. The source npm cache
is read only.

All ten ENG-64 files are enumerated separately in `cutover-switches.json`:
launch-supervisor, continue, arm-watch, dispatch, tidy-tabs, session-start, SETTLE,
WORK-PATTERN, routing tests and notify-watch. Their exact byte/mode restoration is
executed. **The staged edits and their behavioral canaries/rollback are not yet
implemented.** Marker inspection cannot establish switch safety, and this runner
cannot approve a release until that coverage is completed. Supervisor restart and
missing-target preflight, tidy recovery, every notice fixture, the legacy rollback
canary and complete janitor closure remain open. Final contrib removal/restoration
is only a scratch blob probe; retirement stays pending while the copied launcher
still calls it. The actual compatibility file is unchanged.

Token cost

All real sessions used `gpt-5.6-luna`, effort `low`, completed the work or reported
its missing policy, and remained outside `npm test`. Measured CLI turn usage for
the final full runs is below. Cached input is a subset of input; reasoning output
is a subset of output and must not be added again. Billing rates were not measured.

| Candidate | Session | Input | Cached input | Output | Reasoning output |
| --- | --- | ---: | ---: | ---: | ---: |
| main | german | 65,799 | 57,856 | 1,171 | 196 |
| main | french | 106,698 | 93,952 | 2,172 | 526 |
| main | routing | 66,362 | 57,856 | 1,320 | 310 |
| v0.1.3 | french | 53,781 | 42,752 | 1,065 | 228 |
| v0.1.3 | german | 121,899 | 100,352 | 2,223 | 248 |
| v0.1.3 | routing | 178,257 | 143,872 | 1,931 | 480 |

Final main totals: **238,859 input / 4,663 output**. Final v0.1.3 totals:
**353,937 input / 5,219 output**. Debugging and reruns also cost tokens and are
included below and in `all-discovery-costs.json`, with every session separately.

| Scratch run | Candidate | Completed turns | Input | Output |
| --- | --- | ---: | ---: | ---: |
| herdr-acceptance-RRjqu2 | main | 3 | 238,859 | 4,663 |
| herdr-acceptance-hDy0St | main | 3 | 312,086 | 5,190 |
| herdr-acceptance-juKUQB | main | 3 | 187,014 | 3,782 |
| herdr-acceptance-o5AW7m | v0.1.3 | 3 | 353,937 | 5,219 |
| herdr-acceptance-tgJ9JT | v0.1.3 | 2 | 123,180 | 2,370 |
| herdr-acceptance-vNqvNj | main | 3 | 308,745 | 5,128 |
| herdr-acceptance-2VA548 | main | 3 | 179,492 | 2,632 |
| herdr-acceptance-PYmkIF | main | 3 | 244,198 | 4,868 |
| herdr-acceptance-bk6lU8 | main | 0 | 0 | 0 |
| herdr-acceptance-e0ddCY | v0.1.3 | 3 | 239,529 | 4,851 |

Total measured across all attempts: **2,187,040 input**, including **1,708,288
cached input**, and **38,703 output**, including **7,675 reasoning output**,
over **26 completed turns**. Three initial CLI startups failed before a measured
turn; one routing command was lost during shell startup and produced no usage
receipt. Missing usage is not assumed to be billed zero. The nested-sandbox
probe had completed turns but could not read the project and is not discovery
acceptance evidence. An unrestricted-inner-sandbox experiment was rejected by
automatic approval review before execution; the native workspace-write alternative
was used for the valid runs. Shell-startup retries were a harness cost, not product
failure evidence.

Safety, cleanup and validation

The adapter authorizes opaque creation/child topology receipts, verifies scratch
paths and live cwd, rejects foreign pane/workspace targets and symlink escapes,
forces no-focus and forbids services/plugins. Scripted launch requests cannot
invoke a model. Watcher PIDs come only from this scratch run's detach receipts or
dispatch journals. Cleanup closes only created workspaces; no operator or
supervisor pane is prompted, typed into or closed. Temporary mode-0600 auth copies
are deleted, including debug runs. The real Herdr service still writes its normal
logs; the kit does not claim zero operating-system/service side effects.

Baseline and final `npm test`: 314 tests, 313 passed, one explicit skip, zero
failures; final run 31.6s. The separate boundary suite passed all three tests.
`npm run test:lanes` passed all 146 tests in 324.2s. `git diff --check` passed.
Worktree creation lacks environment overrides for its initial shell/default
layout; strict isolation of that host startup is also unproved. That boundary
must be completed before the kit can approve a release. Core modules, stored
status and `contrib/settle-watch.mjs` were not changed.
The report is checked and committed, with `lane check` deliberately run last on
the clean committed lane. No further commands or edits follow that check.
