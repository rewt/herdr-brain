# Turn an idea into a brief and dispatched lane

## Outcome

Add lane new with an explicit repository and route, generate an ignored template-based brief, support an editor handoff, and expose resolved routes for a future picker.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/idea-dispatch/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: session-registry (2a) promoted; no board discovery, UI, or mouse dependency.
Contract approval: Uses approved A1-A2; no new contract amendment proposed.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/idea-cli` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

lane.mjs; docs/BRIEF_TEMPLATE.md; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No natural-language planner/model invocation, project-specific guessed requirements, repository creator, implicit facilitator, automatic migration, retries, or board UI.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [ ] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/idea-cli.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Fail first on identity-root refusal and no implicit destination/bootstrap, outside-git
and linked --repo, bad/empty/missing flags and route, duplicate branch/brief/path,
ignored-path refusal, literal shell-looking/multiline text, template sections,
editor success/cancel/failure, exact open-before-dispatch order, structured
success/partial-result identity, route effort projection without route-name
inference, one registry record, and each partial-failure boundary with no replay.
Fake Herdr and fake editor run offline; no real agent starts.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/idea-cli/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
