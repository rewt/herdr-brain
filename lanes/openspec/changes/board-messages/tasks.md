# Show the last substantive agent message

## Outcome

Read bounded recent agent output and conservatively extract a substantive assistant message for Codex and Claude, while labeling uncertain or unsupported output honestly.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/agent-message-preview/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: board-cli (2b-i) promoted; no discovery or action dependency.
Contract approval: No additional amendment required; this extends the read interface.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/board-messages` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

Built-ins-only board client/model/read adapters; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No model API, vendor transcript crawler, log archive, invented structured protocol field, or guarantee of unavailable scrollback.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [x] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/board-messages.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Observe failures for both agents with a footer after a real response, multiline/wrapped/Unicode messages, echoed prompts, tool-only/footer-only screens, unknown formats, stale/truncated reads and replaced pane occupants. Verify bounded read counts and one-shot/watch parser parity with fake Herdr.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/board-messages/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
