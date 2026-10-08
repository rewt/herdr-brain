---
run: R-319
outcome: done
summary: |
  Fixed notice-lock release and dead-owner recovery to verify the expected owner PID, unlink only owner.json, and remove only the empty lock directory. ENOTEMPTY and ENOENT during rmdir are treated as completed cleanup, preserving any contender that published in the gap. Seven focused lock tests and all requested train, promotion and delivery tests passed. The implementation is committed; this report and evidence are committed before the final lane check.
headline: Notice lock release and recovery now preserve a contender's newly published lock.
blockers: []
proposals: []
learnings: []
artifacts:
  - 34d40d762a07b1a8c891e30aa6e7ba9d330d1a22 - implementation and deterministic regression tests
  - lane/notice-lock-release
  - supervisor/notice-lock.mjs
  - supervisor/test/notice-lock.test.mjs
  - supervisor/docs/R-319-report.md
  - docs/reports/evidence/R-319/focused-tests.tap
  - docs/reports/evidence/R-319/promote-tests.tap
decisions: []
questions: []
challenges: []
---

Confirmed the reported mechanism: POSIX rename can publish a contender's
nonempty candidate over the empty directory left after owner.json is unlinked.
Recursive release and stale-owner recovery could then remove or fail on the
contender's live lock. Both paths now use the same ownership-checked helper;
recovery retains its serialization guard and rechecks the dead owner's PID
before unlinking. Recovery guards receive the same safe release behavior.
Other filesystem errors still propagate.

The deterministic tests intercept owner.json unlink, perform a real contender
rename before rmdir, and verify that the contender's exact owner bytes survive.
Release succeeds and remains idempotent. Recovery refuses acquisition when the
injected live contender holds the lock, preserves it, and releases its guard.
Additional tests cover ordinary release, a changed owner, ENOENT at rmdir,
ordinary dead-owner recovery, and refusal of live or unidentified owners.

Validation:

- Seven new notice-lock tests passed.
- All 33 promote/test/train.test.mjs tests passed, including the originally
  failing interrupted-validation regression.
- All 18 supervisor/test/delivery.test.mjs tests passed.
- All 24 promote/test/promote.test.mjs tests passed outside the sandbox.
- Across these four files, all 82 distinct tests passed without skips.
- git diff --check passed before committing the implementation.

The first combined run passed 68 tests and failed 14 promotion tests with
EMFILE from fs.watch. A minimal fresh temporary-directory watcher reproduced
EMFILE inside the sandbox and succeeded outside it. The unchanged promotion
file then passed all 24 tests outside the sandbox. Both TAP logs are retained.
Tests used the offline bounded runner and temporary fixture slots; the host
test slot was not acquired.

Combined command (sandboxed):

    env -u ORG_DIR -u ORG_ACTOR -u HERDR_AGENT_NAME node test/helpers/run.mjs supervisor/test/notice-lock.test.mjs promote/test/train.test.mjs promote/test/promote.test.mjs supervisor/test/delivery.test.mjs

Promotion rerun (outside the sandbox):

    env -u ORG_DIR -u ORG_ACTOR -u HERDR_AGENT_NAME node test/helpers/run.mjs promote/test/promote.test.mjs

After copying this report to the requested record path, record check and the
report/evidence commit, the final command checks the clean final commit using
the focused lock regressions, without acquiring the host test slot:

    env -u ORG_DIR -u ORG_ACTOR -u HERDR_AGENT_NAME node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs supervisor/test/notice-lock.test.mjs'

No report edit follows that check.
