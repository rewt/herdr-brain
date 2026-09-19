# Resolve development-root configuration

## Outcome

Add worktree_root, nearest-parent configuration layering, source-attributed lane config, and refusal of occupied foreign paths. Preserve explicit LANE_CONFIG and existing environment-path semantics. No existing worktree moves.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/root-configuration/spec.md`.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: None; this is the first Phase 1 task, incorporating the supplied roots brief.
Contract approval: Roots-config (1a) needs no amendment. Canonical-config resolution is a documented behavior change inside this lane. A1 applies in roots-identity (1b) and retroactively describes the path placement delivered in 1a.

This is a dispatchable future engineering brief, not authorization to implement it
in the planning session. When dispatched by the operator, work only in the current
`lane/roots` worktree; commit the authorized result; never push, publish,
promote, or close another lane. Do not edit the product contract unless the operator
has approved the exact amendment. One build/test at a time on the machine.

## Scope and limits

lane.mjs; test/lane.test.mjs; README.md; docs/REFERENCE.md; .lane.json.example; HANDOFF.md.

Do not migrate worktrees, change git identity, add root names/accounts, redesign the board, or add a migration command.

Suggested route: `engineer`. Suggested effort: High; one focused engineering session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [x] 1.1 Deliver this change's outcome and all applicable scenarios; verify the checks below, write `docs/LANE-ROOTS-20260908.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Add failing tests for every precedence source, both relative-key origins, route-name replacement, array replacement, canonical-vs-linked invocation, home boundary, malformed config, config TSV sources, occupied foreign paths, and LANE_CONFIG bypass. Run offline with fake/unavailable Herdr; confirm old lifecycle tests still pass.

Require `lane config` in both the CLI usage text and the README command table,
with its purpose and matching syntax. Observe a failing usage/README assertion
before adding those entries; document full source/precedence semantics in REFERENCE.

Each requirement in the adjacent delta spec is part of acceptance. Add and observe
failing regression tests before product changes; retain deliberate negative controls.
`npm test` must pass, `git diff --check` must be clean, and the complete diff must
contain no host-specific/private source text. All code tests are offline and clean
up system-temp fixtures. Preserve Node 20, git 2.38, and the dependency-free core.
Record skips precisely rather than reporting unexercised live behavior as passed.

## Handoff and promotion boundary

The report must list files/behavior, negative controls, test counts, measurements,
remaining limits, and any needed approval. Use a public-safe reviewed-SHA record in
`docs/reviews/roots/` if an independent review is requested; review is never
an automated promotion gate.

Sync only this implemented delta into its current spec before the final commit.
After the final report/HANDOFF commit, run `lane check` and paste the exact GATE
line in the conversation. Keep that final line out of a new tracked commit.
The operator promotes independently using the unchanged validated fast-forward
workflow; archive only after promotion as described in `openspec/README.md`.
