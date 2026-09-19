# Inventory local Herdr agents across repositories

Status: proposed. Initiative phase 2c-i; first half of the activated board-discovery split.

## Why

A registry-only board omits manually started or unnamed agents and separates
repositories into isolated views. Herdr provides the inventory, but its workspace
metadata alone does not establish branch ownership.

## What Changes

Default the board to accessible local-machine Herdr scope, discover every live agent
including unregistered and facilitator rows, join repositories by canonical Git
identity, filter by repository, hide retired history independently of live agent
status, and publish explicit coverage.

## Capabilities

### New Capabilities

- `machine-session-discovery`: the inventory-owned requirements are in
  `specs/machine-session-discovery/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.

## Impact

- Scope: lane.mjs; dependency-free board services; test/; README.md;
  docs/REFERENCE.md; docs/reports/board-inventory.md; HANDOFF.md.
- Prerequisite: board-actions (2b-ii) promoted.
- Contract: Uses previously approved A1-A3; no further amendment proposed.
- Delivery: `lane/board-inventory`, route `engineer`; High; one focused engineering session.
- Compatibility: JSON/plain board fields are additive, existing field meanings and
  sampling behavior remain unchanged, and `board/app.mjs` plus `board/ui/` are out of scope.
- Non-goals: No filesystem-wide crawler, OS-process detector, remote discovery,
  persistent machine registry, Git identity changes, lifecycle scheduling, or
  board-sampling responsiveness/freshness claim.

The original [`board-discovery`](../board-discovery/) proposal is superseded by this
change and future [`board-sampling`](../board-sampling/). Both must promote before
the combined discovery capability is complete.
