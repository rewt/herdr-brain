---
run: R-48
outcome: done
summary: |
  Fixed the remaining Minor from the passing round-two review. Every non-dry-run CLI mode now checks stable script/record-CLI provenance and a canonical target before state writes or Herdr actions, including --once. Linked-script and linked-target refusal tests now cover --once, --loop and --start. Live one-pass tests use installed copies in disposable canonical checkouts, while linked-checkout discovery and --once --dry-run previews remain supported. The full offline suite passes; no real panes or production schedules were changed.
headline: Every live housekeeping pass now requires stable code and a canonical target
blockers: []
proposals: []
learnings:
  - "A single live housekeeping tick can close tabs and send input, so --once needs the same runtime provenance and target protections as --start and --loop."
artifacts:
  - "Commit: Guard every live housekeeping mode"
  - "housekeeping/housekeeping.mjs and housekeeping/README.md"
  - "housekeeping/test/housekeeping.test.mjs"
  - "docs/reviews/housekeeping/5a6d8c5-r2.md preserved unchanged as review evidence"
  - "Baseline npm test: 368 passed, 0 failed, 1 explicit skip"
  - "Focused housekeeping tests: 56 passed, 0 failed"
  - "After-change npm test: 371 passed, 0 failed, 1 explicit skip"
  - "git diff --check passed; final lane check runs after this report commit"
decisions:
  - decision: Gate every non-dry-run CLI mode with the existing stable-runtime and canonical-target checks.
    why: The safety boundary follows whether a command can act on live panes, including a one-pass invocation. Dry-run previews retain unrestricted linked-worktree source and target discovery.
questions: []
challenges:
  - premise: A live --once invocation can safely bypass the protections required by a long-running schedule.
    verdict: wrong
    evidence: One tick can close a tab or prompt a worker with removable, unreviewed lane code. The guard now depends only on whether --dry-run is set, covering every validated mode.
---

## Review finding result

**Minor — live one-pass guard bypass: fixed.** The CLI now applies
`requireStableRuntime` to the resolved script and record CLI, and checks the target
checkout, for every non-dry-run mode: `--once`, `--loop` and `--start`. Guard failure
still occurs before state creation, locking, scheduler launch or Herdr calls.
The target-refusal message now says to run live housekeeping from the canonical
checkout rather than referring only to startup.

The two existing refusal test families now include `--once`: linked script with
canonical target, and canonical script with linked target. Live one-pass tests use
copies installed into disposable canonical checkouts, including no-configuration
record discovery and no-record/no-project no-ops. The previous linked-discovery
case now runs as a dry-run preview alongside a live canonical case. The separate
test with both linked source and linked target continues to prove
`--once --dry-run` is permitted. All CLI fixtures use fake Herdr and record
executables, so lane check can run from this linked worktree without live actions.

The fix is committed as **Guard every live housekeeping mode**. The supplied
passing review is retained unchanged and committed with this report as evidence.

## Verification and use here

Before edits, `npm test` passed **368 tests with one explicit skip**. The focused
housekeeping suite passed all **56 tests**. After the change, `npm test` passed
**371 tests with one explicit skip**. `git diff --check` passed. Tests are offline
and make no model calls.

After review and promotion, the supervisor starts housekeeping from the canonical
checkout with `node housekeeping/housekeeping.mjs --start`, using canonical code
or an installed plugin/release. A live `--once` uses those same requirements.
Lane workers use `--once --dry-run --state-dir "$PWD/.lane/housekeeping-preview"`.
Defaults and optional configuration are unchanged. This run did not modify real
panes, production schedules, shared lane configuration, bch-cloak, releases,
launchd or local binaries.

The report is checked with `record check` and committed. `node lanes/lane.mjs
check` runs last on the clean final lane HEAD and writes the gate result to
ignored `.lane/gate.json`. Existing follow-ups ENG-75 and ENG-76 remain in the
record; no duplicate proposals were added.
