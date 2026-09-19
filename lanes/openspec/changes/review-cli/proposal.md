# Run one independent review in the foreground

Status: proposed. Review-protocol addendum; one lane or the pre-agreed two-lane split.

## Why

Operators currently assemble review context, allocate checks, dispatch an independent
reviewer and collect evidence by hand. One foreground command can make that protocol
repeatable while keeping fixes, further rounds and promotion operator-controlled.

## What Changes

- Add docs/REVIEW_TEMPLATE.md with a mandatory private record, fixed verdict/schema,
  explicit run budget, negative-control witnesses and review-only permissions.
- Add lane review with an explicit round and source, clean-tree/HEAD checks,
  current-gate disclosure, one routed dispatch and a bounded foreground wait.
- Validate the private record, refuse changed worktrees or unverifiable sanitization,
  and generate the public-safe record in the lane without staging or committing it.
- Document tier-escalation advice and operator ownership of every subsequent action.

## Capabilities

### New Capabilities

- `foreground-lane-review`: requirements in specs/foreground-lane-review/spec.md.

### Modified Capabilities

None. Preserve dispatch, gate and promotion safeguards. Review remains optional
historical evidence; no new promotion policy is introduced.

## Impact

- Scope: lane.mjs; docs/REVIEW_TEMPLATE.md; test/; README.md; docs/REFERENCE.md;
  openspec/README.md; docs/reports/review-cli.md; HANDOFF.md.
  AGENTS.md repository-map maintenance only; no contract edit.
- Capability prerequisites: none beyond current main. No registry, board, composer,
  OpenSpec runtime or built-in route package is required.
- Dispatch order: after roots-config promotes due to lane.mjs/config overlap. This
  is shared-file sequencing, not a dependency on new review infrastructure.
- Contract: no AGENTS.md amendment. The new guide protocol permits this bounded
  review command and its public record writer, replacing the earlier blanket CLI
  writer exclusion. No enforcement of review as a promotion gate or job system.
- Delivery: lane/review-cli, route engineer; High; one focused engineering session.
- Non-goals: no fixes, engineer redispatch, automatic escalation, review loop,
  contrib wrapper, scheduler, leases, job store, background watcher, commit or push.

See [design](design.md), the [dispatchable task](tasks.md), and the
[shared workflow](../../README.md).

Pre-agreed split: R-i review-private ends at validated private evidence with no
public output; R-ii review-public adds sanitization and guarded publication. See
the [requirement/test partition](design.md#pre-agreed-split-point); choose before dispatch.
