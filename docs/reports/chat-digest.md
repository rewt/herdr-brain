---
run: R-286
outcome: done
summary: |
  Added record digest for on-demand project chat catch-up, with time windows and a caller-owned cursor covering both durable logs. The model-free, read-only view includes landed/refused promotion notices, reports with run/item/outcome/headline/check, decisions, open record questions and unresolved blocked sessions. Narrow text is bounded and sanitized; JSON preserves all facts. Shared the console's report projection with the core, documented the workflow, and passed 27 focused offline checks.
headline: Project chats can read what changed since their last conversation without receiving a notice stream.
blockers: []
proposals: []
learnings:
  - The report parser retains decisions in report.extra.decisions; readers support this shape and normalized report.decisions.
  - Promotion and watcher evidence lives in the durable supervisor inbox journal; a done report does not prove landing, and absent check evidence stays unknown.
artifacts:
  - "Implementation commit: 6ff3582 on lane/chat-digest"
  - "CLI: bin/org.mjs digest --since 2h --width 48"
  - "Cursor workflow: bin/org.mjs digest --json, then digest --after CURSOR --json"
  - "Projection: lib/digest.mjs and lib/report-feed.mjs; renderer: lib/render.mjs"
  - "Documentation: supervisor/README.md"
  - "Focused validation: node test/helpers/run.mjs test/digest.test.mjs console/test/feed.test.mjs console/test/details.test.mjs test/tier-plan.test.mjs test/today.test.mjs test/sanitization.test.mjs (27 passed)"
  - "Lane report copy: docs/reports/chat-digest.md"
decisions: []
questions: []
challenges: []
---

The digest reads the selected record and its supervisor/inbox.log. Promotion
facts describe durable producer outcomes, independent of notice delivery; they
are not fresh Git verification. Report checks mean watcher report validation,
not independent review or promotion validation. Missing journal evidence is
reported explicitly. No live pane, model, notice delivery, background service,
record initialization, log mutation or saved status is involved.

The opaque cursor is scoped to the canonical record path and anchors both log
snapshots. Same-time and backdated appends remain visible; repeated reads produce
no repeated changes. Foreign cursors and rotated/truncated sources require a new
time window. Only the chat stores its cursor. JSON includes all facts; text shows
explicit omitted counts, so callers read JSON before advancing past a truncated
text view. Outstanding record questions and current blocked sessions survive the
time window and clear through derived record/watch evidence, including replaced,
abandoned or closed runs. Report prose never creates a synthetic record question.

Offline coverage proves the CLI's time boundaries, cursor behavior and canonical
aliases, report/check correlation, report decisions, current question/block
resolution, narrow output, terminal sanitization, optional/torn/malformed inboxes,
and byte-identical read-only behavior. Existing console feed/detail, daily view,
sanitization and tier checks passed. A read-only smoke check against the project
record rendered the current facts at 48 columns.

After validating and committing this report, the final operation is:

    node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/digest.test.mjs console/test/feed.test.mjs console/test/details.test.mjs test/tier-plan.test.mjs test/today.test.mjs test/sanitization.test.mjs'

The final gate receipt is .lane/gate.json. No promotion, full suite or live
acceptance harness is run in this lane.
