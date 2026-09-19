# Discover local Herdr agents across repositories

## Outcome

Default the board to accessible local-machine Herdr scope, discover every live agent including unregistered/facilitator rows, join repositories safely, filter by repository, hide retired history, and publish explicit coverage.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/machine-session-discovery/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: board-actions (2b-ii) promoted.
Contract approval: Uses previously approved A1-A3; no further amendment proposed.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/board-discovery` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

lane.mjs; built-ins-only board services; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No filesystem-wide crawler, OS-process agent detector, remote server discovery, persistent machine registry, git identity changes, or lifecycle scheduling.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

At dispatch, use this combined lane or activate the pre-agreed board-inventory
(2c-i) / board-sampling (2c-ii) split in design.md. Select the boundary before
implementation; each resulting brief owns the named requirements, tests and
handoff. Neither a partial checkbox nor a partially synced full spec is completion.

## 1. Lane-sized task

- [ ] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/board-discovery.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Fail first on multi-root/same-name joins, multiple local endpoints, inaccessible servers, unnamed/non-git/facilitator rows, malformed and foreign registry isolation, outside-git startup, --repo/--all semantics, Herdr-done visibility, gate ownership, async sampling bounds and stable selection. Measure one fixture refresh and input latency without simultaneous test/build commands.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/board-discovery/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
