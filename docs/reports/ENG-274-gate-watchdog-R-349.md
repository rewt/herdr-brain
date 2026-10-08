---
run: R-349
outcome: done
summary: |
  Rebased lane/gate-watchdog onto main 0d71dabd and reproduced both merge-batch failures before editing the fixtures. The legacy bridge regression also fails unmodified on main under the same delayed workspace-record publication, establishing a pre-existing test synchronization defect.
  Gate-profile fixture subprocess and readiness bounds now use loadTimeout; the five-gate bisection receives a finite compound command allowance. The legacy bridge fixture waits for both complete command-group records and scales its admission wait. Production watchdog limits and host-envelope arithmetic required no change.
  Both complete files passed all 66 tests plainly and under an outer scratch slot carrying batch wait/token/retry context, four busy loops and deterministic scheduling delays. The loaded outer run used one attempt and released its scratch slot. Implementation and evidence are committed in cf0bdf6. The required final lane check follows this checked report's commit.
headline: Both gate fixtures now pass under inherited slot context and load
blockers: []
proposals: []
learnings:
  - A child command's ready marker can precede publication of its process group in both migration locks; wait for complete matching group records before comparing them.
  - Compound synchronous fixtures need an explicit commandAllowance as well as a load-scaled timeout, because bounded-test otherwise clamps them to its ordinary command ceiling.
artifacts:
  - 'Implementation commit: cf0bdf6'
  - 'Branch: lane/gate-watchdog; rebased onto main 0d71dabd'
  - test-slot/test/gate-profile.test.mjs
  - test-slot/test/test-slot.test.mjs
  - docs/reports/evidence/ENG-274-R349/reproduce.mjs
  - docs/reports/evidence/ENG-274-R349/main-legacy-before.log.gz
  - docs/reports/evidence/ENG-274-R349/outer-before.log.gz
  - docs/reports/evidence/ENG-274-R349/plain-after.log.gz
  - docs/reports/evidence/ENG-274-R349/outer-after.log.gz
  - docs/reports/ENG-274-gate-watchdog-R-349.md
  - /Users/rewt/development/rewt/.org/runs/R-349/report.md
  - '.lane/gate.json: the final lane check writes its receipt after this report is committed'
decisions:
  - text: Correct fixture timing and synchronization without changing production watchdog behavior.
    category: tooling
    why: The failures are an external fixture response cap and a race between lock-record updates also reproduced in the unmodified main regression; neither is an incorrect production envelope or slot exclusion decision.
questions: []
challenges: []
---

The ask was correction 8, based on batch d729f572: a synchronous three-lane
bisection returned status null after 17.5 seconds, and the legacy bridge compared
a registered group PID with null. The lane rebased cleanly from d9566200 onto
local main 0d71dabd before reproduction.

The evidence runner holds only a disposable slot, with `--project-common` set
to its scratch directory and a disposable gate-history override. Both current
slot paths name that scratch slot; current and legacy wait settings are 7200,
the retry marker is 1, and the outer slot CLI passes both token variables to
the tests. Four owned, finite busy loops add contention. For repeatability on
a quiet host, a preload delays each fixture gate by three seconds and pauses
workspace group-record publication until the child marker appears, then another
500 ms. It retains that instrumentation in fixtures which replace NODE_OPTIONS.
These are controlled scheduling delays in addition to actual CPU load; this is
not a replay of the complete promotion batch.

Before either test edit, `reproduce.mjs outer` ran both complete files and
reported exactly the two requested failures: 64 passed, 2 failed. Bisection
returned null after printing three scratch validation attempts. The bridge
compared PID 63995 with null. The outer slot released normally with one attempt.

Before editing the legacy regression, `reproduce.mjs main-legacy` extracted
main with `git archive` into a disposable directory and ran its existing test
and product code unchanged under the same publication delay and scratch slot.
It failed with PID 36200 versus null. Main does not contain this lane's added
three-lane bisection regression. The main comparison establishes that the bridge
test already assumes publication has finished when the child marker exists.

Both files already use `testSlotEnvironment()`. Its existing regression checks
removal of both slot-variable prefixes, including paths, tokens, long waits,
retry state and future variables. Fixture child environments retain that scrub;
there was no remaining inherited-slot leak to fix in these two files.

The gate-profile changes scale the Git, host/queue subprocess, legacy kernel
probe and readiness bounds with `loadTimeout`. The bisection alone reserves a
55-second base compound response window through `commandAllowance`, below the
enclosing 60-second base test allowance. Both scale with load. This corrects the
fixture's external response cap; it leaves the asserted production envelope,
all five gate outcomes and the two healthy promotions intact.

The bridge now scales its ten-second admission wait and waits for both locks
to register the marker's PID with complete start and birth identities. It then
compares token, PID, start and birth, proves a legacy taker is refused, and checks
both locks disappear on shutdown. The synchronization is stronger than the old
marker-only check and retains the exclusion and release assertions.

Verification after the fix:

| Execution | Result | Duration |
| --- | --- | --- |
| Both full files, plain | 66 passed, 0 failed, 0 skipped | 69.8 s |
| Both full files, outer scratch slot, CPU load and scheduling delays | 66 passed, 0 failed, 0 skipped | 105.3 s |

The loaded outer receipt confirms command startup, no gate timeout, one attempt
and scratch-slot release. The test-process history guards reported no leak.
`git diff --check` and the evidence runner's syntax check passed. Compressed
logs and the runner are committed with the implementation. No model, broad
suite, promotion/release tier, live acceptance harness or real host slot ran.

After writing and checking the record report and committing this copy, the last
check is `node docs/reports/evidence/ENG-274-R349/reproduce.mjs lane-check`.
It invokes fast-tier `lane check` on the clean committed tree, selecting only
the two corrected scenarios, with disposable slot/history paths. This report
does not claim the final receipt already exists.
