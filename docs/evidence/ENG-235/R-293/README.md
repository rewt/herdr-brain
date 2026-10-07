# Correction-round validation

Run R-293, 2026-10-07. All checks were offline, with disposable Git repositories,
scripted reviewer transport and isolated fleets.

| Test file | Final result | Evidence |
| --- | --- | --- |
| `promote/test/affected-tests.test.mjs` | 3 pass, 0 fail | `focused.log` |
| `promote/test/train.test.mjs` | 31 pass, 0 fail | `focused.log` |
| `settle/test/test-evidence.test.mjs` | 10 pass, 0 fail | `evidence-retry.log` |
| `supervisor/test/autopilot.test.mjs` | 87 pass, 0 fail | `focused.log` |
| `settle/test/test-plan.test.mjs` | 1 pass, 0 fail | `canonical-plan.log` |

The initial four-file run had 124 pass and seven failures (131 total). Those
failures were confined to test-evidence: a new fixture setup accidentally staged
its scratch record using `git add .`, so subsequent record writes made its
canonical checkout dirty. Setup now stages only the planner, its imported module
and the declaration. The entire test-evidence file then passed 10/10. The other
three files passed in full on the initial run. Together the final green checks
cover 132 distinct tests.

Commands:

```sh
node test/helpers/run.mjs promote/test/affected-tests.test.mjs promote/test/train.test.mjs settle/test/test-evidence.test.mjs supervisor/test/autopilot.test.mjs --file-timeout=480000 --suite-timeout=540000
node test/helpers/run.mjs settle/test/test-plan.test.mjs
node test/helpers/run.mjs settle/test/test-evidence.test.mjs --file-timeout=480000 --suite-timeout=540000
```

Regression cases prove that lane-modified planners and imports cannot shrink or
invent coverage; missing, failed, invalid and oversized plans cover nothing,
retain their errors and remain resolvable by recorded re-execution; and a
hand-written receipt with a matching filename/log hash but incorrect derived key
refuses. The real project planner also runs from the captured commit snapshot,
loads its transitive imports there and selects tests from the lane workspace.

Syntax checks and `git diff --check` passed. The final lane fast check follows
the checked report commit; its authoritative receipt is `.lane/gate.json`.
