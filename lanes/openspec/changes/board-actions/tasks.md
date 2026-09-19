# Add board actions and move the UI onto CLI processes

## Outcome

Deliver Phase 2b-ii: verified focus/done CLI actions and an existing-table rewire to
CLI observations/actions, enforced by an import/process-boundary regression.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's `proposal.md`, `design.md`, and
`specs/board-session-actions/spec.md`. Read board-cli's v1 read-interface contract.
Follow the shared delivery rules in `openspec/README.md`.

Prerequisites: board-cli (2b-i) promoted.
Contract approval: A3 must be approved before implementation.

This is a future engineering brief. When dispatched by the operator, work only in
the current `lane/board-actions` worktree and commit the authorized result. Never
push, publish, promote, or close another lane. Apply only the exact approved
contract amendment. One build/test at a time on the machine.

## Scope and limits

lane.mjs; board/app.mjs; built-ins-only board adapters; test/; README.md;
docs/REFERENCE.md; HANDOFF.md.

No read-schema redesign, machine discovery, message extraction, new layout, mouse,
composer, UI dependency addition, or action retry.

Suggested route: `engineer`. Suggested effort: High; one focused session.
Use the route's configured agent/model; do not change routing defaults.

## 1. Lane-sized task

- [x] 1.1 Deliver the action commands and UI process boundary; verify all scenarios below, write `docs/reports/board-actions.md` and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Observe failing tests for stale/foreign/unnamed focus targets, invalid action
arguments, done routing and refusal, one call per user action, UI data/actions
through a fake CLI, and the import/process boundary. Cover split/batched read
frames, child errors, and quit during pending refresh/reconnect. Keep predecessor
read-schema and permanent-client-close regressions green.

All adjacent spec scenarios are required. Add offline built-ins-only tests before
behavior changes with deliberate negative controls and cleaned system-temp
fixtures. `npm test` and `git diff --check` must pass; the full diff must remain
public-safe. Preserve Node 20, git 2.38, and operation without UI dependencies.
Document action syntax in CLI usage, the README command table, and REFERENCE.
Record any unavailable real-TTY/Herdr checks as explicit skips.

## Handoff and promotion boundary

Report changed files/behavior, negative controls, test counts, measurements and
unverified areas. If an independent review is requested, keep the public-safe
reviewed-SHA record under `docs/reviews/board-actions/`.

Sync only this implemented delta before the final report/HANDOFF commit. Run
`lane check` afterward and quote its exact GATE in the conversation, without
another tracked commit. The operator promotes through the unchanged validated
fast-forward workflow; archive only after promotion per `openspec/README.md`.
