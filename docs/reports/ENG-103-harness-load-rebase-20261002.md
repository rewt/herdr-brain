---
run: R-137
outcome: done
summary: |
  Rebased the reviewed lane onto main and resolved the verification, settle fixture and acceptance runner conflicts while preserving both upstream lifecycle behavior and measured timeout classification. No additional implementation changes were made. The fast tier passed 140 tests; the single npm test invocation passed 661 core tests with 11 skips and all 114 cycle tests. Focused offline acceptance checks passed all 34 tests.
headline: The harness lane is rebased with both behaviors preserved and tests passing
blockers: []
proposals: []
learnings:
  - Early fixture cleanup must derive its inbox path from the already-created repository, because setup can fail before the later record-path binding is initialized.
artifacts:
  - Rebased commit Classify release-gate timeouts using measured machine load
  - Rebased commit Give each release acceptance case its own record actor
  - Rebased commit Preserve measured timeouts throughout acceptance cases
  - Commit Report harness-load rebase for R-137
  - /private/tmp/eng103-r137-fast.log
  - /private/tmp/eng103-r137-npm-test.log
  - /private/tmp/eng103-r137-offline.log
  - Final fast-tier lane check receipt .lane/gate.json; command output /private/tmp/eng103-r137-lane-check.log
decisions:
  - text: Combine the conflicting lifecycle guards, actor isolation and early cleanup with the lane's existing operation-scoped load handling.
    category: design
    why: The rebase must preserve both reviewed behaviors without extending implementation scope.
questions: []
challenges: []
---

Rebased onto main at **Briefs for ENG-113 (load-robust deadlines) and ENG-112
(settle teardown, standalone test file)**. Conflict resolutions are incorporated
in the replayed implementation commits; `git range-diff` confirmed the remaining
lane commits were preserved.

`acceptance/test/verification.test.mjs` keeps main's explicit sanitized child actor
and archive list, together with the lane's fixture actor restoration.
`settle/test/fixture.mjs` keeps injected measured commands and cleanup registration
before setup, and retains main's inbox-owner drain before directory removal. The
inbox path uses the existing repository binding so setup-time cleanup remains valid.
The rebase also conflicted in `acceptance/run.mjs`: both cleanup imports survive;
interruption guards remain before commands and cases, and inside measured wait
polls; per-case actors and operation-scoped timeout evidence remain intact.

Validation: `npm run test:fast` passed **140/140**. `npm test` ran **once**, passing
**661 core tests / 11 skipped / zero failures** and **114/114 cycle tests**.
Focused offline load-round2, verification and recovery suites passed **34/34**.
No live acceptance or `--skip-live` pass was run in this rebase-only round.
No files beyond conflict resolutions and this report were edited.

After record check and the report commit, the last command is
`node lanes/lane.mjs check`, using the declared fast tier. Its receipt will name
the clean report commit; this report does not predeclare that final result.
