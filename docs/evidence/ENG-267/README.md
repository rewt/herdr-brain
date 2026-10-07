# Bounded promotion extras

Run R-306 on ENG-267, 2026-10-07. Implementation commit: `ce73a12`.

The planner considers changed existing test files and release tests with direct
literal references to changed modules. Intermediate dependencies do not expand
the selection. Optional extras have a 300,000 ms estimated allowance and ten-file
ceiling; changed tests have priority over cheaper direct references. Bound
required evidence runs even beyond either limit, consuming the allowance first.

`test/helpers/test-durations.json` extracts the most recent per-file entries from
the tracked ENG-135 `measurements.json` after inventory (110 measurements).
Each entry retains its measurement timestamp; unmeasured files cost 60,000 ms.
The measured complete lane file cost is 342,215 ms. The allowance estimates
selection cost; existing execution deadlines and the release gate remain intact.

`batch-replan.json` applies the original ENG-262 batch's changed-path list to this
lane's current tree without executing a gate. The old transitive plan selected
88 extra files; the one-hop plan selects five, estimated at 263,141 ms, and defers
two to the release candidate with time-budget reasons. This is a planning
comparison, not a timing measurement or a rerun of the live batch.

Validation:

```sh
node --test promote/test/affected-tests.test.mjs
node test/helpers/run.mjs promote/test/affected-tests.test.mjs promote/test/train.test.mjs settle/test/test-plan.test.mjs settle/test/test-evidence.test.mjs
```

`planner.log`: seven tests passed. `focused.log`: 54 tests passed, zero failures,
cancellations or skips, 114.2 seconds. The focused set covers direct/deleted
references and cycles without transitive traversal, bounded core selection,
exact leaf selection, time and count deferrals, fallback costs, unconditional
required coverage, missing required files, full-file mixed-tier execution,
canonical planner trust, batch receipts, refusal of omitted requirements,
required-file union across lanes, and settle forwarding scoped evidence.
The canonical-planner tests read Git HEAD, so the committed implementation is
also checked separately after the implementation commit: `committed-canonical.log`
records two passing tests with the new planner and duration inventory materialized
from commit `ce73a12`, including required evidence beyond the default budget
and snapshot cleanup under a symlinked TMPDIR.

No baseline, full promotion/release suite, lane suite or acceptance harness ran.
Fixtures are offline and use scratch fleet and slot identities. No live panes,
project housekeeping loop or running batch were changed.
