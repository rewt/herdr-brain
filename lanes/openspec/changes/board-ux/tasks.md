# Build the fullscreen keyboard board

## Outcome

Add an alternate-screen layout, responsive master/detail view, explicit state colors and keyboard focus, using the official Ink UI package within the isolated board package.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/board-terminal-ux/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: board-discovery (2c) and board-messages (2d) promoted; board-actions (2b-ii) is inherited through discovery.
Contract approval: A4 must be approved before adding @inkjs/ui or UI-only modules.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/board-ux` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

board/app.mjs; board/ui/; board/package.json and lockfile; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No mouse support, new discovery logic, direct UI git/Herdr/file access, major Ink upgrade, visual-history store, or composer.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

At dispatch, use this combined lane or activate the pre-agreed board-frame (3a-i) /
board-details (3a-ii) split in design.md. 3a-i owns the 140x40, 100x24 and 80x24
geometry, stable selection through filtering, attention/no-color/evidence-key
behavior, Enter focus and terminal cleanup; it may start before board-messages
promotes if unavailable message evidence stays honest. 3a-ii owns complete
scrollable evidence content and final selectors/status details. Select the boundary
before implementation; each resulting brief owns the named requirements, tests and
handoff. Dependent composer/mouse work waits for the complete UX, not just the frame.

## 1. Lane-sized task

- [ ] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/board-ux.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Fail first on 140x40, 100x24, 80x24 and 40x12 layout/width/resize/selection states,
stable filtering, command routing for every listed key, attention counting,
text+color badge combinations, no-color behavior, evidence scrolling/Escape return,
and teardown with pending child output. After npm test, serialize an optional isolated
UI install and real-TTY startup/focus/return/history/quit/interrupt smoke. Record
exact observed vs skipped checks and footprint.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/board-ux/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
