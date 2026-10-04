---
run: R-237
outcome: done
summary: |
  Fixed all four independent review findings. First done notices preflight the run-bound worker report and let handle perform conditional intake. The native executor preserves settle's exit-one structured base-movement refusal and retries the saved request once without --to. Correction reviews now override fix ancestry and display the active reviewer; damaged action receipts produce warnings and are omitted. Focused offline tests passed, including both real CLI paths through landing and closure. The final fast lane check follows this report commit.
headline: Fresh notices and base movement now complete automatically, with accurate review status
blockers: []
proposals: []
learnings:
  - "Watch checks report files without ingesting them. A first-notice policy must preflight the run-bound file and leave conditional immutable intake to handle."
  - "Settle emits a structured base-movement escalation on stdout with exit one. Retry uses its saved request and rejects --to or other request overrides."
artifacts:
  - "Implementation commit 059700c on lane/autopilot"
  - "supervisor/autopilot.mjs"
  - "supervisor/status.mjs"
  - "supervisor/test/autopilot.test.mjs"
  - "supervisor/test/status.test.mjs"
  - "supervisor/README.md"
  - "docs/reports/ENG-177-autopilot-R-237.md"
decisions:
  - text: Permit file preflight only for the initial handle; subsequent retry, follow-up and promotion require an immutable report.
    category: tooling
    why: This makes first notices actionable while keeping conditional intake and current-run guards in the existing CLI.
  - text: Recognize only the exact exit-one base-movement refusal with matching run, journal, project and retained error evidence.
    category: tooling
    why: Known base movement can resume once with the saved request; other failures and uncertain replies still require inspection.
questions: []
challenges: []
---

Read the correction ask, the independent review, the passing prior validation log, the run brief, the work item and the October 4 token-analysis and console-direction decisions. All four findings are addressed in `059700c`; changes stay in `supervisor/`, its tests and README, plus this report. The previous run's report is unchanged.

- The Major: preflight uses the record's report path, checks parsing and run identity, then applies outcome, question, blocker, decision-category and category-evidence guards. Autopilot performs no intake itself. Real CLI tests now begin with no immutable report: PASS and capped findings go through actual handle intake; the native inbox path reaches the real queue, fast-forward, lane retirement and guarded item closure without supervisor chat.
- The retry Moderate: command receipts retain exit code, stderr, signal, structured result and refusal output. The exact base-moved refusal is checked against the retained settlement. A real offline reviewer transport advances main during review, causing actual settle and handle to exit one. Native autopilot acknowledges that evidence, retries without `--to`, reuses the single independent review, recaptures once, lands once and closes. Replay adds no events. Negative cases reject unrelated refusals, changed run/journal/receipt bindings, other exit codes and signals.
- The status Moderate: the correction's own settlement or report takes precedence over its earlier fix ancestry. A fix-to-review transition with distinct engineer and reviewer sessions verifies stage, provider, model, start time and elapsed time without record mutations.
- The Minor: action arrays, row fields and timestamps are validated before sorting or mapping. Thirteen structurally damaged receipt variants warn and are omitted; valid completed and unfinished receipts remain readable, and all source bytes remain intact. Warning text leads with the reason so long paths cannot hide it in the CLI.

Validation was offline; the model/reviewer transport was scripted, while intake, handle, settle, retry, rebase, queue, validation, fast-forward and closure were real CLIs in owned scratch repositories:

- `node test/helpers/run.mjs supervisor/test/autopilot.test.mjs supervisor/test/status.test.mjs`: all 58 autopilot cases passed; one status warning-render assertion exposed the long-path truncation and was corrected. The complete status file then passed in the rerun below. Three subsequently added report-guard cases passed in the targeted run, bringing autopilot coverage to 61 passing cases across focused executions.
- `node test/helpers/run.mjs supervisor/test/status.test.mjs supervisor/test/delivery.test.mjs`: 26 passed, zero failures (8 status and 18 delivery cases).
- `node test/helpers/run.mjs '--test-name-pattern=^(un-ingested|a pending report|handle returns|handle explicitly|supervisor entry and final notices|late final reports|late original and correction|non-done reports|workers, linked|conditional record completion)' supervisor/test/autopilot.test.mjs supervisor/test/supervisor.test.mjs`: 20 passed, zero failures, 61 unrelated cases skipped. This covers all pending-report guards and eight existing supervisor lifecycle/cycle regressions.
- The initial regression run failed seven selected cases before implementation. `git diff --check` passed afterward.

The report is checked with the record CLI, then its repository copy is committed. The requested final step is `node lanes/lane.mjs check` at that exact clean commit; its gate receipt and output carry the final result. No project full suite, promotion tier, lanes suite, live acceptance harness or project housekeeping schedule was run in this lane.
