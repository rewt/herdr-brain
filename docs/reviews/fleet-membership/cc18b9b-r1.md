**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: cc18b9bdf5e8b760b9cc712b397a06eb5d087ce2
Topic: fleet-membership
Round: 1
Review ID: lr-2c98bd3e9c0e8a8d35d697ae0e34cee8
Base branch: main
Base commit: 7484c72ea4978b12772e2eceb9990f1c1589cfbf

## Findings
- [Major] lib/fleet.mjs:154 - Excluding an existing unjoined project still discards its compatibility layout. With an unclaimed ancestor \`.org\`, no checkout-local record and no \`ORG\_DIR\`, \`findOrgDir\` returns null while excluded, so even \`record status\` initializes a second local record. That record then shadows the original history after inclusion; parent settings and worktree discovery also disappear. The joined-project regression does not cover this supported compatibility state; Fix: retain the ownership-checked legacy layout for excluded unjoined readers, gate entry and native sandbox generation separately, suppress adoption notices during excluded native launch, and add record-write and configuration coverage before, during and after exclusion.
- [Moderate] discovery/native-sandbox.mjs:14 - An excluded checkout with an outdated fleet checkout value for its matching Git identity still cannot launch natively. \`projectFleet\` throws for the stale mapping before returning \`excluded\`, so this exclusion guard is never reached and both adapters exit from their sandbox catch without spawning the native executable. A relocated checkout with a stable external Git directory can reach this state; Fix: check entered and canonical exclusions before resolving a mapped native session, retain stale-mapping checks for record and configuration readers, and add explicit and automatic Codex and Claude passthrough coverage for an excluded stale mapping.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion and release validation remain assigned to their designated batch and release gates.
- The optional native boundary probe was skipped in inherited validation; no independent native boundary claim is made.

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
