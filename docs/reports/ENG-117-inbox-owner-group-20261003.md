---
run: R-146
outcome: done
summary: |
  Confirmed that a live detached inbox owner has a different process group from
  the test and reproduces the reported teardown refusal. Fixture teardown now
  accepts the owner's own group, pins its birth identity and exact recorded
  command, and checks transport children against that confirmed group.
  Reused PIDs with a different command or birth identity are treated as gone
  without signalling the replacement; ambiguous ownership still fails closed.
  Added a real detached after-hook regression and identity/refusal tests.
  Full offline validation, fast validation and three extra round-cap passes passed.
headline: Fixture teardown safely stops live detached inbox owners
blockers: []
proposals: []
learnings:
  - "The bounded test runner normally forces product spawns into its suite group; a genuine detached-owner regression must use the existing fixed detached-fixture entrypoint."
  - "An inbox owner leads its own process group in ordinary execution; its transport children inherit that group, rather than the test caller's group."
  - "A terminated direct child can remain a zombie briefly before its parent reaps it; teardown and regression checks treat that state as gone."
artifacts:
  - "Implementation commit ec680e9e37f9132dafc539a9998961f270430335"
  - "Branch lane/inbox-owner-group"
  - "test/helpers/inbox.mjs"
  - "test/inbox.test.mjs"
  - "settle/test/teardown.test.mjs"
  - "settle/test/helpers/detached-inbox.mjs"
  - "npm test (baseline and after change): passed"
  - "npm run test:fast: 140 passed"
  - "node test/helpers/run.mjs test/inbox.test.mjs settle/test/teardown.test.mjs: 18 passed"
  - "node test/helpers/run.mjs settle/test/round-cap.test.mjs: three additional passes, 10 tests each"
  - "/tmp/r146-after-npm-test.log"
  - "/tmp/r146-fast.log"
  - "/tmp/r146-targeted.log"
  - "/tmp/r146-round-cap-1.log"
  - "/tmp/r146-round-cap-2.log"
  - "/tmp/r146-round-cap-3.log"
decisions:
  - text: "Accept a confirmed owner's detached group while retaining support for the bounded runner's contained test group, and signal only individually confirmed processes."
    category: tooling
    why: "The product deliberately detaches its inbox owner, while offline test containment deliberately keeps ordinary fixture processes in the suite group."
questions: []
challenges: []
---

The hypothesis is confirmed. Before changing teardown, an offline call to the
real `resumeInbox` produced owner PID/group 62653 and caller group 62379. Its live
command matched the recorded argv exactly, but `stopFixtureInbox` threw
`Cannot confirm fixture inbox owner identity`. The new detached regression also
failed in its after-hook with that exact error against the original helper.

Teardown now permits the recorded command in either its own detached group or
the bounded test group. It pins the live birth/command tuple and retains fresh
identity checks immediately before each individual signal. The suspended-owner
snapshot must retain the confirmed group, and transport children must belong to
that group. A changed command or birth means the original owner is gone; the
replacement is never signalled. Invalid metadata, unavailable or incomplete
process lookups, and unexplained group membership retain the refusal behavior.

The real regression uses the existing fixed detached-fixture launcher and native
deadline wrapper. It calls the product launcher, verifies a live owner in a
separate group with matching recorded argv, ends the test body, and stops the
owner in the test's after-hook. It does not change general test containment.
The updated unrelated-process integration test verifies that fixture deletion
succeeds while the foreign process remains alive. Fourteen deterministic tests
cover detached and contained transport cleanup, owner absence/zombies, PID reuse
before and after suspension, ambiguous ownership, and escaped transport refusal.

Validation:

- Baseline `npm test`: passed (copied-entry 2; core/modules 662 passed, 11 skipped;
  cycle 138 passed).
- After-change `npm test`: passed (copied-entry 2; core/modules 676 passed,
  11 skipped; cycle 139 passed). This includes all settle suites, the discovered
  settle-settings case, round-cap, and the new detached regression.
- `npm run test:fast`: 140 passed.
- Targeted inbox/teardown suite: 18 passed.
- Three additional complete round-cap runs: 10 passed each, including
  `cap reached still dispatches for Major, FAIL or red validation` every time.
- `git diff --check`: passed.

No live acceptance harness was run. Per the brief, the final operation after
checking and committing this report is `node lanes/lane.mjs check`; its result
for the final committed tree is recorded in `.lane/gate.json`.
