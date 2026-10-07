**PASS**
Schema: lane-review/v1
Reviewed commit: ee06b4be25d06dbbe6393ab43aae36dc5c820888
Topic: outcome-order
Round: 1
Review ID: lr-e2feeb12b37ecca1fc09f6fb3539c034
Base branch: main
Base commit: f84602d410c3eef2bf5a5235dab68961f95dc00c

## Findings
- [Minor] settle/README.md:56 - The settle guide still says only that the newest reported run owns the outcome, without the reopen exception this correction round introduced, so a reader could expect a late older report after a reopen to hand the outcome back to the newest reported run, which is the exact behaviour R-291 rejected; Fix: extend the sentence to say a late older report never restores an outcome cleared by item.reopened, and only a report from the newest started reported run (including one arriving after the reopen) sets it again

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Acceptance item three (settling R-284 on ENG-242 succeeds after landing) is supported by the stated command, the offline recovery fixture, a read-only reading of the live R-284 settle receipt whose saved refusal reason matches the new recheck pattern, and the settle supersession and outcome-owner checks; the live settle command cannot run before landing and was not run.
- The live re-fold evidence files were inspected as committed text and their assertions read; the refold script was not executed under the zero-command budget.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
