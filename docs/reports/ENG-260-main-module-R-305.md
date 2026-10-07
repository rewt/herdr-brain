---
run: R-305
outcome: blocked
summary: |
  Restored the release candidate driver's self-contained realpath entry check and removed the helper from its partial-copy fixture. Strengthened the source guard for both operand orders, strict inequality early returns, module-path constants and duplicate realpath checks, with regression coverage.
  Implementation and completed evidence are committed as 97383682f86e0bb43af6f9d4dd70662dde1d9795. Script suites completed with 992 pass, 1 fail and 7 skips; the failure is installed discovery encountering an unrelated held host slot. Native validation passed at this head with native Codex on PATH.
  Both requested main/head native acceptance comparisons are deferred for the supervisor's proving window. Their queued host wrapper had already exited 75 after a 3600-second wait when cancellation was requested; no host-check process remains. The report is checked and committed next, followed by only the light focused guard/candidate lane check.
headline: Entry-point corrections are committed while host comparisons wait for the proving window
blockers:
  - "host checks deferred: bch-cloak proving window"
proposals: []
learnings:
  - "acceptance/test/validation.test.mjs discovers Codex with which; use a PATH where codex is the native executable rather than Monitor's managed entry wrapper. This run's native PATH resolves codex-cli 0.161.0, and the actual-native-transport case passes at this head."
artifacts:
  - "Implementation and regression evidence commit: 97383682f86e0bb43af6f9d4dd70662dde1d9795"
  - "Branch: lane/main-check"
  - "test/main-module.test.mjs"
  - "herdr/release-candidate.mjs"
  - "release/test/candidate.test.mjs"
  - "docs/evidence/ENG-260/R-305/commands.txt"
  - "docs/evidence/ENG-260/R-305/script-outcomes.json"
  - "docs/evidence/ENG-260/R-305/native-env.json"
  - "docs/evidence/ENG-260/R-305/host-checks.log"
  - "docs/reports/ENG-260-main-module-R-305.md"
  - "/Users/rewt/development/rewt/.org/runs/R-305/report.md"
decisions:
  - text: Keep the release candidate driver self-contained with its own realpath main check and a narrow duplicate-guard exception.
    category: design
    why: ENG-229 R-276 and ARCH-19 require build-only partial copies to carry this driver alone; the unsafe path comparison remains forbidden even in this driver.
questions: []
challenges:
  - "The original shared-helper acceptance clause has an explicit standalone-driver exception, as directed in this correction round; other product scripts retain the shared helper."
  - "The main snapshot is pinned to dd3f52c0391d242a5d6102f1ffa6a876f48e1620 from task start. Main advanced while the host checks waited. Neither deferred comparison has a claimed main outcome."
---

The two review corrections are implemented. The candidate imports only Node
built-ins and realpaths both launch and module paths, returning false on lookup
failure. Its original partial-copy fixture is restored byte-for-byte to main's
fixture and carries no lib/ helper. Existing candidate preparation/gate tests
and directory/file symlink probes pass.

The guard matches the argv/module comparison in both directions with `===` or
`!==`, including SELF, FILE and declared module-path aliases. The duplicate
matcher covers both directions and operators too. Regression checks include
whitespace and early-return forms and ordinary argv path resolution that should
remain permitted. The standalone exception applies only to duplicate checks;
it does not allow the unsafe resolved-path comparison.

Completed offline test batches:

| Evidence | Tests | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| helpers-head.tap | 112 | 112 | 0 | 0 |
| related-head.tap | 592 | 585 | 0 | 7 |
| acceptance-head.tap | 221 | 220 | 1 | 0 |
| slot-head.tap | 75 | 75 | 0 | 0 |

These four batches total 1000 tests, 992 pass, 1 fail and 7 skips. The helper
batch includes all 35 main-module tests and all 7 candidate tests. The seven
related-suite skips are existing explicit alternative-provider, Linux/kernel,
native-provider and live Herdr opt-ins. Exact commands, working directories,
exit statuses and counts are in script-outcomes.json. The related-file list plus
all top-level offline acceptance and direct slot tests cover every script
converted in R-302 and the already shared test helpers.

The unmodified original main-module test, copied to the pinned main snapshot
because main lacks that test file, plus main's unmodified candidate tests ran
under the real host slot: 41 tests, 14 pass, 27 expected failures. All 7 candidate
tests pass; the failures are the old entry-point comparisons and their symlink
probes. The earlier sandbox run recorded the same counts. These runs and the
35-pass guard development run overlap other evidence and are not added to the
1000-test total.

Offline acceptance's sole failure is case 142 in live-session.test.mjs:
`TEST_SLOT_HELD` names the unrelated `validate:all-safe` holder in bch-cloak's
lane-pool-funding-ancestry-v1 worktree. This is the existing fixture slot issue
tracked by ENG-265. The actual native transport validation case passes at this
head with native Codex on PATH; the former exit 125 does not reproduce in this
head run. No main/head regression conclusion is claimed without the required
in-slot comparisons. Existing ENG-264/ENG-265 work is not duplicated as proposals.

Both requested comparisons are deferred:

| Case | Pinned main in host slot | This head in host slot |
| --- | --- | --- |
| Actual native validation transport | Deferred | Deferred |
| Installed live discovery | Deferred | Deferred |

The queued wrapper waited 3600 seconds, then exited 75 while a promotion held the
slot. The comparison driver never started. The supervisor then instructed
cancellation, prohibited further heavy suites and specified the proving-window
blocker above. Read-only process inspection found no remaining queued wrapper;
its completed exec session confirmed exit 75. No live holder was interrupted or
lock removed. Resume these four checks after the proving window closes using
the documented native PATH and host-slot command.

The final lane check, after this report's commit, uses only
`node test/helpers/run.mjs test/main-module.test.mjs release/test/candidate.test.mjs`
via `lane check --cmd`, respecting the instruction to finish light focused tests
only. Its final GATE receipt is authoritative; no result is claimed in advance.
No aggregate promotion/lanes/core/release suite, live acceptance harness, model
call, project-wide housekeeping loop, promotion, merge or push was performed.
