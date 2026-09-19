# Resolve development-root configuration

Status: proposed. Initiative phase 1a; one independent lane.

## Why

Every repository currently defaults to a basename-keyed directory under the legacy Herdr worktree base. Shared root configuration is needed before operators can place sibling worktrees and share route definitions.

## What Changes

Add worktree_root, nearest-parent configuration layering, source-attributed lane config, and refusal of occupied foreign paths. Preserve explicit LANE_CONFIG and existing environment-path semantics. No existing worktree moves.

## Capabilities

### New Capabilities

- `root-configuration`: requirements in `specs/root-configuration/spec.md`.

### Modified Capabilities

None. Existing safety guarantees remain in `openspec/specs/lane-safety/spec.md`.
These additions do not claim the whole existing board/CLI has been re-specified.

## Impact

- Scope: lane.mjs; test/lane.test.mjs; README.md; docs/REFERENCE.md; .lane.json.example; HANDOFF.md.
- Prerequisites: None; this is the first Phase 1 task, incorporating the supplied roots brief.
- Contract: Roots-config (1a) needs no amendment. Canonical-config resolution is a documented behavior change inside this lane. A1 applies in roots-identity (1b) and retroactively describes the path placement delivered in 1a.
- Delivery: `lane/roots`, route `engineer`; High; one focused engineering session.
- Non-goals: Do not migrate worktrees, change git identity, add root names/accounts, redesign the board, or add a migration command.

See [design](design.md) for compatibility changes and risk controls and
[tasks](tasks.md) for the complete dispatchable brief. Shared amendments and
workflow are in [the OpenSpec guide](../../README.md).
