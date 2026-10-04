---
run: R-218
outcome: done
summary: |
  Moved native transport's bypass-flag refusal ahead of its environment and
  root checks, preserving all scratch-home, fleet, capability, permission and
  ownership protections. The unchanged results test and a new transport
  regression pass through the required bounded runner: six tests passed.
  The fix and red/green evidence are committed on lane/harness.
headline: Acceptance bypass flags now receive their own refusal before launch.
blockers: []
proposals: []
learnings:
  - The bounded runner injects HERDR_TEST_OFFLINE_ROOT and HERDR_SOCKET_PATH into minimal child environments; these correctly trip the native transport capability guard unless a bypass request is refused first.
artifacts:
  - '706b942: bypass refusal order, native transport regression and focused evidence'
  - 'branch: lane/harness'
  - acceptance/native-transport.mjs
  - acceptance/test/native-transport.test.mjs
  - docs/reports/evidence/ENG-137-R218/results-red.tap
  - docs/reports/evidence/ENG-137-R218/focused-green.tap
decisions: []
questions: []
challenges: []
---

The R-215 changes in `0358802` introduced `scratchProductHomes` into
`sessionEnv`, explicit fleet verification, and an allowlist for the six
scratch Herdr home/fleet variables in `native-transport.mjs`. Those six
variables are permitted and are not the observed leak. The required runner's
`fixture-policy.mjs` adds `HERDR_TEST_OFFLINE_ROOT` and `HERDR_SOCKET_PATH`
after `sessionEnv` scrubs the environment. The transport's capability guard
then runs before its argument loop and masks the bypass refusal. The retained
red run reproduces the exact reported assertion (four passes, one failure).

The fix scans every argument for the existing prohibited flag prefixes before
reading the job specification or checking its environment. No capability is
allowed or removed to accommodate the test runner. All original guards still
run before any native execution when no bypass flag is present. R-215's home,
fleet, validation and temporary-directory protections and R-217's owned fleet
creation grant remain intact. `acceptance/test/results.test.mjs` is unchanged.

`node test/helpers/run.mjs acceptance/test/results.test.mjs
acceptance/test/native-transport.test.mjs` passed all six tests. The new
regression checks `--yolo`, `--dangerously-bypass-approvals-and-sandbox`,
`--sandbox=workspace-write` and `--full-auto` with a deliberately leaked
`ACCEPTANCE_ROOT`, then checks the same environment without a bypass flag.
Each refusal leaves the native executable's marker absent; the last refusal
still reports `product entry leaked capabilities`. The existing results test
also verifies product FAIL and the safety display marker. Diff whitespace
validation passed.

This report is checked with the record CLI before its commit. The final action
is `node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs
acceptance/test/results.test.mjs acceptance/test/native-transport.test.mjs'`.
Its receipt in `.lane/gate.json` records validation of the final committed
head. The explicit command keeps validation within the requested test scope.
No acceptance pass or other test suite is run.
