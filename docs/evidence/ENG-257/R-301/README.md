# Canonical merge-train planning

Run R-301, 2026-10-07.

The train now calls `settle/test-plan.mjs`'s `canonicalTestPlan` with the
captured `attempt.base` and canonical repository. The existing materializer
copies regular blobs and transitive imports from that commit under the realpath
of the temporary directory, executes planning with the candidate as cwd, and
removes the snapshot. No second materializer was added. The bound required-test
check still requires every file to appear in the canonical plan's `files` or
`covered` list and refuses before validation if any file is missing.

Two new train regressions modify both the lane planner and its coverage import
to emit no supplemental files and claim the bound test is already covered.
With the previous product code both cases incorrectly promoted; the targeted
reproduction is in `regressions-red.log` (two failures, 31 unrelated cases
skipped). This was a defect reproduction, not a baseline suite.

With the fix, canonical selection runs the supplemental failing check once and
refuses integration; canonical omission refuses before running any gate.
Both cases prove that the lane's planning branch never executes, the canonical
planner inspects the candidate cwd and changed paths, the saved plan records
canonical coverage, and main and the lane tip remain unchanged.

The requested focused offline command is recorded in `focused.log`:

```sh
node test/helpers/run.mjs promote/test/train.test.mjs promote/test/affected-tests.test.mjs settle/test/test-plan.test.mjs settle/test/test-evidence.test.mjs
```

| File | Pass | Fail |
| --- | ---: | ---: |
| `promote/test/train.test.mjs` | 33 | 0 |
| `promote/test/affected-tests.test.mjs` | 4 | 0 |
| `settle/test/test-plan.test.mjs` | 2 | 0 |
| `settle/test/test-evidence.test.mjs` | 12 | 0 |

The initial sandbox run passed 50/51 with zero skips: the unchanged mixed-file
runner test failed because fixture cleanup could not obtain a process snapshot
(`Operation not permitted`, status 125). No test was changed to address that
environment failure. Re-running the affected-tests file with host permissions
passed 4/4; `affected-tests-retry.log` records that confirmation. The table gives
the final per-file results: all 51 requested tests passed. The canonical planner
tests also exercise symlinked TMPDIR materialization and snapshot cleanup.

After the implementation commit, the report is written to the run directory,
checked with `record check`, and committed in `docs/reports/`. The final command
is `node lanes/lane.mjs check --tier fast`; its ignored `.lane/gate.json` receipt
binds validation to the final report commit.
