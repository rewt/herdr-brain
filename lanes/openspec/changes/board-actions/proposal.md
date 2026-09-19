# Add board actions and move the UI onto CLI processes

Status: proposed. Initiative phase 2b-ii; one independent lane.

## Why

The read interfaces can now serve a UI, but explicit focus/done actions and a
verified process boundary are needed to remove the UI's direct control paths.

## What Changes

Add verified focus and done CLI actions, rewire the existing table to CLI
observations/actions, and enforce its import/process boundary. Preserve its layout.

## Capabilities

### New Capabilities

- `board-session-actions`: requirements in `specs/board-session-actions/spec.md`.

### Modified Capabilities

None. Consume the v1 read schema from board-cli without redefining it.

## Impact

- Scope: lane.mjs; board/app.mjs; built-ins-only board adapters; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: board-cli (2b-i) promoted.
- Contract: A3 must be approved before implementation.
- Delivery: `lane/board-actions`, route `engineer`; High; one focused engineering session.
- Non-goals: No read-schema redesign, machine discovery, message extraction, new layout, mouse, composer, or action retry.

See [design](design.md), [tasks](tasks.md), and the
[shared amendment text](../../README.md#proposed-contract-amendments--pending-operator-approval).
