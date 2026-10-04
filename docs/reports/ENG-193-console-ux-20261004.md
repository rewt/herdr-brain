---
run: R-244
outcome: done
summary: |
  The minimal console now opens landed, blocked and finished run details,
  readable reports with their reviews, and live or completed train receipts
  with updating log tails. Tab changes panels, arrows select rows, and Back
  restores selection and scroll. Meta keys reach live sessions, their initial
  width matches the session viewport, and a visible marker identifies selection.
  This lane also fixes the inherited console-ink promotion failure by loading
  optional UI packages dynamically and visibly skipping dependent view tests
  when those packages are absent. Implementation and evidence are committed in
  bd81992. All 123 focused and related checks passed with dependencies installed;
  a separate copy without console/node_modules passed 228 checks and skipped 30
  optional view checks. The report precedes its check, commit and final lane check.
headline: Runs, reports and the train now open useful details with safe navigation
blockers: []
proposals:
  - role: engineer
    title: Persist settle review and correction stage clocks for console run details
    why: Existing settle journals retain review text and verdicts but no review start, finish or duration. The console can show engineering, report-to-settle, queue wait, CI, integration and report-to-main timings from persisted evidence, but labels missing review and correction clocks as not recorded. Persisting those stage transitions would complete the requested stage breakdown without inferring time from file updates.
learnings:
  - "Run reports are archived under the record's report.file and survive lane retirement. Settle journals under ORG/settle/R-n.json retain review text and its hash; verify the run, item, org and Git common-directory binding before showing it."
  - "ENG-181 writes attempt.gate.command and started_at before synchronous validation, with finish and duration on completion. Missing gate clocks remain unknown; a completed gate must not keep counting during delivery."
  - "Importing minimal-session.mjs or minimal.mjs must not resolve Ink or React. The minimal renderer loads dynamically on profile preparation; the interactive entry point prepares it before its initial render."
  - "Ink's incremental renderer needs a spare terminal row to avoid its full-screen erase path. The actual MinimalConsole already reserves that row; the unchanged-output tests use the same geometry."
artifacts:
  - "commit bd81992: Make minimal console rows actionable and load optional UI lazily"
  - "branch lane/console-ux; includes the console-ink base for combined landing"
  - "console/modern/details.mjs"
  - "console/modern/detail-view.mjs"
  - "console/modern/minimal-renderer.mjs"
  - "console/modern/minimal-session.mjs"
  - "console/test/details.test.mjs"
  - "console/test/detail-view.test.mjs"
  - "console/test/optional-ink.mjs"
  - "console/test/fixtures/run-detail-100x30.txt"
  - "console/test/fixtures/report-detail-100x30.txt"
  - "console/test/fixtures/train-detail-100x30.txt"
  - "console/evidence/ENG-193/focused-tests.tap"
  - "console/evidence/ENG-193/related-tests.tap"
  - "console/evidence/ENG-193/without-ui-tests.tap"
  - "console/evidence/ENG-193/live-100x30.txt"
  - "console/evidence/ENG-193/live-60x30.txt"
  - "console/evidence/ENG-193/live-report-100x30.txt"
decisions: []
questions: []
challenges:
  - "The supervisor expanded landing to include ENG-188 after promotion scratch CI failed on static React imports. This report remains R-244; the dependency fix and isolated-copy proof are included in this lane."
  - "Herdr agent/topology reads were unavailable from this sandbox. Live-record print snapshots and a temporary interactive Ink PTY were inspected; real agent control and Meta input were verified with offline exact-occupant fixtures, without sending input to a live agent."
---

Active runs with a verified live occupant still open their native session. Landed,
blocked, finished or unavailable runs open a durable detail document. It shows the
item and title, outcome and explicit watch check, archived report rendered as
Markdown, review verdict and all findings, promotion result and commit, decisions
on the run, and timings that the record actually retains. The item link opens its
full title, criteria, runs and decisions. Report and promotion links support nested
Back navigation. Reports always open their report and review, even when a worker
pane remains present. Watch exceptions explain an absent report.

Train rows open their own batch or result rather than an agent. The live page
shows lanes, phase, current command, elapsed check time and the latest log lines.
The check clock advances between source polls and freezes at completion. The
page keeps the original batch ID across queue changes and ends with its promoted,
refused or interrupted result and reason. Receipt JSON and bounded check/train
log tails remain scrollable. ENG-181 fields take precedence; older receipts use
their validating log line and label absent clocks. A recorded running command
avoids rescanning the train log merely to rediscover the command. Log readers cap
reads at 64 KiB and display at most 200 lines, strip terminal controls, and retain
last good documents on source errors.

Tab and Shift+Tab remember selection in each panel, including Context. Arrow keys
move within rows; PageUp/PageDown and the wheel scroll details; Tab jumps detail
sections. Enter and mouse activation share the same destinations. Esc and Back
restore the prior selection and scroll and release terminal control without
forwarding Esc. Ctrl+backslash remains the labelled interrupt key. Meta/Alt pairs
retain their bytes, including Option+Enter and Alt+Backspace, and the control
stream starts at the full session width instead of the 116-column dashboard cap.
The selected row has a visible `›` marker even without colour. No record writes,
model calls, scheduling or promotion actions were added.

Validation with dependencies installed:

- `node --test console/test/details.test.mjs console/test/detail-view.test.mjs console/test/minimal.test.mjs console/test/minimal-input.test.mjs console/test/feed.test.mjs console/test/table.test.mjs`: 51 passed. Coverage includes open/Back for runs, reports, train results and nested details; selection and scroll restoration; Esc isolation; Meta input; initial viewport size; running and absent telemetry; log updates; finished clocks; altered/foreign evidence; narrow/wide bounds; and unchanged-output suppression.
- `node test/helpers/run.mjs console/test/modern.test.mjs console/test/control.test.mjs console/test/terminal.test.mjs console/test/paint.test.mjs`: 72 passed.
- The actual `--print` CLI matches committed dashboard, run, report and train snapshots. A temporary live-data PTY started successfully, opened a report, returned with Esc, and quit with balanced terminal modes. `git diff --check` passed before the implementation commit.

For the required dependency-free proof, tracked and new files were copied to
`/private/tmp/eng193-no-ui-kpai5wpp`, excluding all node_modules. From that copy,
`node test/helpers/run.mjs console/test/*.test.mjs` passed 228 of 258 checks, with
30 view checks explicitly skipped because optional Ink/React packages were
absent. Pure projections and the other console paths still ran. The committed
TAP evidence records the visible skip reason. No dependency installation, model
call, baseline suite, promotion suite or release acceptance harness was run.

The final lane check runs after this report is checked and committed. Its
exact-commit result belongs in `.lane/gate.json`; promotion validation remains
with the integration batch.
