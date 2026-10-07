# Bound test evidence validation

Run R-287, 2026-10-07. Tests were offline and used disposable Git repositories,
scripted independent reviewer transport, real settle/supervisor/promotion CLIs
and isolated test fleets. No promotion/release suite or live acceptance harness
was run in this lane.

- `focused.log`: direct bounded runner on affected-tests, test-evidence, train,
  autopilot, lane-validation and tier-plan test files: 138 pass, two fs.watch
  EMFILE failures under the worker sandbox. The train and autopilot files passed
  in full, including deferral -> bound queue -> one extra test -> silent closure.
- `validation-retry.log`: the two filesystem-watch checks, rerun with host
  permissions: 2 pass, 0 fail.
- `final-evidence.log`: final selection, patterned-step deduplication, recorded
  re-execution and stale-receipt checks: 5 pass, 0 fail.

Commands:

```sh
node test/helpers/run.mjs promote/test/affected-tests.test.mjs settle/test/test-evidence.test.mjs promote/test/train.test.mjs supervisor/test/autopilot.test.mjs lanes/test/validation.test.mjs test/tier-plan.test.mjs --file-timeout=480000 --suite-timeout=540000
node test/helpers/run.mjs --test-name-pattern='^(overlapping checks|promotion checks in different projects)' lanes/test/validation.test.mjs
node test/helpers/run.mjs promote/test/affected-tests.test.mjs settle/test/test-evidence.test.mjs --file-timeout=120000 --suite-timeout=180000
```

The final lane fast check is intentionally performed after committing the report.
Its authoritative receipt is the lane's ignored `.lane/gate.json`.
