---
run: R-120
outcome: done
summary: |
  Resolved both independent-review findings in the console's routing confirmations.
  New routes show effective model, effort and launch arguments after inheritance;
  always-argument replacements show the entered kind's actual captured arguments.
  Added regressions exercising confirmation and real record CLI saves, plus before/after
  print evidence for both changed screens against the actual record and an independent fixture.
headline: Routing confirmations now show effective launches and the arguments being replaced
blockers: []
proposals: []
learnings:
  - "A new route with blank model or effort inherits dispatch defaults; launch effort can also come from dispatch arguments."
  - "The generic always-arguments form must compare against the entered kind in the captured config, rather than its initially empty form."
artifacts:
  - "commit: Show effective route launches and actual argument replacements in console reviews"
  - "commit: Record corrected Phase 4 confirmations and validation"
  - "console/test/desks.test.mjs: two regressions fail before the fixes and pass afterward, using real record CLI saves"
  - "docs/reports/evidence/ENG-102-R120/: 24 before/after print renders and capture script"
  - "docs/reports/ENG-102-phase4-completion-r2-20261002.md"
  - "npm test before correction: 701 tests, 690 pass, 11 skip, zero failures"
  - "ORG_ACTOR=lane-phase4-r120 node test/helpers/run.mjs console/test/desks.test.mjs console/test/control-plane.test.mjs lanes/test/routes.test.mjs: 34 pass"
  - "final after-change gate: ORG_ACTOR=lane-phase4-r120 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check"
decisions:
  - text: "Resolve proposed new routes with the lane launch resolver before displaying their confirmation."
    category: design
    why: "The operator must see the same inherited model, effort and argument tokens that a future launch receives."
  - text: "Compare always-argument replacements with the selected kind's captured configuration."
    category: design
    why: "An existing kind's launch options must be shown before the operator confirms their replacement through the CLI."
questions: []
challenges: []
---

Both Moderate findings in [the independent review](../reviews/phase4-completion/14ef8f3-r1.md) are resolved by **Show effective route launches and actual argument replacements in console reviews**. The previous report is unchanged. Its [complete Phase 4 audit](ENG-102-phase4-completion-20261002.md) and 120 screen captures remain the evidence for the wider implementation; this run corrects the two misleading confirmations it exposed. The inherited validation log completed 701 tests with 690 pass, 11 skip and zero failures, so it contains no additional failing check to repair.

## Phase 4 gap audit after correction

| Goal or gap | Result | Evidence / justification |
| --- | --- | --- |
| Decided / Asked / Waiting on you | Covered; retained | Existing Control and history views and the offline control-plane suite. |
| Operator priorities and alignment | Covered; retained | Existing CLI-backed priority editing and advisory Unaligned work; the original audit and captures remain applicable. |
| Inspect and steer settle/review desks | Closed in the original run; retained | Desks exposes review/fix routes, round cap, timeout, reuse and supervisor target through `record desks set`. The desk regression suite remains green. |
| Add routes with truthful effective settings | Closed by this correction | Blank model/effort now resolve against the merged configuration, including portable defaults and argument-encoded effort; confirmation shows launch arguments with token boundaries. Tests compare the screen with actual launch resolution after `record routes add`. |
| Steer primary pool, task selection and dispatch defaults | Closed in the original run; retained | Existing reviewed `record routes policy/defaults` changes; covered by the desk/routing and control-plane suites. |
| Show the actual always-argument replacement | Closed by this correction | The entered kind's captured array is shown before the exact replacement; CLI-save assertions prove removal is intentional and other kinds survive. Re-entering unchanged arguments closes without a write. |
| Narrow-screen confirmation and safe writes | Covered; retained | Both changed confirmations have actual `--print` renders at 80/100/140 columns for record and fixture. Existing revision, canonical-project, cancellation and print safeguards remain exercised. |
| Per-item overrides and existing settlement receipts | Justified outside the project-default editor | As in the original audit, these are scoped work/recovery actions; project-default editing does not rewrite receipt snapshots or launch a cycle. |
| Machine/account configuration, onboarding and schedule execution | Justified outside this correction | The original scope and module ownership remain applicable. This change corrects portable project-setting confirmations and leaves machine configuration and execution to their existing modules. |

## Screen evidence

[The capture script](evidence/ENG-102-R120/render.mjs) runs the real `console/app.mjs --modern --print` interface with an empty scripted Herdr transport. It captures both changed confirmation screens against the actual herdr-brain record and a separate Git fixture at **80x30, 100x40 and 140x48**, before and after this correction: **24 renders**. The fixture's dispatch defaults include a model, effort and arguments; its configured always arguments have a value containing spaces. All fixture setup goes through the record CLI. The actual project's configuration and record are read only throughout capture.

- Route addition, actual record: [before](evidence/ENG-102-R120/before-record-route-add-review-80x30.txt) → [after](evidence/ENG-102-R120/after-record-route-add-review-80x30.txt). Blank model and effort previously appeared as harness defaults; they now show `gpt-6.1-sol`, `high` and inherited launch arguments.
- Route addition, fixture: [before](evidence/ENG-102-R120/before-fixture-route-add-review-100x40.txt) → [after](evidence/ENG-102-R120/after-fixture-route-add-review-100x40.txt). The confirmation includes both dispatch and always arguments, preserving their exact token boundaries.
- Always arguments, actual record: [before](evidence/ENG-102-R120/before-record-arguments-review-80x30.txt) → [after](evidence/ENG-102-R120/after-record-arguments-review-80x30.txt). Selecting the existing kind now shows its configured array being replaced by `[]`.
- Always arguments, fixture: [before](evidence/ENG-102-R120/before-fixture-arguments-review-80x30.txt) → [after](evidence/ENG-102-R120/after-fixture-arguments-review-80x30.txt). The argument removal is fully visible at the minimum width.

## Verification

The required before-change `npm test` passed **701 tests: 690 pass, 11 explicitly skipped, zero failures**, exit 0 (325 seconds). Full after-change validation runs through the final exact-head lane gate below, using the supported finite nine-minute suite bound. That command includes all core, console, module and integration tests; the separate route-resolver suite passed in the targeted run.

The two new tests were first run against the original settings code: six existing desk/routing tests passed, and both new tests failed at the misleading confirmations. After correction, all **34** tests across `console/test/desks.test.mjs`, `console/test/control-plane.test.mjs` and `lanes/test/routes.test.mjs` passed. The new coverage checks portable defaults, custom dispatch defaults, effort inferred from launch arguments, dispatch/always argument composition, persistence through real CLI children, omission of inherited fields from the saved route, the exact existing-array removal, retention of other kinds, selecting a different kind in the generic form and unchanged-array no-op saves. Tests use their own actor and bounded fixture commands; they never call a model.

The report is checked with `record check`, then committed as **Record corrected Phase 4 confirmations and validation**. The final command is `ORG_ACTOR=lane-phase4-r120 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check`, for the clean report commit. Its runtime gate identifies that exact head; the committed report cannot record its own subsequent gate hash. Main is checked before handoff and rebased if needed.

No model, live Herdr transport, project-wide housekeeping loop, shared project configuration edit, push, promotion, publication, release, harness setting or machine installation was performed. `contrib/settle-watch.mjs` is unchanged.
