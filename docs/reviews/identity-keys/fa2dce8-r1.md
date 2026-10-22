**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: fa2dce82540099e64bdfc23ac591b3f218de87b2
Topic: identity-keys
Round: 1
Review ID: lr-a96a86f9bd95e481338ce112c1e87cd5
Base branch: main
Base commit: 992d613bd93b41e4b7077b698c46865da628f9fc

## Findings
- [Moderate] lib/adopt-command.mjs:67 - The newly admitted parent identity settings receive only validateLane validation, which ignores project\_access and brain\_write shapes. A parent .lane.json with project\_access set to an object or brain\_write set to an array now reaches adoption publication. Those malformed defaults are written to shared identity.json before homeProject invokes validateIdentity, so adoption fails after publishing invalid identity state and leaves subsequent home discovery held; Fix: Validate the fully assembled identity defaults with validateIdentity before creating the identity record or publishing any home files, and add malformed parent grant and consent regressions that assert no identity intent or home policy publication.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/config-policy.test.mjs.
- Test evidence not re-executed: test/config-home.test.mjs.
- Test evidence not re-executed: lanes/test/routes.test.mjs.
- Test evidence not re-executed: lanes/test/identity-launch.test.mjs.
- Test evidence not re-executed: settle/test/config.test.mjs.
- Test evidence not re-executed: test/flow.test.mjs.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
