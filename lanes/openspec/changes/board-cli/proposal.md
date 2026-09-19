# Expose board read interfaces through lane CLI

Status: proposed. Initiative phase 2b-i; one independent lane.

## Why

The existing board needs a stable read interface before its UI can move onto CLI processes. Read services can ship independently of action commands and UI rewiring.

## What Changes

Add plain/JSON snapshots and a foreground JSON watch with explicit repository scope, moving read-command service orchestration into lane.mjs. Leave the existing UI untouched.

## Capabilities

### New Capabilities

- `board-cli-interface`: requirements in `specs/board-cli-interface/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: lane.mjs; dependency-free board entrypoints/model/client; test/; README.md; docs/REFERENCE.md; HANDOFF.md. board/app.mjs is unchanged.
- Prerequisites: session-registry promoted.
- Contract: No amendment required for read interfaces; A3 applies in board-actions (2b-ii), when the UI is rewired.
- Delivery: `lane/board-cli`, route `engineer`; High; one focused engineering session.
- Non-goals: No focus/done CLI actions, UI rewire, new layout, machine discovery, mouse, composer, global cache, daemon, or protocol server.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
