# R-416 verification

Source: 016c624b025379107127304cec2c361b5a10407a; start: 99666f45.

The complete covering set contains 89 files: 1436 tests, 1435 passes, 0 failures, 1 skips and 0 cancellations. Every final runner exited zero, including its native process audit. The sole skip is the native workspace check, which requires explicit opt-in with `LANE_HERDR_WORKSPACE_TEST=1`; no live check was requested.

Each full file used `node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 FILE`. One file per invocation gives exact per-file totals; at most four files ran concurrently. `lanes/test/lane.test.mjs` ran alone. Rechecks after product corrections carry `.final` suffixes; the shared settle fixture consumers carry `.transport-confirmed.tap`. The full retirement check resumed in batch 63 after all product repairs retains its generic `.tap` name.

The inventory scans all test files for literal imports and script paths to every lane-changed or brief-named module, also following test helpers. All offline acceptance tests are included after the focus fixture update. The broader basename scan found no omitted direct references. `coverage.json` records the reasons and suggested grouping; `verification.json` binds the final logs by SHA-256. `attempts.jsonl` records actual invocations and earlier outcomes; the table counts only the latest outcome for each file.

Earlier evidence is retained: the original three assertions failed before the fixes; unchanged no-focus and focus-harness assertions passed on main before their fixture/check relocation. The unchanged completion recovery and dirty-recovery assertions passed on main. The new stale-reference control failed before and passed after its product fix. The six replacement-recovery cases passed after the checkpoint-order fix. A conformance attempt passed assertions but failed the process audit; its retries are retained separately. The supervisor-interrupted completion attempt is not counted as a pass.

The conformance audit failure also reproduced unchanged on main. Its fixture now waits, within a deadline, for orphaned native guards scoped to its own FIFO and executable. The strict runner audit and all assertions remain intact. Its three consumers passed together (20 tests) and individually after the repair.

The shared settle transport now supplies complete empty tab/pane lists and models reviewer/correction clients as owned by their actual foreground lane-review/dispatch processes (PID and kernel birth, including proxy ancestors). Registrations remain available through delivery verification; successful responses acquire that finite lifetime, while uncertain delivery stays registered for recovery. Only a proven exited client disappears from the live list. Fixture teardown also awaits its pinned finite queue process after the empty-queue handoff. Original test assertions are unchanged. The 22 helper consumers were all rechecked; `transport-consumers.json` lists them. The unchanged validation-tier, autopilot and correction-cycle cleanup assertions passed on main before their fixture migrations.

The host-envelope timeout assertion also failed unchanged on main. Native receipt evidence shows SIGTERM interrupting preparation while the host records its timeout. The queue now classifies only that last signaled preparation as timed out, preserving earlier results and ordinary preparation refusals. Three native controls passed, including the original oracle. The final set was collected incrementally; `post-timeout-checks.json` lists the 12 promotion/host/CLI/retirement consumers rechecked after this last repair, with `.timeout-final.tap` logs. Passing evidence for unaffected paths is retained.

The deadline fixture now returns valid Git worktree-list output, preserving its timeout/refusal assertions. The unchanged assertion passed on main before its mock was repaired. Watchdog fixtures requiring real native process groups run in the existing fixed native-deadline entrypoint, retaining their original group, slot, receipt, timing and history assertions. Every potentially detached Node generation receives the unchanged six-second kernel alarm, and teardown waits for root-scoped descendants. The three original group failures and the identity-injection child leak reproduced unchanged on main. The unknown-escaped-identity control uses an existing bounded worker and witnesses its actual group KILL. Strict containment for ordinary fixtures and the native process audit are unchanged; the full watchdog file passes 32 assertions and its audit. The existing inbox and fixture-lifetime consumers were also rechecked after the fixed-entrypoint extension.

The acceptance fixture supplies the approved ingestion, Git, process and launch-identity evidence without changing either original focus oracle, and adds a missing-ingestion negative. This delta requires full independent review under L-6; these engineer checks do not provide a review PASS. No live cleanup, model call, release, integration or project-wide test script was run. Trailing horizontal whitespace in copied logs was normalized for Git whitespace checks; diagnostics and outcomes are otherwise preserved.

| File | Tests | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| [acceptance/test/harness.test.mjs](logs/acceptance__test__harness.test.mjs.final.tap) | 9 | 9 | 0 | 0 |
| [acceptance/test/recovery.test.mjs](logs/acceptance__test__recovery.test.mjs.final.tap) | 15 | 15 | 0 | 0 |
| [acceptance/test/snapshot.test.mjs](logs/acceptance__test__snapshot.test.mjs.final.tap) | 6 | 6 | 0 | 0 |
| [discovery/test/lessons.test.mjs](logs/discovery__test__lessons.test.mjs.final.tap) | 2 | 2 | 0 | 0 |
| [dispatch/test/dispatch.test.mjs](logs/dispatch__test__dispatch.test.mjs.final.tap) | 41 | 41 | 0 | 0 |
| [dispatch/test/record-worker.test.mjs](logs/dispatch__test__record-worker.test.mjs.final.tap) | 6 | 6 | 0 | 0 |
| [dispatch/test/timing.test.mjs](logs/dispatch__test__timing.test.mjs.final.tap) | 11 | 11 | 0 | 0 |
| [housekeeping/test/auto-tidy.test.mjs](logs/housekeeping__test__auto-tidy.test.mjs.final.tap) | 20 | 20 | 0 | 0 |
| [housekeeping/test/housekeeping.test.mjs](logs/housekeeping__test__housekeeping.test.mjs.final.tap) | 63 | 63 | 0 | 0 |
| [lanes/test/lane.test.mjs](logs/lanes__test__lane.test.mjs.final.tap) | 150 | 150 | 0 | 0 |
| [lanes/test/no-focus.test.mjs](logs/lanes__test__no-focus.test.mjs.final.tap) | 2 | 2 | 0 | 0 |
| [lanes/test/validation.test.mjs](logs/lanes__test__validation.test.mjs.final.tap) | 19 | 19 | 0 | 0 |
| [lanes/test/workspace-native.test.mjs](logs/lanes__test__workspace-native.test.mjs.final.tap) | 1 | 0 | 0 | 1 |
| [promote/test/affected-tests.test.mjs](logs/promote__test__affected-tests.test.mjs.final.tap) | 8 | 8 | 0 | 0 |
| [promote/test/completion.test.mjs](logs/promote__test__completion.test.mjs.timeout-final.tap) | 58 | 58 | 0 | 0 |
| [promote/test/conformance.test.mjs](logs/promote__test__conformance.test.mjs.final.attempt2.tap) | 12 | 12 | 0 | 0 |
| [promote/test/memory-gate.test.mjs](logs/promote__test__memory-gate.test.mjs.final.tap) | 3 | 3 | 0 | 0 |
| [promote/test/metrics-profile.test.mjs](logs/promote__test__metrics-profile.test.mjs.final.tap) | 1 | 1 | 0 | 0 |
| [promote/test/metrics.test.mjs](logs/promote__test__metrics.test.mjs.final.tap) | 23 | 23 | 0 | 0 |
| [promote/test/promote.test.mjs](logs/promote__test__promote.test.mjs.timeout-final.tap) | 30 | 30 | 0 | 0 |
| [promote/test/train.test.mjs](logs/promote__test__train.test.mjs.timeout-final.tap) | 51 | 51 | 0 | 0 |
| [promote/test/wait-timing.test.mjs](logs/promote__test__wait-timing.test.mjs.final.tap) | 7 | 7 | 0 | 0 |
| [promote/test/workflow-train.test.mjs](logs/promote__test__workflow-train.test.mjs.timeout-final.tap) | 4 | 4 | 0 | 0 |
| [settle/test/config.test.mjs](logs/settle__test__config.test.mjs.transport-confirmed.tap) | 6 | 6 | 0 | 0 |
| [settle/test/fleet-isolation.test.mjs](logs/settle__test__fleet-isolation.test.mjs.transport-confirmed.tap) | 3 | 3 | 0 | 0 |
| [settle/test/memory-boundaries.test.mjs](logs/settle__test__memory-boundaries.test.mjs.transport-confirmed.tap) | 13 | 13 | 0 | 0 |
| [settle/test/rebase-paths.test.mjs](logs/settle__test__rebase-paths.test.mjs.transport-confirmed.tap) | 10 | 10 | 0 | 0 |
| [settle/test/rebase-review.test.mjs](logs/settle__test__rebase-review.test.mjs.transport-confirmed.tap) | 12 | 12 | 0 | 0 |
| [settle/test/rebase-safety.test.mjs](logs/settle__test__rebase-safety.test.mjs.transport-confirmed.tap) | 4 | 4 | 0 | 0 |
| [settle/test/rebase.test.mjs](logs/settle__test__rebase.test.mjs.transport-confirmed.tap) | 6 | 6 | 0 | 0 |
| [settle/test/recapture.test.mjs](logs/settle__test__recapture.test.mjs.transport-confirmed.tap) | 14 | 14 | 0 | 0 |
| [settle/test/receipts.test.mjs](logs/settle__test__receipts.test.mjs.transport-confirmed.tap) | 4 | 4 | 0 | 0 |
| [settle/test/record-recovery.test.mjs](logs/settle__test__record-recovery.test.mjs.transport-confirmed.tap) | 16 | 16 | 0 | 0 |
| [settle/test/record-safety.test.mjs](logs/settle__test__record-safety.test.mjs.transport-confirmed.tap) | 10 | 10 | 0 | 0 |
| [settle/test/report-evidence.test.mjs](logs/settle__test__report-evidence.test.mjs.transport-confirmed.tap) | 11 | 11 | 0 | 0 |
| [settle/test/review-delivery.test.mjs](logs/settle__test__review-delivery.test.mjs.transport-confirmed.tap) | 1 | 1 | 0 | 0 |
| [settle/test/review-holds.test.mjs](logs/settle__test__review-holds.test.mjs.tap) | 2 | 2 | 0 | 0 |
| [settle/test/round-cap.test.mjs](logs/settle__test__round-cap.test.mjs.transport-confirmed.tap) | 10 | 10 | 0 | 0 |
| [settle/test/settle.test.mjs](logs/settle__test__settle.test.mjs.transport-confirmed.tap) | 19 | 19 | 0 | 0 |
| [settle/test/teardown.test.mjs](logs/settle__test__teardown.test.mjs.transport-confirmed.detached-final.tap) | 4 | 4 | 0 | 0 |
| [settle/test/test-evidence.test.mjs](logs/settle__test__test-evidence.test.mjs.transport-confirmed.tap) | 15 | 15 | 0 | 0 |
| [settle/test/test-plan.test.mjs](logs/settle__test__test-plan.test.mjs.tap) | 2 | 2 | 0 | 0 |
| [settle/test/train.test.mjs](logs/settle__test__train.test.mjs.transport-confirmed.tap) | 8 | 8 | 0 | 0 |
| [settle/test/validation-tiers.test.mjs](logs/settle__test__validation-tiers.test.mjs.transport-confirmed.tap) | 2 | 2 | 0 | 0 |
| [supervisor/test/autopilot.test.mjs](logs/supervisor__test__autopilot.test.mjs.transport-confirmed.tap) | 90 | 90 | 0 | 0 |
| [supervisor/test/entry.test.mjs](logs/supervisor__test__entry.test.mjs.tap) | 31 | 31 | 0 | 0 |
| [supervisor/test/reconcile.test.mjs](logs/supervisor__test__reconcile.test.mjs.tap) | 34 | 34 | 0 | 0 |
| [supervisor/test/status.test.mjs](logs/supervisor__test__status.test.mjs.transport-confirmed.tap) | 13 | 13 | 0 | 0 |
| [supervisor/test/supervisor.test.mjs](logs/supervisor__test__supervisor.test.mjs.transport-confirmed.tap) | 22 | 22 | 0 | 0 |
| [test-slot/test/gate-profile.test.mjs](logs/test-slot__test__gate-profile.test.mjs.timeout-final.tap) | 26 | 26 | 0 | 0 |
| [test-slot/test/train-conformance.test.mjs](logs/test-slot__test__train-conformance.test.mjs.timeout-final.tap) | 1 | 1 | 0 | 0 |
| [test-slot/test/watchdog.test.mjs](logs/test-slot__test__watchdog.test.mjs.timeout-final.attempt4.tap) | 32 | 32 | 0 | 0 |
| [test/approvals.test.mjs](logs/test__approvals.test.mjs.tap) | 14 | 14 | 0 | 0 |
| [test/bch-cloak-contract.test.mjs](logs/test__bch-cloak-contract.test.mjs.tap) | 2 | 2 | 0 | 0 |
| [test/cli-help.test.mjs](logs/test__cli-help.test.mjs.timeout-final.tap) | 20 | 20 | 0 | 0 |
| [test/discernment.test.mjs](logs/test__discernment.test.mjs.tap) | 5 | 5 | 0 | 0 |
| [test/fixture-lifetime.test.mjs](logs/test__fixture-lifetime.test.mjs.timeout-final.detached-final.tap) | 5 | 5 | 0 | 0 |
| [test/fleet.test.mjs](logs/test__fleet.test.mjs.tap) | 27 | 27 | 0 | 0 |
| [test/flow.test.mjs](logs/test__flow.test.mjs.tap) | 19 | 19 | 0 | 0 |
| [test/lessons.test.mjs](logs/test__lessons.test.mjs.tap) | 15 | 15 | 0 | 0 |
| [test/load-deadlines.test.mjs](logs/test__load-deadlines.test.mjs.fixture-final.tap) | 13 | 13 | 0 | 0 |
| [test/main-module.test.mjs](logs/test__main-module.test.mjs.timeout-final.tap) | 28 | 28 | 0 | 0 |
| [test/name-alias.test.mjs](logs/test__name-alias.test.mjs.tap) | 4 | 4 | 0 | 0 |
| [test/one-watcher.test.mjs](logs/test__one-watcher.test.mjs.tap) | 1 | 1 | 0 | 0 |
| [test/release.test.mjs](logs/test__release.test.mjs.tap) | 18 | 18 | 0 | 0 |
| [test/retire-lock.test.mjs](logs/test__retire-lock.test.mjs.tap) | 8 | 8 | 0 | 0 |
| [test/retire-paths.test.mjs](logs/test__retire-paths.test.mjs.timeout-final.tap) | 29 | 29 | 0 | 0 |
| [test/retire.test.mjs](logs/test__retire.test.mjs.tap) | 56 | 56 | 0 | 0 |
| [test/review-children.test.mjs](logs/test__review-children.test.mjs.tap) | 17 | 17 | 0 | 0 |
| [test/sanitization.test.mjs](logs/test__sanitization.test.mjs.tap) | 2 | 2 | 0 | 0 |
| [test/settle-watch.test.mjs](logs/test__settle-watch.test.mjs.tap) | 3 | 3 | 0 | 0 |
| [test/startup-deadlines.test.mjs](logs/test__startup-deadlines.test.mjs.timeout-final.tap) | 4 | 4 | 0 | 0 |
| [test/tidy-tabs.test.mjs](logs/test__tidy-tabs.test.mjs.tap) | 6 | 6 | 0 | 0 |
| [test/today.test.mjs](logs/test__today.test.mjs.tap) | 11 | 11 | 0 | 0 |
| [verify/test/verify.test.mjs](logs/verify__test__verify.test.mjs.tap) | 65 | 65 | 0 | 0 |
| [watch/test/existing-project.test.mjs](logs/watch__test__existing-project.test.mjs.tap) | 3 | 3 | 0 | 0 |
| [acceptance/test/boundary.test.mjs](logs/acceptance__test__boundary.test.mjs.tap) | 19 | 19 | 0 | 0 |
| [acceptance/test/cases.test.mjs](logs/acceptance__test__cases.test.mjs.tap) | 2 | 2 | 0 | 0 |
| [acceptance/test/cleanup.test.mjs](logs/acceptance__test__cleanup.test.mjs.tap) | 11 | 11 | 0 | 0 |
| [acceptance/test/deadlines.test.mjs](logs/acceptance__test__deadlines.test.mjs.tap) | 5 | 5 | 0 | 0 |
| [acceptance/test/default-cycle.test.mjs](logs/acceptance__test__default-cycle.test.mjs.tap) | 1 | 1 | 0 | 0 |
| [acceptance/test/environment.test.mjs](logs/acceptance__test__environment.test.mjs.tap) | 9 | 9 | 0 | 0 |
| [acceptance/test/focus.test.mjs](logs/acceptance__test__focus.test.mjs.tap) | 18 | 18 | 0 | 0 |
| [acceptance/test/housekeeping.test.mjs](logs/acceptance__test__housekeeping.test.mjs.tap) | 4 | 4 | 0 | 0 |
| [acceptance/test/load-round2.test.mjs](logs/acceptance__test__load-round2.test.mjs.tap) | 14 | 14 | 0 | 0 |
| [acceptance/test/load.test.mjs](logs/acceptance__test__load.test.mjs.tap) | 8 | 8 | 0 | 0 |
| [acceptance/test/probe.test.mjs](logs/acceptance__test__probe.test.mjs.tap) | 1 | 1 | 0 | 0 |
| [acceptance/test/results.test.mjs](logs/acceptance__test__results.test.mjs.tap) | 4 | 4 | 0 | 0 |
| [acceptance/test/signal.test.mjs](logs/acceptance__test__signal.test.mjs.tap) | 2 | 2 | 0 | 0 |
| **Total** | **1436** | **1435** | **0** | **1** |
