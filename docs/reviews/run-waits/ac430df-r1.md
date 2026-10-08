**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ac430dfaf86806f2a5bc4abeec0506fbb077ff59
Topic: run-waits
Round: 1
Review ID: lr-1c87ab5de1189f4425110947dd28f1ca
Base branch: main
Base commit: da07cc67d049f0bb44f02ffcf136c3b6c47b53d8

## Findings
- [Moderate] lib/run-timing.mjs:45 - timedMemoryWait makes metadata-only timing a hard dependency of dispatch: emit appends and then calls persist (dispatch syncTiming, a record set child process) with no guard, so any record set failure (lock contention, CLI error) after entry aborts dispatch before the wait, after a granted wait it aborts before lane open or worker launch, and in the catch path it replaces the original DISPATCH\_STOPPED error so a supervisor STOP that dispatch reports as result stopped with exit 0 becomes result failed with exit 1; watch already treats the same kind of write failure as non-fatal; Fix: make telemetry best-effort in dispatch by wrapping persist (and the companion append) in emit with a catch that logs to stderr and leaves the missing evidence visible, and always rethrow the original wait error, with a test where persist throws during a stopped wait and dispatch still reports stopped.
- [Moderate] lib/run-timing.mjs:52 - process\_end is fixed at the first eligible idle/done observation and never revisited, but watch itself does not treat a mid-run idle after observed work as final (it waits out idle report grace and treats a resume to working as a new attempt), so a worker that idles waiting for input or a supervisor reply and then resumes gets a process\_end that precedes its real terminal state, understating time to process end and inflating the report gap the ENG-287 ask wants measured; Fix: record process\_end only on the observation watch treats as final (terminal state with a valid report, gone, or idle/done after idle grace expires without resume), or allow a later terminal observation after an observed resume to supersede the earlier one, and add a test with idle then working then done.
- [Minor] dispatch/dispatch.mjs:254 - syncTiming runs unconditionally on every dispatch pass after the run checks, appending a run.updated event with an unchanged dispatch\_waits value on every recovery or retry even when no new timing event was journaled; Fix: skip the record set when the serialized value equals the run's current dispatch\_waits metadata already read at that point.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: dispatch/test/dispatch.test.mjs
- Test evidence not re-executed: dispatch/test/timing.test.mjs
- Test evidence not re-executed: promote/test/metrics.test.mjs
- Report record-check validation not independently executed.
- The new dispatch integration test in dispatch/test/dispatch.test.mjs is not part of the supplied gate command, so the inherited log carries no evidence for the end-to-end dispatch journaling and dispatch\_waits mirroring path.
- Worker-reported watcher checks run outside the fs.watch restriction (10 passed) and main-module and tier coverage checks (36 passed) are not in the inherited log and are unverified claims.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
