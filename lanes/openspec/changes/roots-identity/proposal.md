# Make lane paths and Herdr labels repository-safe

Status: proposed. Initiative phase 1b; one independent lane.

## Why

Basenames and display labels cannot establish ownership when two roots contain repositories with the same name. Root placement must also remain safe across symlinks and linked-checkout invocation.

## What Changes

Verify canonical git ownership before operations, guard real paths, use identity-aware workspace labels and agent-name stems, and keep the facilitator in the canonical repository workspace.

## Capabilities

### New Capabilities

- `repository-identity`: requirements in `specs/repository-identity/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: lane.mjs; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: roots-config promoted.
- Contract: A1 must be approved before implementation.
- Delivery: `lane/roots-identity`, route `engineer`; High; one focused engineering session.
- Non-goals: No migration, global repository catalog, user/organization configuration, git identity setter, or default remote policy.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
