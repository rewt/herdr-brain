---
run: R-127
outcome: done
summary: |
  Fixed all three review findings with offline regressions: retry context preserves measured timeout evidence, delegated settle and supervisor cases use load-aware bounded commands and waits, and timeout words in successful child tests cannot conceal independent assertion failures. The post-change core suite passed with 724 passes and 11 skips; acceptance coverage passed, including all 16 new round-two tests. The single allowed skip-live pass finished with 22 PASS, zero FAIL and five PENDING, retaining measured contention and deliberate live-discovery skips. Full live acceptance was not run under the operator's updated policy.
headline: All three timeout review findings are fixed with offline regression coverage
blockers: []
proposals: []
learnings:
  - Adding retry context must retain the original LoadTimeout instance and its operation-scoped samples; rebuilding from its message loses the measured classification.
  - Delegated acceptance cases require measured fixture commands as well as measured report and queue waits; fixture cleanup must be registered before setup and awaited on failure.
  - Typed process ETIMEDOUT establishes a child deadline. A timeout phrase in ordinary output does not; a failed TAP assertion takes precedence even if the child subsequently times out.
  - Nested Node TAP subprocess tests must omit inherited NODE_TEST_CONTEXT to obtain an independent test runner and meaningful exit status.
artifacts:
  - Commit Preserve measured timeouts throughout acceptance cases
  - Commit Report harness timeout review fixes for R-127
  - acceptance/commands.mjs, acceptance/limits.mjs, acceptance/run.mjs, acceptance/settle.mjs, acceptance/supervisor.mjs and acceptance/README.md
  - acceptance/test/load-round2.test.mjs, acceptance/test/load.test.mjs and settle/test/fixture.mjs
  - /private/tmp/eng103-r127-baseline.log
  - /private/tmp/eng103-r127-post.log
  - /private/tmp/eng103-r127-acceptance.log and /private/tmp/eng103-r127-targeted.log
  - /private/tmp/eng103-r127-skip-live.log
  - /private/tmp/herdr-acceptance-7kl5qJ/evidence/summary.json
  - Final lane check runs npm run test:acceptance after the checked report is committed; its exact clean commit receipt is .lane/gate.json and its log is /private/tmp/eng103-r127-final-lane-check.log.
decisions:
  - text: Preserve typed timeout identity when adding retry context and pass operation-scoped measurement into delegated cases.
    category: design
    why: Heavy-load deadlines remain harness PENDING through aggregate and dependent cases, while normal-load deadlines still fail.
  - text: Give independent failed TAP assertions precedence and retain child output alongside typed process errors.
    category: prover
    why: A successful test name mentioning ETIMEDOUT cannot excuse an unrelated product failure, including one preceding a later process deadline.
  - text: Use the complete offline acceptance suite for the final clean-commit lane check after the core suite has passed.
    category: prover
    why: The remaining commit contains only this report; the acceptance suite covers the changed harness code without repeating the eight-minute core run, consistent with the operator's test-overhead instruction.
  - text: Preserve the pre-existing untracked public review in a named local Git stash for the clean lane check.
    category: tooling
    why: The review was present before this run and is outside the requested implementation; a path-scoped stash preserves its exact bytes without adding it to the fixes.
questions: []
challenges:
  - premise: The baseline core suite completes within the supported nine-minute bound on this busy machine.
    evidence: Before code changes, the suite reached test 727 and expired at 540000ms; the existing lost lane-head response test also received null rather than status 1 after its child deadline.
    resolution: Preserve that baseline limitation. The same bounded post-change command completed in 510.85 seconds with 724 passes, 11 skips and zero failures, including the previously failing test.
  - premise: This lane should run a full live candidate acceptance gate.
    evidence: The operator's supervisor update, amended ask and AGENTS.md now reserve full live acceptance for one run per release candidate and allow lanes at most one skip-live pass when acceptance changes.
    resolution: Do not run full live acceptance or repeat the skip-live pass. The observed PENDING results remain NOT READY and do not establish complete live acceptance.
---

The three findings were read from the supplied private scratchpad in place; that
file was not copied into the repository. The lane was rebased onto main before
changes, then rebased again after the implementation commit to include **Amend
ENG-103/ENG-105 briefs: release gate per release, not per lane**. That final main
amendment changed only brief documentation.

Retry context now rethrows the same timeout object with its load samples. Offline
tests propagate heavy-load PENDING and normal-load FAIL through the retry check,
cutover aggregate and retirement prerequisite. Both delegated cases now measure
bounded child commands and report waits; supervisor also measures its queue wait.
Regressions inject actual bounded stalled children and missing report/queue
observations at heavy and normal load, and prove independent assertions remain
FAIL. Setup and command failures also prove owned fixture cleanup is awaited.

The mixed-output regression executes an actual TAP child containing a successful
test named `handles ETIMEDOUT` followed by an unrelated failed assertion. It stays
product FAIL, including when a typed process timeout is added afterward. Child
stdout and stderr are retained with process errors so earlier assertion evidence
cannot disappear. The fixture's default command behavior and ownership checks
remain intact.

Both baseline and post-change core commands were `npm test --
--file-timeout=480000 --suite-timeout=540000`, with their own ORG_ACTOR. The
post-change result was **724 passed / 0 failed / 11 skipped**. The complete offline
acceptance suite passed **106/106** before the final diagnostic-output strengthening;
the subsequent targeted run passed **33/33**, including all 16 round-two tests,
against the final implementation. The final lane check reruns the complete offline
acceptance suite on the report commit.

The one `acceptance/run.mjs --candidate lane/harness-load --skip-live` pass tested
**Preserve measured timeouts throughout acceptance cases** and took 274 seconds:
**22 PASS / 0 FAIL / 5 PENDING, NOT READY**. Settle and supervisor cases 24 and 25
passed. Cases 21 and 22 explicitly skipped live discovery. Case 19 retained a
cutover delivery timeout with measured load 27.62/28.08/29.14 on 18 CPUs; case 20
retained that prerequisite classification. Case 27 retained incomplete native
focus reads and named run peak load 55.17/33.62/31.00. Cleanup recorded zero owned
workspaces, zero errors, zero credential residue and zero retained discovery roots.

Full live acceptance was **not run**, because the operator and amended AGENTS.md
reserve it for release candidates rather than individual lanes. `npm run
test:lanes` was **not run**, because no `lanes/` files changed. No model sessions
were started. All tests used explicit actors and bounded waits; shared lane
configuration, live project code, activated releases, user bin/configuration,
foreign panes and contrib/settle-watch.mjs were not changed. No push or publication
occurred.

The pre-existing untracked `docs/reviews/harness-load/e110a6a-r1.md` remains
recoverable in the stash named **Preserve pre-existing harness-load review during
R-127 fixes** (stash object `18458e2342c183d9feb44f8d0d7b32f1ee1fb891`, untracked
tree parent `^3`). Its saved bytes were verified against the original SHA-256
`8d3b716a880b200e5ca705af45660c9e1280fd79ce2507a194ebc2bf3209d70f`.

After record check and the report commit, the last validation is
`node lanes/lane.mjs check --cmd 'npm run test:acceptance'`. Its receipt names
the clean report commit; this report does not predeclare that future result.
