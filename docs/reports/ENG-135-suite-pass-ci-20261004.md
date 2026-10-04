---
run: R-202
outcome: done
summary: |
  Restored the fixture condition-wait helper that the suite pass removed while the memory-promotion regression still called it. Its deadline now uses the shared load-aware allowance; the regression's complete test body remains byte-identical to main. The requested offline test file passed all 143 tests. Implementation and evidence are committed; the final focused lane check follows this checked report commit.
headline: Restored the missing test wait helper while preserving promotion safety expectations.
blockers: []
proposals: []
learnings:
  - "The suite-pass patch deleted waitForCondition from lanes/test/lane.test.mjs but retained three calls in the memory-promotion regression; train CI failed with ReferenceError before exercising its safety assertions."
  - "The real-shell dispatch test needs /bin/ps process inspection. The sandbox denied that command, causing a fallback pane mismatch; the unchanged test passed with process-inspection access."
artifacts:
  - "b600bb8: Restore memory-promotion fixture condition waits"
  - "lanes/test/lane.test.mjs"
  - "docs/reports/ENG-135-suite-pass-ci-evidence-20261004/lane-tests.tap"
  - "docs/reports/ENG-135-suite-pass-ci-evidence-20261004/lane-tests-sandbox.tap"
  - "docs/reports/ENG-135-suite-pass-ci-evidence-20261004/train-failure-excerpt.tap"
  - "docs/reports/ENG-135-suite-pass-ci-evidence-20261004/review.txt"
  - "docs/reports/ENG-135-suite-pass-ci-evidence-20261004/commands.txt"
decisions: []
questions: []
challenges:
  - "The initial sandbox attempt passed the original memory-promotion regression but failed the /bin/ps-dependent shell test. It was cancelled through the identified runner's SIGTERM cleanup handler, and its partial TAP is retained. The same file then passed completely with process-inspection access."
---

The train log's sole failure was `waitForCondition is not defined`, originating at the first of three calls in ENG-116's memory-promotion test. The lane's earlier event-wait conversion removed that helper while retaining these callers. Main still defines the helper and passes the test.

The eight-line fix restores the helper and imports `loadTimeout` for its response allowance. The original predicates, timeout arguments, diagnostics, cleanup and safety assertions remain unchanged. A source comparison confirms the complete memory-promotion test body is byte-identical to main: it still requires the promotion lock to remain free during initial pressure, validation to start after pressure clears, fast-forward to finish despite renewed pressure during validation, matching branch tips and lock removal. Product code is unchanged.

Verification ran only `lanes/test/lane.test.mjs`, through the bounded offline runner with its existing long-file allowances:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 lanes/test/lane.test.mjs
```

Result: **143 passed, zero failures, cancellations or skips**, exit 0, 387.392 seconds. The original failing test passed in both attempts; the complete rerun also passed the shell test that the sandbox could not inspect. The retained TAP and source comparison support these results. Self-review and `git diff --check` passed. No full tier, host test slot, live harness, model call or promotion was used.

After report validation and commit, the requested final command selects the same single file with the default fast check tier, which does not acquire the host test slot:

```sh
node lanes/lane.mjs check --cmd "node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 lanes/test/lane.test.mjs"
```

Its final-head result is retained in `.lane/gate.json` and the Git validation receipt and log. This report does not claim that result in advance.
