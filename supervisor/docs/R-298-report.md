---
run: R-298
outcome: done
summary: |
  Standalone console --print --keys C now refuses the chat request before creating a session or preparing a renderer, including the minimal profile. Added a regression that forbids React and Ink imports even when those packages are installed. In a git archive of the implementation commit without console/node_modules, all console tests and supervisor chat tests completed with 309 passes, no failures and 37 explicit optional UI skips. Audited the other added chat tests and verified routing and installed minimal interaction separately. The implementation is committed; this report and evidence are committed before the final lane check.
headline: Print mode now refuses project chat requests without loading optional UI packages.
blockers: []
proposals: []
learnings: []
artifacts:
  - b6e1a446684e3b152f31b09439a3d5195ceb2d7d - implementation, documentation and import-blocking regression
  - lane/project-chats
  - console/app.mjs
  - console/test/print-chat.test.mjs
  - console/evidence/ENG-248/scratch-proof.txt
  - console/evidence/ENG-248/without-ui-tests.tap
  - console/evidence/ENG-248/chat-routing-tests.tap
  - supervisor/docs/R-298-report.md
decisions:
  - text: Refuse a standalone print chat request after argument and project validation but before session creation.
    category: tooling
    why: A read-only action refusal needs no snapshot renderer or optional UI packages, including in merge-queue scratch checkouts.
questions: []
challenges: []
---

Addressed correction round 2's merge-queue refusal. The optional minimal renderer
was already dynamically imported, but minimal refresh prepares it before handling
keys. The standalone --print --keys C path now emits the refusal directly after
the existing config, project and size checks. It performs no session reads, tab
creation, focus changes or agent launches. Longer key sequences retain the
existing snapshot behavior; rendering a minimal snapshot still requires its
optional UI packages. No existing test was weakened or changed.

The new console regression rejects every react or ink import with a Node loader.
It covers full and minimal config preferences with default, modern, minimal and
explicit profile flags. Invalid print dimensions still fail normally.

Proof used git archive HEAD at b6e1a446684e3b152f31b09439a3d5195ceb2d7d,
extracted to /private/tmp/R-298-no-ui-b_t46v0a without installing packages.
console/node_modules was absent before and after validation. The exact commands
and TAP logs are saved under console/evidence/ENG-248/.

- All console/test/*.test.mjs: 329 tests, 292 passed, 0 failed, 37 skipped.
- supervisor/test/chats.test.mjs: 17 tests, 17 passed, 0 failed, 0 skipped.
- Combined: 346 tests, 309 passed, 0 failed, 37 skipped; every skip explicitly
  identifies absent optional Ink/React packages. The previously failing print
  chat refusal test ran and passed for all three profiles.
- Other added tests were audited: modern console tests require no UI packages;
  the minimal interaction test uses the established optional-ink skip helper;
  supervisor entry and dispatch tests import no optional UI.
- The two added entry/dispatch routing regressions also passed in that scratch
  (2 passed, 0 failed; 87 other tests excluded by the name filter).
- The minimal C interaction regression passed in the installed lane checkout
  (1 passed, 0 failed; 7 other tests excluded by the name filter).
- git diff --check passed before the implementation commit.

Tests were offline, with scratch fleets and fake Herdr; no model, live acceptance
harness or project housekeeping loop was run.

After copying this report to the requested record path, validating it with record
check and committing the report and evidence, the final command is:

    node lanes/lane.mjs check

That command records the clean final commit's fast-tier gate. No report edit
follows that check.
