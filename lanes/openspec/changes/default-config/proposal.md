# Ship overridable built-in routes and generic templates

Status: proposed. Configuration addendum; one lane or its pre-agreed split, pending A5.

## Why

A new deployment currently needs a local route configuration before it can use the
named engineering/review workflow. Shipped defaults can make those role names useful
immediately while preserving explicit repository and operator choices.

## What Changes

- Add a versioned built-in configuration layer with the eight specified routes,
  use notes and an engineer-equivalent default dispatch profile.
- Keep this layer below all selected files and existing environment/CLI overrides;
  show its provenance as built-in in lane config.
- Resolve generic brief/review templates from the tool installation, allowing each
  repository to supply its own validated template at the documented conventional path.
- Update .lane.json.example and the documentation to demonstrate overriding defaults.

## Capabilities

### New Capabilities

- `built-in-lane-defaults`: requirements in specs/built-in-lane-defaults/spec.md.

### Modified Capabilities

- `root-configuration`: make LANE_CONFIG one operator file over built-ins and add
  built-in source attribution; retain the other delivered discovery/path safeguards.

## Impact

- Scope: lane.mjs; defaults/lane.json; docs/BRIEF_TEMPLATE.md;
  docs/REVIEW_TEMPLATE.md; .lane.json.example; test/; README.md;
  docs/REFERENCE.md; openspec/README.md; docs/reports/default-config.md; HANDOFF.md.
  AGENTS.md for approved A5 and ordinary repository-map maintenance for defaults/.
- Prerequisites: review-cli promoted (and roots-config already promoted in its
  dispatch sequence). No registry, board or idea-composer dependency.
- Contract: A5 must be approved/applied here before implementation. The exact text
  lives only in the [OpenSpec guide](../../README.md#proposed-contract-amendments--pending-operator-approval).
- Delivery: lane/default-config, route engineer; High; one focused session.
- Non-goals: no account setup, agent/framework install, model availability probe,
  remote defaults fetch, model substitution, automatic escalation, new scheduler,
  new template-producing command or weakening of reviewer permissions.

Public vendor identifiers are not personal paths or organization-specific settings.
They can be portable defaults, but shipping an opinionated provider/model policy
changes the earlier operator-owned routing boundary. A5 makes that narrow exception
explicit rather than treating public model names as blanket permission for host or
organization defaults. Every route remains replaceable; other agents stay supported.

See [design](design.md) and the [dispatchable task](tasks.md).

Pre-agreed split: D-i default-routes delivers routes/precedence/provenance under A5;
D-ii default-templates delivers repository/installation template lookup. The
[requirement/test partition](design.md#pre-agreed-split-point) is selected before coding.
