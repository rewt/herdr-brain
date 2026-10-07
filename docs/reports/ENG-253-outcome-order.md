---
run: R-291
outcome: done
summary: |
  Item outcomes now come from the newest started run with a recorded report, regardless of ingestion order. Older late reports retain their immutable copies and run.report fields and are marked late; abandoned-run ingestion remains skipped. Saved settle outcome-owner refusals are rechecked so the repaired fold can unblock the correction without weakening true supersession checks. All 43 focused offline tests passed. A read-only comparison of the live record changes only the out-of-order cases named below. Implementation and evidence are committed; this report is checked and committed before the final lane check.
headline: Newer reports keep ownership when older reports arrive late.
blockers: []
proposals: []
learnings:
  - Run start-event order, rather than timestamps or numeric run ids, determines report ownership; item.runs already preserves that order.
  - The live correction had an item.reopened event between the newer and older report ingests. Reopening clears the outcome until another report is ingested, which now selects the newest reported run again.
  - Older settle receipts cache outcome-owner refusals as completed escalations. Re-folding alone cannot resume those receipts; they need the narrow record-refusal recovery path.
artifacts:
  - 1653517 — fix(record) keep outcome with newest reported run
  - lane/outcome-order
  - lib/state.mjs
  - bin/org.mjs
  - test/flow.test.mjs
  - settle/settle.mjs
  - settle/test/record-safety.test.mjs
  - settle/test/record-recovery.test.mjs
  - settle/README.md
  - docs/reports/evidence/ENG-253/refold.mjs
  - docs/reports/evidence/ENG-253/live-refold.json
  - docs/reports/evidence/ENG-253/live-item.json
  - docs/reports/evidence/ENG-253/focused.tap
  - docs/reports/evidence/ENG-253/flow.tap
  - docs/reports/evidence/ENG-253/settle-sandbox.tap
  - docs/reports/ENG-253-outcome-order.md
  - /Users/rewt/development/rewt/.org/runs/R-291/report.md
decisions:
  - text: Select the newest started reported run on each report ingestion and preserve that report's outcome timestamp and sequence.
    category: design
    why: The requested ownership rule must work when a correction reports first, including the live reopen between ingests, without stored status or new event types.
  - text: Recheck saved outcome-owner refusals through the existing settle record-readiness recovery path.
    category: tooling
    why: The live correction already has a completed refusal receipt. Recovery repeats report, project identity, tree, readiness and actual run supersession checks while preserving prior evidence.
questions: []
challenges: []
---

The fold records every ingested report and selects the last reported entry in
the item's run-start order. Report ingestion order, clock skew and numeric run
ids cannot displace that owner. The chosen report supplies the outcome value,
run, ingestion timestamp and sequence. The fold also derives late markers for
historical out-of-order reports whose events did not carry them. New CLI ingests
persist the marker under the record lock and explain it correctly.

Abandonment is unchanged: the CLI still skips reports from abandoned runs,
frees their items and creates no immutable report copy. Existing historical
events containing accepted abandoned-run reports still fold. Reopen events
still clear outcomes; the next ingestion chooses the newest reported run.
No status storage, dependencies, model calls or new event types were added.

The regression tests cover in-order reports with an unreported active run,
all six ingestion permutations of three runs (including reversed numeric ids
and clock skew), retained report metadata, abandonment, historical accepted
abandoned reports, reopening and unknown-event compatibility with the frozen
older fold. A CLI regression proves immutable report retention, the event's
late marker, unchanged correction ownership and idempotent re-ingestion.
Settle regressions prove independent review can settle the correction after
the old report arrives, recover a legacy cached ownership refusal after main
moves, and refuse a genuinely newer run without review or worker dispatch.
The existing conditional-write and supersession safety cases also pass.

Development validation:

```sh
node test/helpers/run.mjs test/flow.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs
```

43 passed, 0 failed, 0 skipped. Evidence: focused.tap. The earlier standalone
flow run passed 17/17. An initial broader settle run hit sandbox-denied process
inspection during fixture cleanup and exposed a test assumption about the
existing refusal exit path. That assertion was corrected to recognize either
protected refusal path; the final isolated runner completed and cleaned up
successfully with process inspection available. Its earlier output is retained
in settle-sandbox.tap. The new ordering and cached-refusal regressions were
observed failing before their corresponding fixes. git diff --check passed.

Read-only live-record comparison:

```sh
ORG_DIR=/Users/rewt/development/rewt/.org node docs/reports/evidence/ENG-253/refold.mjs
ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs show ENG-242 --json
```

The comparison folds the same 3,681-event snapshot with the previous fold from
f84602d4 and the changed fold: 318 items and 291 runs. It asserts all other fold
fields remain equal and every changed outcome or late marker has an older
started run whose report was ingested after a newer run's report.

- ENG-242 alone changes outcome ownership: R-281 at sequence 3661 becomes
  R-284 at sequence 3658. Its outcome value and derived status remain done.
- ARCH-17 keeps its outcome; R-151 gains a late marker because R-162, R-167,
  R-174, R-178 and R-183 had reported before it was ingested.
- ENG-136 keeps its outcome; R-182 gains a late marker after R-189's report.
- ENG-242's R-281 gains a late marker after R-284's report.

Every other item outcome is unchanged. The comparison reads the record and
outputs evidence only; no live record event or settle receipt was modified.
Snapshot identity and the exact before/after outcomes are in live-refold.json;
the updated read-only item view is in live-item.json.

After this change lands, the supervisor can resume the saved R-284 settlement:

```sh
ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/settle/settle.mjs R-284 --repo /Users/rewt/development/rewt/herdr-brain --retry
```

This command now rechecks the repaired outcome owner and proceeds to the
independent review, subject to the existing record and clean-tree guards.
The offline fixture proves that recovery reaches promotable and does not
review twice. Live settlement is left to the supervisor after landing.

After record check and committing this report, the final command is:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/flow.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs'
```

The final committed-head result is retained in .lane/gate.json and its referenced
validation log. This report does not predeclare that result and remains unchanged
after the final command.
