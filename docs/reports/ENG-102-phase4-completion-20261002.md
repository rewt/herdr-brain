---
run: R-116
outcome: done
summary: |
  Audited Phase 4 and completed the modern console's project desk and routing controls.
  Added CLI-backed editing for review/fix routes, round cap, timeout, reuse and supervisor target,
  route/model additions, primary pool, task selections, dispatch defaults and always arguments.
  Saved before/after print renders against the current record and an unrelated fixture at three widths.
  The full offline suite is green; the report commit is followed by the exact-head lane gate.
headline: The console now exposes and steers project desks and routing settings
blockers: []
proposals: []
learnings:
  - "Settle replaces the inherited desk object as a whole; editing one field must preserve other effective fields."
  - "Adopting portable routes must retain existing lifecycle and desk settings in project config."
  - "Expected config revisions must include parent file bytes to detect desk changes that do not alter routing fields."
  - "The copied-product discovery probe must include settle because the record CLI now imports the desk command."
artifacts:
  - "commit: Complete console desk and routing controls through validating CLI commands"
  - "commit: Keep an unset primary pool unchanged when closing its review"
  - "commit: Record Phase 4 audit and console screen evidence"
  - "docs/reports/evidence/ENG-102/: 120 print renders plus the capture script"
  - "console/test/desks.test.mjs; settle/test/config.test.mjs"
  - "npm test -- --suite-timeout=540000: 701 tests, 690 pass, 11 skip, 0 fail"
  - "node test/helpers/run.mjs lanes/test/routes.test.mjs: 7 pass"
  - "final gate: ORG_ACTOR=lane-phase4-r116 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check"
decisions:
  - text: "Expose project settle and review defaults through a reviewed Desks screen and validating record desks command."
    category: design
    why: "The console lacked a way to inspect or steer the project's existing settle configuration."
  - text: "Use the shared canonical project config writer and expected revisions for every new routing and desk control."
    category: design
    why: "Concurrent editors must preserve tracked lifecycle settings and refuse stale confirmations."
  - text: "Keep supervisor cycle execution separate from project configuration editing."
    category: design
    why: "Changing defaults should affect future intake without launching work or replacing existing settlement receipts."
questions: []
challenges:
  - "The initial npm test run exceeded its six-minute suite bound; the supported finite nine-minute option passed the complete suite without disabling tests."
  - "Initial post-change regressions exposed a missing desk-reader mock and an incomplete copied-product snapshot; both were fixed and verified by targeted and full-suite reruns."
---

The implementation is committed as **Complete console desk and routing controls through validating CLI commands**. The no-op safeguard is committed as **Keep an unset primary pool unchanged when closing its review**. The report and screen evidence are committed as **Record Phase 4 audit and console screen evidence**.

## Phase 4 gap audit

| Goal or gap at intake | Result | Evidence / justification |
| --- | --- | --- |
| Decided / Asked / Waiting on you | Already covered; retained | Control and full histories expose structured decisions, automatic answers, recommendations, attribution and waiting questions; existing control-plane tests pass. The Control screen now puts every project-settings destination above the long histories. |
| Operator priorities, alignment and re-ranking | Already covered; retained | Existing Priorities editing uses record CLI with reasons and stale-review protection; Unaligned remains advisory. No priority was changed by this run. |
| Project settle/review desks absent | Closed | `S` opens Desks, including effective review routing, fix routing, round cap, timeout, stopped-worker reuse, notification target and config source. Enter edits, reviews before/after values, then saves via `record desks set`. |
| Desk defaults and precedence not visible | Closed | Desks shows unlimited cap 0, Moderate/Minor-only capping, item override precedence, command overrides and intake snapshots. Dynamic review selection names actual pool-to-route choices; a policy-free project shows the fallback review route. Blank edits remove one effective setting and use the built-in fallback, preserving the other inherited settings. |
| Existing routes editable, but adding a model/route absent | Closed | Routes has Add route/model; opaque name/kind/model/effort are reviewed and saved through `record routes add`. Duplicate/reserved names and invalid route shape are rejected. First route adoption preserves desk and lifecycle settings and keeps the complete portable preset. |
| Primary pool visible but not steerable | Closed | Routes has Change primary pool through `record routes policy`. Pool coverage must validate. Starting a policy preserves an existing default review route; review shows the resulting selections. |
| Task selection, dispatch defaults and always arguments read-only | Closed | Routes now edits/adds task selections, dispatch defaults and per-kind always arguments through validating `record routes policy/defaults/arguments`. Arguments remain arrays with exact token boundaries. Colon-containing opaque task identifiers survive navigation. |
| Save safety and project ownership for the new controls | Closed | All `.lane.json` controls share the existing lock/atomic writer. Expected revisions include parent file bytes; stale reviews retain their draft and preserve config. Lifecycle/extension fields survive. Linked worktrees target the canonical project, ambient LANE_CONFIG is ignored for project edits, and non-Git/record-only selections cannot save. `--print` cannot write. |
| Narrow screens and discoverability | Closed | Control links Priorities, Routes, Desks and Housekeeping at the top. Existing task policy rows are clickable. Edit/review screens render at 80/100/140 columns. Long policy confirmations support line/page scrolling before saving. |
| Per-item round-cap overrides and per-run retry controls | Justified outside the project-default editor | These are scoped work/recovery decisions rather than tracked project defaults. Existing `record set ITEM meta.settle_review_round_cap=N` and supervisor/settle retry commands remain authoritative; Desks explicitly explains their precedence. A project edit never rewrites an in-progress receipt or launches work. |
| Route-local environment/account settings and machine installation | Justified outside this editor | The frame keeps machine paths, profiles and accounts local. Existing inherited fields are preserved; this run exposes portable model/effort/route settings and launch argument arrays without introducing an account/credential editor. |
| Entry onboarding and promotion/schedule execution | Justified by module ownership and adjacent phase | Entry adoption is Phase 5 and ENG-100's separate ask. Promotion remains the supervisor's guarded queue. Housekeeping already exposes activity and pause/config steering; a stopped project schedule is started only by the canonical supervisor. The modern console remains an observe/steer surface, not a second cycle engine. |

## Screen evidence

`docs/reports/evidence/ENG-102/` holds actual `console/app.mjs --modern --print` output at **80x30, 100x40 and 140x48**, for the selected herdr-brain record and an unrelated, initially unconfigured Git fixture. The fixture has one durable decision and one waiting publish question; its canonical checkout sits outside any parent project configuration. A scripted Herdr binary returns empty topology, so capture never touches a live pane or changes focus. The record captures are read-only views of the actual record at capture time; other runs may change counts between captures.

Before/after existing screens: `control`, `routes`, `help`. Before `desks` shows the old overview reached by the then-unsupported `S` key; there was no desk screen or any of the new forms. After screens include `desks`, `desk-edit`, `desk-review`, `route-add`, `route-add-review`, `pool-edit`, `pool-review`, `defaults-edit`, `defaults-review`, `task-edit`, `task-review`, `arguments-edit`, and `arguments-review`. Every changed/new screen is present for both record and fixture at all three sizes.

Representative comparisons:

- [Control before, actual record](evidence/ENG-102/before-record-control-100x40.txt) → [Control after](evidence/ENG-102/after-record-control-100x40.txt): project steering is reachable without scrolling through route/history detail.
- [Routes before, actual record](evidence/ENG-102/before-record-routes-80x30.txt) → [Routes after](evidence/ENG-102/after-record-routes-80x30.txt): additions, primary pool, defaults and selections are visible at the narrow width.
- [Desk screen after, actual record](evidence/ENG-102/after-record-desks-80x30.txt): the unconfigured project has explicit built-in defaults and a canonical save target.
- [Fixture desk edit](evidence/ENG-102/after-fixture-desk-edit-80x30.txt) → [Fixture desk review](evidence/ENG-102/after-fixture-desk-review-80x30.txt): exact before/after settings, defaults and future-intake effect.
- [Fixture route addition review](evidence/ENG-102/after-fixture-route-add-review-80x30.txt), [pool review](evidence/ENG-102/after-fixture-pool-review-100x40.txt), [task review](evidence/ENG-102/after-fixture-task-review-100x40.txt), [dispatch review](evidence/ENG-102/after-fixture-defaults-review-100x40.txt), [always arguments review](evidence/ENG-102/after-fixture-arguments-review-100x40.txt).

The capture script is [render.mjs](evidence/ENG-102/render.mjs). Run it from the lane root with `after`; `before` captures require the original code at the intake commit. Its record/config reads target the actual selected project; all fixture setup and simulated transport are scratch-local. Print confirmation never saves a config or a record event.

## Verification

The initial `npm test` reached the existing runner's six-minute suite deadline while settle tests were still completing. The supported nine-minute suite bound changes only test duration and remains finite. The first full post-change run completed 700 tests with six failures, all traced to the new dependency integration: the abstract modern-console fixture did not mock the desk reader, and the probe's copied product omitted `settle/`, now imported by the record CLI. Those are fixed. Targeted reruns passed 47 modern/copied-product tests; the CLI/settle configuration run passed 11 tests, and the final desk/route run passed 6.

`npm test -- --suite-timeout=540000` completed **701 tests: 690 passed, 11 explicitly skipped, 0 failed**, exit 0 (333 seconds). The seven dependency-free route resolver tests also passed. The final no-op safeguard passed all six desk/route tests; the subsequent exact-head lane gate runs the full suite again.

The new tests exercise real Git projects and real record CLI children, not direct config-file mutation by the console. They prove every editable desk field, route additions, pool and task selection, dispatch defaults and always arguments; cancellation, no-op saves, stale parent edits, invalid references/values, symlink refusal, canonical-worktree targeting, record-only/non-Git refusal, inherited lifecycle/desk preservation, exact argument tokens, read-only print and scrolling before confirmation. A settle integration test reads the CLI-created settings into the actual intake receipt and completes independent scripted review, with no model call.

`record check` validates this R-116 report before its commit. The final command is `ORG_ACTOR=lane-phase4-r116 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check`; it runs the full offline suite for the final clean committed head and writes the runtime-only `.lane/gate.json`. The timeout override affects only the test harness bound and does not edit shared project configuration. The final gate result is reported with the handoff; this committed report cannot include its own subsequent gate hash without invalidating that exact-head gate.

No model, live Herdr transport, project-wide housekeeping start/loop, live canonical project config write, push, promotion, publication, release, harness setting or machine installation was performed. `contrib/settle-watch.mjs` is unchanged.
