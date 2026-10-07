---
run: R-289
outcome: done
summary: |
  Added a supported external-dispatch launch recorder and an atomic record worker transaction; Monitor dispatch uses the same transaction. The scratch cutover calls the recorder before watch and routes one-shot cleanup through the shared identity checks. The switched-copy housekeeping dry run selects only the settled merged worker and preserves six unsettled or legacy tabs. Adoption documentation explains canonical-supervisor startup and manual cleanup of the old backlog. Changed-path tests and dispatch recovery pass; the wider offline acceptance run exposes two unrelated native-fixture failures described below.
headline: Existing dispatchers can record workers at launch so housekeeping can safely clean up
blockers: []
proposals:
  - role: engineer
    capability: tooling
    title: Keep native offline discovery promotion inside the fixture test slot
    why: acceptance/test/live-session.test.mjs loses the isolated slot when sessionEnv constructs the native worker environment; the offline fixture tried to use the actual bch-cloak host slot and failed with TEST_SLOT_HELD. Preserve the slot protocol across that test transport without weakening production confinement.
  - role: engineer
    capability: tooling
    title: Diagnose native sandbox exit 125 after green offline validation
    why: acceptance/test/validation.test.mjs reports sandboxed validation exited 125 after both inner tests pass. The same case fails when run alone, preventing the wider offline acceptance suite from being green; investigate the native transport exit and retain confinement checks.
learnings: []
artifacts:
  - fea7b42de3c9674bbb7a06e949b2c1295f6baad1
  - dispatch/record-worker.mjs
  - acceptance/test/cutover-housekeeping.test.mjs
  - docs/ADOPTING.md
  - docs/reports/evidence/R-289/dispatch.tap
  - docs/reports/evidence/R-289/acceptance-offline.tap
  - docs/reports/evidence/R-289/switched-housekeeping.jsonl
  - docs/reports/evidence/R-289/native-validation-retry.tap
  - docs/reports/evidence/R-289/focused-before-recovery-fix.tap
decisions:
  - text: Record verified launcher receipts through a dedicated atomic record worker command shared by Monitor and external launchers.
    category: design
    why: The event-log lock can reject conflicting launch fields and exact retries can remain idempotent; the core stays model-free and no session registry supplies authorization.
  - text: Delegate the switched one-shot cleanup to the existing shared tidy helper.
    category: design
    why: Its existing occupant, record, topology and final-observation checks preserve legacy tabs rather than letting the old name-only shell filter bypass missing launch evidence.
questions: []
challenges: []
---

Implementation and safety:

- External launchers call `node /path/to/monitor/dispatch/record-worker.mjs R-n --org DIR --agent NAME --pane PANE --cwd WORKTREE` immediately after launch, before arming watch. Optional workspace/terminal/session pins from the launch response must match. It reads the named launched Herdr occupant directly, verifies name/pane/cwd, and records workspace plus every available immutable occupant identity through the record CLI with argument arrays.
- `record worker` checks cwd against the run's recorded workspace under the event-log transaction. It refuses mismatches, missing occupant identity, settled-run backfill and a name owned by a newer run. Exact retries append nothing and cannot enrich an existing complete receipt. An explicitly authorized dispatch recovery can still select an older run from ambiguous start results; unrelated newer runs do not forbid a fresh launch for that recovered run.
- No registry backfill, new stored status, inferred old launch identity, dependency or event type was introduced. The live bch-cloak scripts and panes were not changed. No housekeeping loop, live acceptance harness or model was started.

Verification:

- `TMPDIR=/private/tmp node test/helpers/run.mjs dispatch/test/dispatch.test.mjs`: 37/37 passed on final code, including explicit recovery, reuse, occupant replacement and watcher startup.
- All 18 launch-recorder and cutover tests passed within the full offline run. The switched copy executes its actual generated dispatch.sh against scripted lane/Herdr launch responses and a real scratch Git repository/record. The strict cleanup scan plans exactly one close: the idle, reported worker on a merged lane. It keeps blocked, needs_human, open, working, unmerged and legacy workers. The per-tick finished-tab policy also previews the reported unmerged tab, as designed; the slower strict settled-lane pass preserves it. No tab mutation occurred.
- All 23 housekeeping auto-tidy tests passed in the focused run. That run initially had one dispatch recovery failure caused by an overly broad superseded-run restriction; the restriction was removed and the complete dispatch suite then passed. The retained initial TAP makes that correction auditable.
- `TMPDIR=/private/tmp node test/helpers/run.mjs acceptance/test/*.test.mjs dispatch/test/record-worker.test.mjs`: 222/224 passed. Native discovery hit a host slot held by an unrelated bch-cloak worker; native validation returned exit 125 after its two inner tests passed. A targeted native-validation retry reproduced exit 125. Both failures are in unchanged native test paths, and are proposed as follow-on work. The narrower acceptance promotion-file tier also passed 62/62. No acceptance/run.mjs pass was used.
- `git diff --check` passed before implementation commit.

The report is copied to the requested record path and checked with `record check`, then committed in the lane. The final handoff command is `node lanes/lane.mjs check` after that report commit, so its receipt names the exact final clean head. The supervisor retains review, promotion and the canonical housekeeping start.
