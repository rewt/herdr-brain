**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: a93bd1d5e600bedd77d073cd95d1ab3b8095d900
Topic: train
Round: 2
Review ID: lr-3bacc0c6df96729d9983a8dbdf7e7d67
Base branch: main
Base commit: 31ed0c3a500b47c3825b6e181909572a14e79d4d

## Findings
- [Moderate] settle/settle.mjs:496 - With main moved after a capped settle, \`handle RUN --retry --fix-findings\` never reaches the fix-findings branch: recaptureMain runs first for the saved promotable\_with\_findings result, sets the stage to rebase, replays the lane and re-finishes promotable\_with\_findings with the same next hint, so the supervisor's explicit correction request is silently dropped (a replay conflict even turns it into a terminal escalation instead of a correction), and with the train landing batches while settles sit complete this is the routine state for capped reviews; Fix: skip recapture when \`--fix-findings\` is given because the correction run is settled separately as fix and dispatching already are, let the complete-stage readiness checks call \`unchanged({ movingMain: true })\` for that request, and add a test that moves main before \`--retry --fix-findings\` and asserts exactly one correction dispatch.
- [Minor] settle/settle.mjs:375 - Two incomplete stages still dead-end after main moves: at the record stage with the report not yet ingested, recaptureMain exempts the missing report but the replay's own readiness check here returns that the report is not recorded and recaptureMain escalates terminally, and at commit-review after a lost commit response line 219 expects the reviewed commit while HEAD is the review commit, so every retry throws that the lane HEAD moved; Fix: at the record stage store only the recapture target and replay after ingestion, at commit-review adopt the exact single review commit that the commit-review stage already validates, and add a moved-main retry test for each stage.
- [Minor] promote/promote.mjs:176 - finishBatchJob adds a failed report-to-main record note to the same warnings list that gates tab cleanup and \`lane close\`, so a transient record CLI failure while writing the velocity note leaves a promoted lane worktree and its tabs open exactly as if the lane had been edited after integration; Fix: report velocity-note failures as a separate warning that does not suppress cleanup, and gate cleanup and close only on the integration warnings returned by the train.
- [Minor] promote/train.mjs:112 - A lost fast-forward response is adopted only while main still equals the validated tip, but drain now runs later pending batches after suspending this one, so main can advance past that tip before the resume, the attempt is then marked stale and replanned, and lanes that were replayed are re-applied onto a main that already contains them, landing duplicate empty commits kept by \`--empty=keep\` after a redundant promotion-tier run; Fix: treat a validated attempt whose tip is an ancestor of main, checked with \`merge-base --is-ancestor\`, as integrated, and add a crash-after-fast-forward test in which another batch lands before the resume.

## Re-executed
```json
[]
```

## Non-claims
- No build, test, prepare, install or check command was run; the supplemental brief contains no Review run budget section, so the zero-command default applied.
- The inherited gate \`npm run test:fast\` with exit 0 is not a fresh test claim and does not include the settle, promote or supervisor suites.
- The committed R-161 and R-175 TAP evidence was read, not re-executed; the green R-175 log lists 26 passing tests whose names match the 19 promote train tests and 7 settle recapture tests at the reviewed commit.
- The three-lane red-batch bound is judged against the supervisor's recorded ENG-125 decision of 2026-10-03 accepting ordinary safe bisection (5, 5 or 3 promotion-tier runs), which withdraws the earlier two-extra-run criterion.
- All eight round-1 findings were checked against the reviewed code by static reading only, and each is addressed.

## Unverified
- The migrated assertions in promote/test/promote.test.mjs, settle/test/settle.test.mjs and the config, rebase, round-cap and validation-tiers tests, and the unmodified supervisor promotion tests that now run through the train, were not executed; their agreement with the code rests on static reading only under the zero-command budget.
- How arbitrary project tooling behaves when the promotion tier runs in a scratch worktree nested inside the canonical checkout's Git common directory, where upward module and config resolution reaches the canonical checkout, was not examined beyond confirming that this project's canonical checkout has no root node\_modules.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
