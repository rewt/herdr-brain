**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 2aa1cc79b0a6549bbba1ae6381a893f7736bc043
Topic: host-reservations
Round: 1
Review ID: lr-311def90358de2ad6ba55f6733c29a88
Base branch: main
Base commit: ad97e531073dd31e4e6cc885773415a4b55e5b40

## Findings
- [Moderate] promote/test/promote.test.mjs:55 - The promotion-tier queue fixture still puts both slot paths in a scratch directory under the realpath of the system tmp root, not under realpath(os.tmpdir()); its real lane promotions run promotion-tier validation through test-slot run, which now validates compat as private scratch and refuses with TEST\_SLOT\_LOCK\_PATH\_INVALID exit 75 wherever TMPDIR is elsewhere (the macOS default, and the condition the worker itself recorded), so the expected promoted outcomes in this promotion-tier file are likely refused; no worker TAP contains any of its cases, although the ask required confirming that every compat-setting test is admitted by the scratch rule; Fix: allocate this fixture's slot (and the other tmp-root roots in this file that reach validation) with mkdtemp under os.tmpdir() like test/helpers/bounded-test.mjs, or inherit the bounded-test slot variables, and run the file once to confirm.
- [Minor] test-slot/test-slot.mjs:504 - The timeout retry re-runs an EXCLUSIVE payload inside the held slot but the reservation expiry was fixed at acquisition plus one wall limit plus 30 seconds, so a retried proving attempt runs past its expiry and launch gates proceed while proving is still running; Fix: renew the reservation through slot.reservation.renew with a fresh wall-limit-plus-grace expiry before the retry attempt, still subject to the six-hour cap.
- [Minor] test-slot/test-slot.mjs:440 - The exclusive release wrapper calls reservation.release() first; if the reservation file was removed or changed by anyone else, owned() throws, so the legacy and workspace locks are never released by this run and the run fails with exit 2 instead of the payload status; Fix: catch a reservation ownership failure, report it on stderr, and still release the bridge locks once the group is confirmed gone, preserving the payload exit code.
- [Minor] lib/retire-runtime.mjs:150 - The new retirement loop over proving reservations has no test, although the report claims retirement keeps live and expired reservation references without pruning; the added retire test covers only a BCH occupancy/v1 row; Fix: add a test/retire.test.mjs case with a live and an expired-but-owned host-reservation/v1 row asserting a kept test-slot occupant reference and unchanged bytes.
- [Minor] board/render.mjs:20 - Any unreadable or unparseable file in an occupancy directory, including a corrupted shared occupancy row, becomes an unknown reservation row and is rendered with the Proving prefix and a withheld project, which mislabels non-reservation files as proving steps; Fix: render unknown rows with a neutral HOST\_RESERVATION\_UNKNOWN prefix (matching the wait output) instead of Proving.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Report record-check validation not independently executed.
- Test evidence not re-executed: test-slot/test/reservations.test.mjs
- Test evidence not re-executed: test-slot/test/host-paths.test.mjs
- Test evidence not re-executed: test-slot/test/shared.test.mjs
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs
- Test evidence not re-executed: test-slot/test/resources.test.mjs
- Test evidence not re-executed: lanes/test/reservations.test.mjs
- Test evidence not re-executed: dispatch/test/dispatch.test.mjs
- Test evidence not re-executed: promote/test/memory-gate.test.mjs
- Test evidence not re-executed: test/contracts-conformance.test.mjs
- Test evidence not re-executed: test/retire.test.mjs
- Test evidence not re-executed: test/board-view.test.mjs
- promote/test/promote.test.mjs was never run by the worker and was not executed here; whether its promotions are refused under the new compat scratch rule is inferred from code reading only.
- Four gate-profile cases (profiled STOP resume for validated and integrated checkpoints, pressure at project-lock, and queue coded memory refusal) failed in the stopped initial run and were not re-run after the legacy-holder fixture change; the worker attributes them to native process-source refusal, but only the queue memory-refusal case shows that receipt.
- The inherited validation log records no worker validation receipt at the captured tree; no suite result exists for this head.
- Astra T2 review and supervisor-opus agreement on the host-reservation/v1 name and location are merge preconditions in the ask and have no evidence in this delta.
- Whether an existing BCH-created compat occupancy directory satisfies the reservation writer's owned, no-group-or-other-access directory check was not checked against BCH source.
- The bash start barrier was reviewed on macOS semantics only; Linux behaviour was not exercised.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
