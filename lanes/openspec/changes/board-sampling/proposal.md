# Bound board observation sampling

Status: proposed. Initiative phase 2c-ii; second half of the activated board-discovery split.

## Why

Machine inventory can span many sessions and repositories. Sampling must remain
responsive without overlapping refreshes, duplicating checkout work, or retaining
unbounded history.

## What Changes

Add bounded asynchronous per-checkout sampling, refresh coalescing, freshness/error
handling, stable selection, and runtime-cache cleanup to the inventory delivered by
board-inventory.

## Capabilities

### New Capabilities

- `machine-session-discovery`: the sampling-owned requirement is in
  `specs/machine-session-discovery/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.

## Impact

- Scope: lane.mjs; dependency-free board services; test/; README.md;
  docs/REFERENCE.md; docs/reports/board-sampling.md; HANDOFF.md.
- Prerequisite: board-inventory (2c-i) promoted.
- Delivery: `lane/board-sampling`, route `engineer`; High; one focused engineering session.
- Non-goals: No new discovery source, persistent history cache, lifecycle scheduling,
  or remote/process/filesystem discovery.

The original [`board-discovery`](../board-discovery/) proposal is superseded by
board-inventory and this change. Both must promote before the combined discovery
capability is complete.
