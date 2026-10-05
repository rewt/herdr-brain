**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ebbfa140c5a6966b84aeabb4e71e0f8d2127e392
Topic: fleet-membership
Round: 1
Review ID: lr-dcc29be2a1e97a674b42dde43c794556
Base branch: main
Base commit: 7484c72ea4978b12772e2eceb9990f1c1589cfbf

## Findings
- [Major] lib/fleet.mjs:134 - Excluding an already joined checkout discards its project metadata for every reader, not just entry. With an external mapped record and no local .org, record status now discovers no record and initializes a second .org; lane commands also lose the mapped parent layers and worktree root. Later inclusion switches back to the original record, hiding work recorded while excluded; Fix: retain joined project metadata for record and configuration readers, gate entry and native sandbox generation separately on excluded, and add an excluded joined external-record regression test.
- [Moderate] lib/fleet.mjs:96 - The compatibility layout requires a canonical or ancestor .org and ignores an existing external record selected through ORG\_DIR. Such a project still finds its record, but creating a fleet elsewhere silently drops its parent settings, trusted profile and lane worktree root without an adoption prompt. This leaves the original discovery failure unresolved for a supported external-record layout; Fix: preserve the discovered settings and worktree layout for explicitly selected external records without automatically adopting an inherited record, print an explicit adoption command, and add before-and-after coverage.
- [Moderate] lib/fleet.mjs:106 - An unjoined neighbor with its own local .org passes the record ownership check and inherits the nearest parent .lane.json even when that layer is already mapped to another fleet project. The new lane and route fallbacks then import that project's routes, memory-profile arguments and lifecycle settings without explicit shared-layer adoption, restoring the settings leak described in ARCH-17; Fix: check canonical layer ownership before returning a compatibility layout, require explicit adoption to share another project's mapped layer, and add a neighbor test with a distinct local record.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion and release validation remain assigned to their designated batch and release gates.

## Unverified
None

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
