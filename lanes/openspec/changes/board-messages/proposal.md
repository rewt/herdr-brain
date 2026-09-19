# Show the last substantive agent message

Status: proposed. Initiative phase 2d; one independent lane.

## Why

The current match-any-last-line subscription captures terminal footer chrome, including the Codex footer, rather than the agent's useful response.

## What Changes

Read bounded recent agent output and conservatively extract a substantive assistant message for Codex and Claude, while labeling uncertain or unsupported output honestly.

## Capabilities

### New Capabilities

- `agent-message-preview`: requirements in `specs/agent-message-preview/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: Built-ins-only board client/model/read adapters; test/; README.md; docs/REFERENCE.md; HANDOFF.md.
- Prerequisites: board-cli (2b-i) promoted; no discovery or action dependency.
- Contract: No additional amendment required; this extends the read interface.
- Delivery: `lane/board-messages`, route `engineer`; High; one focused engineering session.
- Non-goals: No model API, vendor transcript crawler, log archive, invented structured protocol field, or guarantee of unavailable scrollback.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
