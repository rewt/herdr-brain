---
run: R-243
outcome: done
summary: |
  Intermediate and unknown notices now bypass record authority checks and reach the supervisor unchanged.
  Classification failures retain the original payload and keep diagnostics in receipts, including on replay after record recovery.
  Added missing, unreadable and malformed record regressions and promoted the autopilot test file into CI coverage.
  All 104 focused checks passed; recovery and tier-selection checks also passed. The final lane check follows this report commit.
headline: Intermediate notices preserve their text and notice ID even when the record cannot be read
blockers: []
proposals: []
learnings:
  - "Intermediate notice delivery needs no record or status projection. Checking mutation authority before recognising these notices can turn a missing record into a changed supervisor payload."
  - "The autopilot test file was release-only; it now runs in the promotion tier, protected by the tier-selection test."
  - "The macOS workspace sandbox rejected filesystem notifications with EMFILE. The requested offline checks passed outside that sandbox without modifying the watcher tests."
artifacts:
  - "Implementation and evidence commit: 551c061 (Preserve intermediate autopilot notices byte-for-byte)"
  - "Branch: lane/notice-passthrough"
  - "supervisor/autopilot.mjs; supervisor/test/autopilot.test.mjs; test/helpers/tier.mjs; test/tier-plan.test.mjs"
  - "docs/reports/evidence/ENG-189: failing regressions, passing focused checks, recovery checks and tier-selection checks"
  - "Report: docs/reports/ENG-189-notice-passthrough-20261004.md"
  - "Report validation: ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs check docs/reports/ENG-189-notice-passthrough-20261004.md"
  - "Final command after report commit: node lanes/lane.mjs check; .lane/gate.json records the final committed head and validation outcome."
decisions:
  - text: Classify intermediate notices before mutation authority checks and deliver the original payload on classification errors.
    category: design
    why: Delivery must preserve text and transport identity independently of record availability; only recognised actionable notices require mutation authority.
  - text: Include the complete autopilot test file in the promotion tier and assert that selection.
    category: prover
    why: The new regressions must catch payload changes before merge while retaining the existing policy and offline lifecycle coverage.
questions: []
challenges:
  - "The cited 7fd492d commit changes console and status derivation, not autopilot or inbox delivery. The reproduced fault is in the existing authority-before-unrecognised-notice path; the fix stays in that path."
---

The autopilot now returns the exact original intermediate or unknown notice as
its delivery summary. It records the reason in its action receipt and invokes no
mutation command. This covers watch-long-running, watch-blocked, watch-no-report,
watch-invalid-report, watch-unavailable and unknown notice types, preserving
repeated spaces, newlines and trailing spaces.

The existing inbox transport adds its owned notice ID as usual. A new offline
delivery regression deletes events.jsonl and checks the complete delivered
long-running notice, including that ID. The unchanged watcher regression proves
the same payload and ID survive caps, elapsed minutes and watcher restarts.

Recognised notices whose record or queue cannot be classified also retain their
original payload. Errors remain in the action receipt; a replay after record
recovery preserves the payload from the failed attempt. A locked, damaged or
misbound action receipt remains untouched, with its diagnostic retained in the
policy result that the inbox journals. Classified report exceptions still carry
the existing policy explanation, and the existing mutation guards remain intact.

Validation:

- Before the fix, eight targeted regressions failed, including the missing-record
  long-running delivery case.
- `node test/helpers/run.mjs watch/test/watch.test.mjs supervisor/test/autopilot.test.mjs supervisor/test/status.test.mjs test/tier-plan.test.mjs`:
  104 passed, zero failures or skips outside the macOS workspace sandbox.
- After adding replay assertions, the three missing/unreadable/malformed-record
  recovery cases passed. The strengthened tier-selection test also passed.
- `git diff --check` passed before the implementation commit.

The initial sandboxed focused run failed seven filesystem-watch cases with
EMFILE and exposed one promotion assertion that still expected diagnostics in
the delivered payload. The promotion assertion now verifies unchanged delivery
and checks the classification reason in the receipt. No watcher test was changed.

The final default lane check runs after this report is checked and committed.
Its result belongs to the lane validation receipt for the final committed tree.
