**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ac3b8edbc86a54c9ca281ca316293b90a04cabc2
Topic: continuation-cap
Round: 1
Review ID: lr-b82d08889ee09b14a872100404b20b58
Base branch: main
Base commit: ad97e531073dd31e4e6cc885773415a4b55e5b40

## Findings
- [Moderate] dispatch/dispatch.mjs:384 - Reuse checks only that the named prior run is reported or abandoned, never that no other open run currently holds the same occupant; with cross-item reuse now allowed, naming an older reported run whose worker was since reused by a still-open correction (worker idle or done before its report is ingested, or stopped mid-run) passes every check and prompts a second item's run into a worker that still serves an open run, breaking the documented rule that an open run cannot share its worker; Fix: before prompting (and ideally in preflight), refuse with REUSE\_WORKER\_BUSY when any unreported, unabandoned run started after the prior run shares its worker per sharesWorker in lib/worker-identity.mjs, and add a dispatch fixture for that case.
- [Minor] dispatch/dispatch.mjs:128 - liveWorker tags every failure in a reuse job as REUSE\_IDENTITY\_UNKNOWN, including later record-worker, watch and prompt stage failures such as a transient herdr or verify-agent error or an expired observation deadline, and it overwrites any code already on the error, so the advertised stable code misreports unrelated late failures; Fix: assign REUSE\_IDENTITY\_UNKNOWN only at the reuse-stage identity check and only when the error has no code, leaving other stages to DISPATCH\_FAILED.
- [Minor] dispatch/dispatch.mjs:493 - The failed JSON uses error.code when present, so Node system errors such as ENOENT from realpath or spawn surface as the stable dispatch code instead of DISPATCH\_FAILED, contrary to the contract table of dispatch codes; Fix: emit error.code only when it is one of the dispatch-owned codes (REUSE\_\*, FROM\_RUN\_\*, DISPATCH\_\*) and otherwise emit DISPATCH\_FAILED.
- [Minor] dispatch/README.md:68 - The inserted sentence ends with a period and the following line begins with lowercase the event-log transaction, leaving a broken sentence in the public guide; Fix: capitalize The event-log transaction on the next line or join the clauses with a semicolon.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: dispatch/test/dispatch.test.mjs.
- Test evidence not re-executed: settle/test/round-cap.test.mjs.
- Test evidence not re-executed: supervisor/test/supervisor.test.mjs.
- Test evidence not re-executed: supervisor/test/autopilot.test.mjs.
- Report record-check validation not independently executed.
- Release identity and phase B pilot evidence rows of the contract are placeholders by design; acceptance of the contract by Astra and of parity by opus is pending and outside this lane.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
