# Register dispatched sessions and retire closed lanes

Status: proposed. Initiative phase 2a; one independent lane.

## Why

Manual session registration misses agents, and completed metadata accumulates. Concurrent dispatch must add display records without lost updates or a job coordinator.

## What Changes

Write metadata for successful dispatch, consume both legacy registry entries and new per-session records, and mark completed close operations done. Preserve git authority and display-only semantics.

## Capabilities

### New Capabilities

- `session-metadata`: requirements in `specs/session-metadata/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: lane.mjs; built-ins-only board model/registry modules; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: roots-identity promoted.
- Contract: A2 must be approved before implementation.
- Delivery: `lane/session-registry`, route `engineer`; High; one focused engineering session.
- Non-goals: No global job store, scheduler, leases, validation decisions, prompt replay, raw transcript persistence, or automatic review generation.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
