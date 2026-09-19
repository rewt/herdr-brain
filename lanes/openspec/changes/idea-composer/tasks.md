# Compose and dispatch an idea from the board

## Outcome

Add a keyboard composer with repository/route selectors, route use notes, task/topic entry, explicit submit, and editor handoff through lane new.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/board-idea-composer/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: idea-cli and board-ux promoted; mouse research is not required.
Contract approval: Uses previously approved A3-A4; no further amendment proposed.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/idea-composer` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

board/app.mjs; board/ui/; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No scheduler, saved job state, automatic dispatch retry, direct filesystem/git/Herdr control, new model defaults, or dependency on mouse support.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [ ] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/idea-composer.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Fail first on multiline task Enter, explicit topic/review launch, repository/route
changes including same-name route invalidation, scope-independent drafts,
identity-root refusal, invalid form fields, input key ownership, literal argument
arrays, duplicate-submit suppression, each distinct partial outcome, filtered
successful row selection/focus, and editor suspend/return/cancel. Run the offline
cross-root idea-to-close scenario and separately record a real-TTY smoke if available.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/idea-composer/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
