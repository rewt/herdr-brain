**PASS**
Schema: lane-review/v1
Reviewed commit: 7cdbb3145d604150fbabd78ec09a8c01df3eefff
Topic: case07-notice-budget
Round: 1
Review ID: lr-e1e0a0b25081aebfddb67de19d456a1b
Base branch: main
Base commit: 248bd4d7ed4c81f8dd000dca9f3032008d1efe42

## Findings
- [Minor] acceptance/test/deadlines.test.mjs:139 - the regression floor is count x (poll + confirm) with no margin, so it enforces only the 39 s lower bound and not the requirement's "plus a margin" (a limit of exactly 39000 ms would satisfy the test although real delivery also pays Herdr adapter calls and owner start-up); Fix: add an explicit minimum margin to the floor, for example needed = notices x (poll + confirm) x 1000 + 10000, or assert limit is strictly greater than needed by at least one poll interval.

## Re-executed
```json
[{"command":"node --test acceptance/test/deadlines.test.mjs","cwd":"lane","exit_code":0,"result":"TAP summary: tests 7, pass 7, fail 0, cancelled 0, skipped 0; the new case 07 test reported ok 7. The output was piped through tail and the shell did not capture the runner's own exit status, so exit_code 0 is inferred from the summary and tests_pass is left false.","tests_pass":false,"witness":{"kind":"negative-control","command":"node --test --test-name-pattern='case 07' acceptance/test/deadlines.test.mjs","cwd":"scratch","exit_code":1,"result":"Scratch export of the reviewed commit with acceptance/run.mjs replaced by the base commit version: tests 7, pass 0, fail 1, six other tests skipped by name pattern; scratch copy removed afterwards.","observed_failure":"not ok 7 - case 07 waits for its promotion notices at least as long as the default delivery cadence; error: case 07 waits 25000 ms for 3 notices; default delivery needs at least 39000 ms"}}]
```

## Non-claims
None

## Unverified
- The live case 07 wait was not exercised; the release acceptance harness runs once per release candidate and was not run in this review.
- The lane-run exit status of the deadlines test was not captured directly (pipe through tail); only its TAP summary was observed, and the run budget allowed one run.
- Delivery-time estimate per notice (about 13 s plus Herdr adapter call overhead) is derived from reading the inbox owner and stand-in source, not measured.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
