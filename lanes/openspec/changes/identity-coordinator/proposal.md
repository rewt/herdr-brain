# Identity coordinator protocol and pilot

Status: proposed, 2026-09-13. Today's deliverable is specification, not an installed
protocol, console feature, or live pilot.

## Why

The current daily supervisor pack is project-local. One identity spanning projects
needs an explicit roster, outcome and budget allocation, a single acceptance owner
per project, and small evidence-carrying handoffs. The board observes sessions but
cannot currently represent an authoritative project assignment or a coordination
report. Treating a session title, registry row, or pane state as that authority would
cross the existing safety boundary.

## What changes when adopted

- A manual [coordination protocol](specs/identity-coordination/spec.md) names the
  canonical repository for each project, the current integration owner, each daily
  outcome and budget, and the evidence required to transfer ownership. It can be
  piloted before any console extension.
- A later, opt-in [read-only board projection](specs/coordination-observation/spec.md)
  may show assignment owner, latest report, and coordination attention alongside
  existing fields. It neither assigns nor executes work.
- [Design](design.md), [implementation briefs](tasks.md), and the [manual pilot](../../../docs/identity-coordinator-pilot.md)
  separate adoption, read-model, and UI work.

## Boundaries

The coordinator owns cross-project priorities, dependencies and resource budgets.
Each canonical project has exactly one designated integration owner. An optional
project supervisor is that owner for sustained or multi-lane work and owns detailed
evidence/acceptance. For a small project, the coordinator can be its integration
owner and assign an engineer directly. No parallel coordinator review duplicates a
project supervisor's detailed review. Independent review remains governed by the
project's rules.

This proposal does not change `lane.mjs`, `board/`, tests, package files, current
`openspec/specs/`, `AGENTS.md`, the pinned supervisor pack, identities/accounts, or
existing in-flight `board-inventory` and `board-frame` slices. No job system,
scheduler, polling, heartbeat, lease, replay, promotion policy, or automatic pilot
rollout is proposed. Operator review and explicit selection of one identity and two
projects precede a live pilot.
