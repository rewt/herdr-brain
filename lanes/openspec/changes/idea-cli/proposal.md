# Turn an idea into a brief and dispatched lane

Status: proposed. Initiative phase 4a; one independent lane.

## Why

Operators must currently write a brief, choose the checkout, open a lane, and dispatch it separately. A foreground command can compose those existing operations without becoming a job system.

## What Changes

Add lane new with an explicit repository and route, generate an ignored template-based brief, support an editor handoff, and expose resolved routes for a future picker.

## Capabilities

### New Capabilities

- `idea-dispatch`: requirements in `specs/idea-dispatch/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: lane.mjs; docs/BRIEF_TEMPLATE.md; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: session-registry (2a) promoted; no board discovery, UI, or mouse dependency.
- Contract: Uses approved A1-A2; no new contract amendment proposed.
- Delivery: `lane/idea-cli`, route `engineer`; High; one focused engineering session.
- Non-goals: No natural-language planner/model invocation, project-specific guessed requirements, repository creator, implicit facilitator, automatic migration, retries, or board UI.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
