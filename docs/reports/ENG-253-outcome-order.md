---
run: R-296
outcome: done
summary: |
  Corrected both review findings. Older late reports now retain their report fields and late marker without restoring an outcome cleared by reopen. The console explains late reports as arriving after a newer run had reported, while historical abandoned runs keep their original wording. All 67 focused offline tests passed. The read-only live re-fold leaves ENG-242 with no outcome owner and status ready, preserving its pending-review reopen. Implementation and evidence are committed; this report is checked and committed before the final lane check.
headline: Late older reports now preserve reopened work.
blockers: []
proposals: []
learnings:
  - A late older report must leave item.outcome untouched, including null after item.reopened; recomputing the newest reported outcome would undo the reopen.
  - ENG-242 has no outcome owner after the corrected fold and remains ready; R-284 retains its done report, and its pending independent review can resume after landing.
  - Console report rows need the actual run abandonment flag because report.late now also identifies reports ingested after a newer run reported.
artifacts:
  - 69c5160 — fix(record) preserve reopens when older reports arrive late
  - lane/outcome-order
  - lib/state.mjs
  - lib/today.mjs
  - console/lib/model.mjs
  - test/flow.test.mjs
  - test/today.test.mjs
  - console/test/model.test.mjs
  - settle/test/record-safety.test.mjs
  - settle/test/record-recovery.test.mjs
  - docs/reports/evidence/ENG-253/refold.mjs
  - docs/reports/evidence/ENG-253/live-refold.json
  - docs/reports/evidence/ENG-253/live-item.json
  - docs/reports/evidence/ENG-253/fix1-focused.tap
  - docs/reports/evidence/ENG-253/fix1-main.tap
  - docs/reports/evidence/ENG-253/fix1-sandbox.tap
  - docs/reports/ENG-253-outcome-order.md
  - /Users/rewt/development/rewt/.org/runs/R-296/report.md
  - .lane/gate.json
decisions:
  - text: Assign the item outcome only when the ingested report belongs to the newest started reported run; older late reports leave it untouched.
    category: design
    why: Preserves reopen as newer evidence while allowing a newer run's own arriving report to set the outcome, without stored status or new events.
  - text: Carry the actual abandonment flag into the console read model and use it for abandoned-run wording.
    category: design
    why: The late flag now covers out-of-order reports from runs that were never abandoned.
questions: []
challenges: []
---

Correction round 1 addresses both findings in the R-291 review at
`.lane/reviews/outcome-order/d83e562-r1.md` in the canonical checkout.

The fold records an older report and derives its late marker, but leaves the
item outcome alone. A reopen therefore stays in effect when the late report
arrives. A report from a newer run started after the reopen can set the outcome
again; the newest run's own arriving report can also do so when it started before
the reopen. Report timestamps and numeric run IDs still do not determine ownership.
Abandoned-run ingestion and unknown-event handling remain unchanged.

The console now says `(late: a newer run had already reported)`. The read model
also supplies the run's real abandonment flag so historical reports from
abandoned runs retain `(reported after the run was given up)`.

Validation:

```sh
node test/helpers/run.mjs test/flow.test.mjs test/today.test.mjs console/test/model.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs
```

67 passed, 0 failed, 0 skipped (`fix1-focused.tap`). The changed reopen assertions
failed against the previous lane implementation before the fix. Coverage includes
reopen -> late older report -> newer run report, the newest run's own report
arriving after reopen, late/abandoned console wording, and settle correction and
cached-refusal recovery without an extra masking reopen. All existing ordering,
CLI, abandonment and supersession cases in those files passed. `git diff --check`
passed.

Before editing tests, four relevant unmodified tests from main were run in an
isolated archive and passed (`fix1-main.tap`): conditional reopen, plain console
wording, and both today JSON cases. The correction changes the lane's explicitly
reviewed stale-after-reopen expectation; no existing main assertion was weakened.
An initial sandbox run passed 63 cases but failed four existing settle fixture
ownership checks (`fix1-sandbox.tap`). Process inspection was denied by the sandbox.
The exact surviving offline inbox process was identity-checked and stopped, and
the focused suite then passed with process inspection available and no surviving
fixture reported. No promotion, release, broad baseline or live acceptance suite
was run.

Read-only live-record comparison:

```sh
ORG_DIR=/Users/rewt/development/rewt/.org node docs/reports/evidence/ENG-253/refold.mjs
ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs show ENG-242 --json
```

The comparison folds the same 3,748-event snapshot with the previous fold from
f84602d4 and the corrected fold: 321 items and 296 runs. Snapshot SHA-256 is
`7d0e856823171d5b3e8523863e4626fd74626c19f6e4e77c3a21dc492649c3e2`.

- ENG-242 has **no outcome owner** (`outcome: null`) and derived status **ready**.
  Its reopen at sequence 3659 survives the late R-281 ingest at sequence 3661.
  R-284's done report remains recorded at sequence 3658, awaiting independent review.
  The previous fold gave R-281 the outcome and derived status done.
- ARCH-17 and ENG-136 keep their outcomes; R-151 and R-182 gain late markers.
- ENG-242's R-281 gains a late marker because R-284 had already reported.

Every other item outcome and every other fold field is unchanged. The comparison
now verifies the intervening reopen for a cleared outcome as well as the older
start and out-of-order ingestion evidence. Exact results are in `live-refold.json`
and `live-item.json`. No live record event or settle receipt was changed.

After this change lands, the supervisor can resume R-284 settlement with:

```sh
ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/settle/settle.mjs R-284 --repo /Users/rewt/development/rewt/herdr-brain --retry
```

The offline recovery fixture reaches promotable while preserving the reopened
outcome and refusing genuine supersession. Live settlement is left to the
supervisor after landing; this run performed the requested read-only re-fold.

After checking and committing this report, the final command is:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/flow.test.mjs test/today.test.mjs console/test/model.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs'
```

The final committed-head result is recorded in `.lane/gate.json` and its referenced
validation log. This report does not predeclare that result and remains unchanged
after the final command.
