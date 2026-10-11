**PASS**
Schema: lane-review/v1
Reviewed commit: 6a3f6caf0785a91be4a5c2143d15641372cc2e65
Topic: release-fixture-isolation
Round: 1
Review ID: lr-bb3fa0239258d477b7d3f6a9845ccae0
Base branch: main
Base commit: 52d9d8e8e3d38b4f4e170c5b8f01d003aa382c65

## Findings
- [Minor] promote/promote.mjs:322 - With the new zero default cap, the caller-side drainInbox in promptSupervisor always reaches notify before the owner can finish its confirmation pair (either the owner holds the drain lock, or the caller's quiet loop cannot fit confirmSeconds inside a zero deadline), so every promotion notice now raises a Herdr desktop notification titled Promotion notice undelivered with a sound and journals notified plus a later waited event even when the supervisor composer was idle; before this change that happened only when the caller lost the drain-lock race or input was busy; Fix: keep queue accounting non-blocking but avoid the deterministic false alarm, for example default to a small cap that fits one confirmation pair (confirm seconds plus one, mirroring the owner floor in ownInbox) when SUPERVISOR\_INPUT\_WAIT\_SECONDS is unset, or skip the caller-side notify when waitSeconds is zero and an acknowledged owner pid exists, and add a fake-Herdr assertion that an idle composer produces no notification show call
- [Minor] promote/test/promote.test.mjs:94 - The owned-root assertion runs over every collected inbox before any stopFixtureInbox call, so a single out-of-root destination throws before the fixture's own in-root inbox owners are stopped and skips the later rmSync of the fixture root, leaking a detached owner worker and the temporary directory on exactly the refusal path this guard exists for; Fix: partition the set, stop only in-root inboxes, then assert that the out-of-root list is empty (or collect the refusal and rethrow after stopping owned inboxes) so rejection still fails the test without leaking fixture-owned processes

## Re-executed
```json
[]
```

## Non-claims
- This review executed no build, test, or check command and makes no fresh test claim.
- The sealed focused receipt for this lane was read as inherited evidence only; its committed-file hashes were compared with the reviewed commit by read-only inspection.
- No full promotion gate, release gate, or RC-19 replay is claimed from this lane evidence.

## Unverified
- Run budget was zero, so neither new regression test, the negative-control mutants, nor the existing explicit-wait coverage was executed by this reviewer; reliance is on the supplied focused receipt and controls summary.
- The notification behavior described in the first finding was established by reading drainInbox and promptSupervisor control flow, not by executing a fake-Herdr witness.
- Production owner-window behavior under a long busy period (one capped journal line per short window) was reasoned from ownInbox source, not measured.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
