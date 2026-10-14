# Safe retirement final fix round

Run: R-414. Source commit: `915e7ddd7fec1d93eae32a21169ff078929b859f`.
Review: `docs/reviews/safe-retirement/4d742b5-r1.md`. All four accepted Minor findings are fixed.

1. The acknowledgment fixture persists `preReadyObservation` in fake Herdr state
   and captures retirement catch-up errors before ready. It asserts both remain
   absent, in addition to the existing completion and close checks.
2. After apply, the consumer checks the clock, deferred results and deadline
   diagnostics before writing handled.json. Owner-lookup catches propagate
   RETIREMENT_DEADLINE. A fixture crosses the deadline in the final candidate's
   owner lookup and verifies deferred, pending, no handled receipt and no close.
   Separate fixtures cover returned skip-close at expiry and late diagnostics.
3. The acknowledging iteration runs start catch-up only if no job was dequeued.
   Per-job cleanup and finally remain in place. A legacy refused-job fixture
   records every catch-up observation and requires current=null with its result
   already persisted. Existing promotion fixtures now wait for deferred catch-up
   after persistence, retaining their operator/other-lane protection assertions.
4. ENOENT during receipt unlink is harmless. Other post-close pruning errors are
   logged diagnostics and preserve the closed result. Fixtures simulate a competing
   pruner deleting an absent receipt after its read, and ENOENT/EACCES after a
   successful native tab close. The former still permits remaining closes; the
   latter never reports close-failed.

Final positive verification used only the affected test files:

```sh
node test/helpers/run.mjs test/retire-lock.test.mjs test/retire-paths.test.mjs promote/test/promote.test.mjs
node --test test/retire-lock.test.mjs test/retire-paths.test.mjs promote/test/promote.test.mjs
```

The plain invocation inherited an isolated fake Herdr environment from
`offlineHerdr()` and used no runner/preload. Results:

- `gate.tap`: 66 passed, 0 failed, 0 skipped; 66.279 seconds; exit 0.
- `node-test.tap`: 66 passed, 0 failed, 0 skipped; 65.759 seconds; exit 0.
- Syntax and diff checks passed. No surviving fixture was reported.

The acknowledgment test was also checked negatively in a disposable product copy.
Only its promote ordering was rewound: consumeRequests/retryCleanup moved before
the drain loop and the ready block ceased running them. The live lane source was
never reverted. The strengthened test and helpers were copied alongside it and
run with isolated fake Herdr state:

```sh
node --test --test-name-pattern='^promote sends its ready acknowledgment before observing a pending retirement hint$' SCRATCH/test/retire-paths.test.mjs
```

`ack-order-negative.patch` records the exact ordering mutation.
`ack-order-negative.tap` records the expected exit 1: one selected test failed
with `retirement observed before ready` (`actual: true`, `expected: false`);
the other 27 tests were excluded by the name pattern. This proves the regression
test rejects the old ordering even when finally later completes cleanup.
The disposable copy was removed after the check.

An initial positive run found two existing assertions sampling before deferred
catch-up had executed. They now await that observation after the result appears;
the final results above cover the committed source. No broader suite, live pane
cleanup, housekeeping start outside fixtures, model call, release, lane integration
or push was performed. The generic keep-only reference format and remaining
retirement rules are unchanged.
