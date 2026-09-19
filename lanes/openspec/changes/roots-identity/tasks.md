# Make lane paths and Herdr labels repository-safe

## Outcome

Verify canonical git ownership before operations, guard real paths, use identity-aware workspace labels and agent-name stems, and keep the facilitator in the canonical repository workspace.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/repository-identity/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: roots-config promoted.
Contract approval: A1 must be approved before implementation.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/roots-identity` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

lane.mjs; test/; README.md; docs/REFERENCE.md; HANDOFF.md.

No migration, global repository catalog, user/organization configuration, git identity setter, or default remote policy.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [x] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/reports/roots-identity.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Observe failing offline fixtures for two roots with equal repo/topic names, shared-base foreign refusal, symlink escapes, checkout descendants, stale Herdr paths, linked invocation, parent-child topology, long-name uniqueness, and unchanged git identity. Fake Herdr must use actual protocol fields; preserve no-Herdr lifecycle checks.

Include long Unicode workspace labels with common prefixes: assert the 64-code-point
bound, whole graphemes, retained root/repo/topic fragments, and distinct suffixes.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/roots-identity/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
