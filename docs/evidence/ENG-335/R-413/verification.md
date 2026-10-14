# Safe retirement fix round 2

Run: R-413. Source commit: `20f9a85e292e14859c4b22f23d15cbc3f494659f`.
Review: `docs/reviews/safe-retirement/e87b684-r1.md`. All four accepted findings are fixed.

1. Retirement request and consume locks publish PID, kernel birth and a unique
   acquisition token atomically. Recovery uses the existing owner-liveness helper
   and rechecks under an owner-aware recovery guard. Live and unknown owners retain
   their locks; releases cannot remove a newer acquisition. Fixtures cover dead
   consume/request owners, a dead recovery guard, live/unknown owners and PID reuse.
   Supervisor entry lists retirement locks, including recovery guards, and gives
   consume its own cooperative deadline without an outer timeout or SIGKILL of
   the lock holder. Deferred apply keeps the hint pending and releases the lock.
   Pure and CLI fixtures cover partial apply, restart and a slow observation.
2. The promote drain sends ready after its existing durable queue checkpoint and
   before start-of-drain catch-up or cleanup retries. Settings refusals retain
   their existing behavior. A pending-hint fixture makes native observation refuse
   unless the acknowledgment has already been sent, then verifies cleanup occurs.
3. Apply deletes a callback receipt after a successful guarded tab close, and
   prunes receipts when the observed inventory proves their tab absent. Absent-tab
   receipts skip native owner inspection. Previews stay read-only and scoped apply
   retains receipts outside its observed workspace scope. Receipt bytes are checked
   again before deletion. Fixtures cover successful-close pruning, absent tabs and
   scope; token projection excludes pruning bookkeeping and unrelated callbacks.
4. settle-watch records watcher ownership only with --close-tab-on-exit, which
   --spawn already appends. A foreground watcher without the flag leaves no receipt
   and its ordinary canonical tab remains kept. Its installed path and flags remain.

Final verification used only these affected test files:

```sh
node test/helpers/run.mjs test/retire-lock.test.mjs test/retire.test.mjs test/retire-paths.test.mjs supervisor/test/entry.test.mjs promote/test/promote.test.mjs
node --test test/retire-lock.test.mjs test/retire.test.mjs test/retire-paths.test.mjs supervisor/test/entry.test.mjs promote/test/promote.test.mjs
```

The plain invocation inherited an isolated fake Herdr environment from
`offlineHerdr()` and used no suite runner/preload. Results:

- `gate.tap`: 145 passed, 0 failed, 0 skipped; 69.296 seconds; exit 0.
- `node-test.tap`: 145 passed, 0 failed, 0 skipped; 69.199 seconds; exit 0.
- Syntax checks and `git diff --check` passed. No surviving fixture was reported.

An earlier gated checkpoint passed 144 tests before the final CLI deadline case
was added; the final results above cover the committed source. Shared command-history
notices are host diagnostics. The optional keep-only herdr-reference/v1 source,
its exact format, record fold/exports and the remaining retirement rules are unchanged.
No live pane cleanup, housekeeping start outside fixtures, model call, release,
lane integration or push was performed.
