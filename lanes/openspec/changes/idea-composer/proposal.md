# Compose and dispatch an idea from the board

Status: proposed. Initiative phase 4b; one independent lane.

## Why

The board already has repository context and navigation; a small compose view can turn an idea into a lane without duplicating the CLI's lifecycle logic.

## What Changes

Add a keyboard composer with repository/route selectors, route use notes, task/topic entry, explicit submit, and editor handoff through lane new.

## Capabilities

### New Capabilities

- `board-idea-composer`: requirements in `specs/board-idea-composer/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: board/app.mjs; board/ui/; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: idea-cli and board-ux promoted; mouse research is not required.
- Contract: Uses previously approved A3-A4; no further amendment proposed.
- Delivery: `lane/idea-composer`, route `engineer`; High; one focused engineering session.
- Non-goals: No scheduler, saved job state, automatic dispatch retry, direct filesystem/git/Herdr control, new model defaults, or dependency on mouse support.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
