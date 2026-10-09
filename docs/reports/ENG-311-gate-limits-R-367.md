---
run: R-367
outcome: done
summary: |
  Committed explicit gate limits in .lane.validation.json: promotion wall 3600 seconds, release wall 7200 seconds, and promotion idle 900 seconds, preserving all existing keys. Added a regression that reads the project declaration and proves promotion and release wall limits and promotion idle resolve with source config despite healthy history.
  Both requested complete test files passed outside the worker sandbox: validation 19/19 and gate-profile 25/25. Implementation commit is b3a43e40 on lane/gate-limits. This checked report is committed before the required final fast-tier lane check; its receipt is written afterward.
headline: Explicit gate limits now give promotion and release more time
blockers: []
proposals: []
learnings: []
artifacts:
  - 'Implementation commit: b3a43e40'
  - 'Branch: lane/gate-limits'
  - .lane.validation.json
  - lanes/test/validation.test.mjs
  - docs/reports/ENG-311-gate-limits-R-367.md
  - /Users/rewt/development/rewt/.org/runs/R-367/report.md
  - /private/tmp/R-367-validation-host.log
  - /private/tmp/R-367-gate-profile-host.log
  - '.lane/gate.json: final lane check receipt follows this report commit'
decisions: []
questions: []
challenges: []
---

The committed per-tier maps match test-slot/README.md and lanes/validation.mjs.
Existing fast, promotion, release and promotion_tests declarations are retained.
These overrides take effect when the lane is promoted into the canonical checkout.

The regression copies this project's declaration into a disposable committed
canonical repository and resolves it through resolveValidation and resolveGateLimits.
Three healthy samples of 1001 seconds with 100 seconds of silence reproduce the
old promotion history limits of 2002 seconds wall and 300 seconds idle. The test
asserts promotion wall 3600 and idle 900, both with source config, and release wall
7200 with source config. Release idle still resolves from history, and fast has
neither explicit limit.

Verification:

- `node --test lanes/test/validation.test.mjs`: outside the sandbox, 19 passed,
  0 failed, 0 skipped (84.6 seconds).
- `node --test test-slot/test/gate-profile.test.mjs`: outside the sandbox,
  25 passed, 0 failed, 0 skipped (223.7 seconds).
- `git diff --check`: passed before the implementation commit.

The initial sandbox validation run passed the new regression but failed two
existing fs.watch fixtures with EMFILE. The initial sandbox gate-profile run
refused socket/PTY fixtures with PROMOTE_HOST_REQUIRED (EPERM); it was stopped
after the host rerun started. The complete host reruns above passed without code
changes. Fixtures used disposable test slots and isolated gate history. The
shared-history diagnostic reported only other origins, not a test-history leak.
No host test slot, broad npm test suite, promotion/release tier, live acceptance
harness or model was invoked.

After record check validates the external report and this copy is committed,
the last command is `node lanes/lane.mjs check` on the clean final commit. It
runs the default fast tier and writes .lane/gate.json. This report does not claim
that future receipt already exists.
