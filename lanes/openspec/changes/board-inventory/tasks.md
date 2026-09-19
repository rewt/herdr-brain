# Inventory local Herdr agents across repositories

## Outcome

Default the board to accessible local-machine Herdr scope, discover every live agent
including unregistered and facilitator rows, join repositories safely, filter by
repository, hide retired history independently of agent status, and publish explicit
coverage without changing the current sampling guarantees.

## Repository context and authorization

Read `AGENTS.md`, `README.md`, `docs/REFERENCE.md`, `HANDOFF.md`, and
`openspec/README.md`, then this change's proposal, design, and delta spec. Follow the
shared delivery rules in `openspec/README.md`.

Prerequisite: board-actions (2b-ii) promoted. Uses approved A1-A3. Work only in
`lane/board-inventory`; commit the authorized result but never push, publish,
promote, close, rewrite history, or edit `docs/reviews/`.

## Scope and limits

`lane.mjs`; dependency-free board services excluding `board/app.mjs` and `board/ui/`;
`test/`; `README.md`; `docs/REFERENCE.md`; `docs/reports/board-inventory.md`;
`HANDOFF.md`; this change and the split scaffolding.

No filesystem-wide crawler, OS-process detector, remote discovery, persistent machine
registry, Git identity changes, lifecycle scheduling, or sampling responsiveness/
freshness implementation or claim. All new document fields are additive and existing
field meanings remain stable.

## 1. Lane-sized task

- [x] 1.1 Deliver the three inventory-owned requirements and all scenarios; add and
  observe offline failing regressions with a deliberate `negativeControl` in each new
  group; document fields and semantics; sync only the inventory delta into the current
  capability; write the report and HANDOFF entry; commit; then obtain a passing GATE
  against the final commit.

## Acceptance checks

Cover multi-root same-name canonical joins, local endpoint enumeration and
deduplication, inaccessible endpoints, unnamed/non-Git/facilitator rows, malformed
and foreign registry isolation, outside-Git startup, `--repo`/`--all`, Herdr-done
visibility, active-after-done behavior, and honest gate/coverage ownership. Fake
Herdr data uses real protocol fields. Preserve the existing sampling behavior.

Run serialized `npm test`, the relevant negative controls, strict OpenSpec validation,
`git diff --check`, and a public-safety scan after clear process probes. Record exact
results, versions, skips, and unverified live behavior in the report and HANDOFF.
