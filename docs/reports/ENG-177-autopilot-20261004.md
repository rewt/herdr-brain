---
run: R-233
outcome: done
summary: |
  Implemented notice-autopilot/v1 ahead of supervisor inbox delivery, with durable action receipts, guarded local CLI calls, compact exception wakes, and a project kill switch. Routine handling progresses independently of a busy supervisor composer. Added a shared read-only lane status projection and CLI table. Focused offline validation and the complete automatic PASS-to-landing cycle passed; the final fast lane check follows this report commit.
headline: Routine notices now follow recorded policy and lane stages are readable without a model
blockers: []
proposals: []
learnings:
  - "The inbox delivery lock can be held while input remains busy for two hours; routine policy must be elected per notice before that gate so work continues without chat."
  - "Settle reopens a worker's done outcome during review intake. Reopening after a recorded closure requires judgment, while that normal intake event must not block promotion."
  - "Node parseArgs needs --accept=VALUE when findings start with a dash; an argument array alone does not remove option-value ambiguity."
  - "Settle can already dispatch a correction before returning FAIL or a capped Major. Autopilot wakes with the retained evidence and never promotes that result."
artifacts:
  - "Implementation commit c8ffb8d on lane/autopilot"
  - "supervisor/autopilot.mjs"
  - "supervisor/status.mjs"
  - "supervisor/test/autopilot.test.mjs"
  - "supervisor/test/status.test.mjs"
  - "supervisor/README.md and supervisor/PROTOCOL.md"
decisions:
  - text: Use notice-autopilot/v1 to handle routine local notices under the project's auto tooling authority and retain command intent and acknowledgements per run or promotion job.
    category: tooling
    why: The operator supplied the routine policy. Durable receipts prevent delivery retries from creating another follow-up or replaying an uncertain operation.
  - text: Expose supervisorStatus and supervisor status --json as the shared read-only lane projection.
    category: design
    why: The command and minimal console can consume the same derived stages and display metadata without a model or stored work status.
questions: []
challenges: []
---

The implementation is committed at `c8ffb8d`. Changes are confined to `supervisor/`, its tests and documentation, plus this requested report.

The policy handles recorded done reports through the existing supervisor command, uses the project's review route, promotes independent PASS with the policy named in the recorded reason, leaves watched fixes in flight, retries the exact base-movement escalation once, files one findings follow-up before accepting capped Moderate/Minor findings, and handles promoted queue outcomes. It wakes for every other result, including unknown results, FAIL, capped Major, questions, refusals, gate notices and interrupted operations.

STOP, housekeeping pause, the canonical `.supervisor.json` kill switch, malformed configuration, record damage, changed run/repository bindings, reserved categories and explicit reopening after completion prevent automatic mutations. These guards are checked before every CLI call. Receipts retain full original notices and diagnostics; the chat gets one bounded line and the receipt path. Lost acknowledgements and interrupted sequences require inspection. All record writes use CLI argument arrays, and the existing settlement, current-run, clean-tree, validation and fast-forward safeguards remain responsible for integration.

`node supervisor/supervisor.mjs status [--json]` renders run, item, lane, stage, provider, model, start and elapsed time, followed by recent policy actions and their receipt paths. Stage derives from the record, settlement and queue; Herdr and optional session receipts supply display fields only. Completed removed legacy lanes do not inflate the active table. Missing Herdr or damaged receipt data yields warnings. The status path writes no record or checkpoint events and reads no model transcript.

Validation completed offline:

- `node test/helpers/run.mjs supervisor/test/autopilot.test.mjs supervisor/test/status.test.mjs supervisor/test/delivery.test.mjs`: 65 passed, zero failures. This includes actual settlement and promotion-command execution with a scripted independent reviewer, argument-safe findings intake, all policy branches, conservative unknown-result wakes, duplicate suppression, uncertainty, reserved decisions, STOP/pause/config guards, busy-chat independence, exception delivery through the existing input gate, derived stages, session display and a read-only linked-checkout status CLI.
- The subsequently added `automatic PASS` case passed separately: real settlement, queue validation, local fast-forward, lane retirement and guarded record closure; both notices were handled, and the only agent prompt was the scripted independent review. No supervisor prompt or notification was needed.
- Existing supervisor regressions passed across the initial focused regression run and a corrected end-to-end rerun. Compact exceptions preserve the fixed `[org-report]` envelope, allowing existing foreground callers and the existing offline supervisor cycle to route them unchanged.
- Final configuration/status cases and the removed-history projection passed. `git diff --check` passed.

A manual read of the current project record showed the engineering, fix, review and recent landed stages. The sandbox denied the Herdr socket lookup; the command returned its explicit unavailable warning and record metadata. Live pane mutations were not used for validation.

The final requested step, after checking and committing this report, is `node lanes/lane.mjs check` using the configured fast tier. Its output and lane validation receipt carry that final result. No project baseline, full suite, promotion suite, lanes suite, or live acceptance harness was run in this lane. The automatic-cycle test's validation ran only inside its owned scratch repository. No project housekeeping schedule was started.
