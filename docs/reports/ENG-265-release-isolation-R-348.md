---
run: R-348
outcome: done
summary: |
  Fixed both requested release-tier test failures without changing product code. Every offline live-session fixture launch now supplies scratch primary and compatibility slot paths and clears inherited slot tokens; a test-only entry wrapper restores those paths after live-worker scrubs its environment. Added a full-file foreign-holder decoy guard and corrected the Codex headless resume fixture to exec resume session. Acceptance validation passed all four tests, including native offline promotion and the decoy guard; all 55 supervisor entry tests passed. Code is committed, and the checked report is committed before the required final focused lane check.
headline: Both remaining release test failures are fixed and focused checks pass.
blockers: []
proposals: []
learnings:
  - acceptance/security.mjs sessionEnv keeps only language and terminal settings from its input before rebuilding scratch homes. Supplying slot paths to live-worker alone cannot preserve them in its child; offline fixtures must restore both paths after that scrub.
  - A foreign-holder isolation guard must redirect the scratch installation's default compatibility slot too, so missing explicit paths fail against the decoy instead of accessing the real host slot.
artifacts:
  - 'Code commit: 7cfde83 on lane/release-isolation'
  - acceptance/test/live-session.test.mjs
  - supervisor/test/entry.test.mjs
  - '/private/tmp/R-348-live-session.tap: 4 passed, zero failed or skipped'
  - '/private/tmp/R-348-focused.tap: all 55 supervisor entry tests passed; acceptance fixture launcher development failures are retained in this first-attempt log'
  - docs/reports/ENG-265-release-isolation-R-348.md
  - /Users/rewt/development/rewt/.org/runs/R-348/report.md
  - '.lane/gate.json: final focused lane-check receipt, written after the report commit'
decisions: []
questions: []
challenges: []
---

The fixture applies scratch slot settings to every direct child, including
discovery setup, installation, record reads, Git and worker launches. Both
MONITOR_TEST_SLOT_PATH and MONITOR_TEST_SLOT_COMPAT_PATH name the fixture's
test-slot.lock. Modern and legacy holder tokens, wait overrides and retry
markers are removed. A shell wrapper in the scratch installation sets both
paths and unsets both tokens immediately before executing the real installed
entry adapter, after the unchanged live-worker's environment scrub.

The added guard starts a sibling process with a live kernel identity and a
scratch foreign-holder lock. It verifies TEST_SLOT_HELD before and after
rerunning the complete live-session file under decoy path overrides and
sentinel tokens. The nested fixture changes only its copied installation's
default slot constant to that decoy. All three original cases pass, including
concurrent promotion and answered routing through native offline sandbox
requests; the nested guard skips itself to prevent recursion. The foreign
holder's lock bytes remain unchanged. The worker receipt also verifies both
scratch paths and the absence of both inherited tokens.

The supervisor fixture now supplies Codex exec resume session for headless
resume. Claude's --print cases and the product classifier are unchanged.

Validation:

- node test/helpers/run.mjs acceptance/test/live-session.test.mjs
  passed: 4 tests, 4 passed, zero failures, cancellations or skips.
  Its nested decoy run passed all 3 original cases and skipped only recursion.
- node test/helpers/run.mjs acceptance/test/live-session.test.mjs supervisor/test/entry.test.mjs
  initially completed all 55 supervisor entry tests successfully. A typo in
  the generated acceptance shell wrapper caused 3 acceptance failures; the
  decoy guard also caught the missing primary path. The typo was corrected
  before the fully green acceptance rerun above. One initial promotion was
  refused by an already-held real slot; this run never acquired the host slot.
- git diff --check passed before the code commit.

The test commands used approved escalation for scratch Unix sockets, native
macOS sandboxing and process identity checks. They stayed offline and invoked
no model. No baseline, npm test, promotion or release tier, live acceptance
harness, or project housekeeping loop ran.

After checking this report with the record CLI and committing its repository
copy, the final action is:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs acceptance/test/live-session.test.mjs supervisor/test/entry.test.mjs'
```

The resulting .lane/gate.json and immutable validation log identify the final
report commit and test counts. This report does not predeclare that result.
