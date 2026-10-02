---
run: R-123
outcome: done
summary: |
  The release harness now records machine load and classifies report-wait and child-command timeouts under measured contention as harness PENDING with the load named. Normal-load report timeouts and product safety failures remain FAIL, and dependent cutover cases preserve the original classification. Offline regressions pass and a lane candidate passed all 27 release-gate cases; an earlier busy run retained one correctly labelled harness PENDING and no product failures.
headline: Busy-machine timeouts now remain pending and the release gate passes
blockers: []
proposals: []
learnings:
  - Heavy load is a one-minute load average at or above available CPU capacity. All three load averages, CPU capacity, timestamps and the threshold are retained.
  - Timeout decisions use the affected operation's samples, so contention in an earlier unrelated case cannot excuse a later normal-load timeout. The focus monitor spans the entire run.
  - Sampling occurs every second while the event loop is free, on wait polls and before and after blocking child commands. There is no independent sampler during a blocking command.
  - The project test runner supports a nine-minute suite limit and an eight-minute file limit. The default six-minute suite limit expired under this session's machine load without a reported assertion failure.
artifacts:
  - Commit Classify release-gate timeouts using measured machine load
  - Commit Give each release acceptance case its own record actor
  - Commit Detect harness contention on small CPU hosts
  - acceptance/load.mjs, acceptance/limits.mjs, acceptance/run.mjs and acceptance/test/load.test.mjs
  - npm run test:acceptance passed all 89 tests before the additional single-CPU regression; the load suite subsequently passed all nine tests
  - /private/tmp/eng103-acceptance-tests.log
  - /private/tmp/eng103-load-tests.log
  - /private/tmp/herdr-acceptance-to27YL/evidence/summary.json
  - /private/tmp/herdr-acceptance-gr6K3Y/evidence/summary.json
  - /private/tmp/eng103-release-gate.log and /private/tmp/eng103-release-gate-rerun.log
  - Final lane validation runs npm test with supported longer bounds and the complete offline acceptance suite after this report is committed; its exact-head receipt is .lane/gate.json
decisions:
  - text: Keep bounded waits and classify their timeouts using measured load rather than retrying indefinitely.
    category: prover
    why: A contended machine cannot establish a product timeout. PENDING keeps the gate NOT READY while a never-reporting candidate at normal load still fails.
  - text: Retain operation-scoped load evidence and preserve safety and prerequisite classifications.
    category: prover
    why: A run-wide sticky heavy-load flag could excuse a later real failure; product boundary refusals and independent incorrect behaviour must retain precedence.
  - text: Use CPU capacity as the threshold on small hosts as well as this 18-CPU machine.
    category: design
    why: A fixed minimum of four would overlook contention on single-CPU hosts. The additional offline regression proves the capacity-based threshold; this correction does not change the threshold exercised by either live gate.
  - text: Give each acceptance case an explicit isolated record actor and include settle in the verification fixture archive.
    category: prover
    why: The brief requires test actors, and the record CLI imports settle/desks-command.mjs. The incomplete pre-existing archive prevented its confinement regression from reaching the assertion.
questions: []
challenges:
  - premise: A busy gate can establish a product failure from a held-report deadline or incomplete focus reads.
    evidence: The supplied v0.1.8 evidence recorded held-report FAILs in cases 19-20 and pane.current timeouts in case 27. This lane's first live gate measured peak load 46.48 on 18 CPUs and finished with 26 PASS, zero FAIL and one harness PENDING naming that measured load.
    resolution: Preserve uncertainty as harness PENDING. The subsequent lane candidate completed all 27 cases with no focus read errors, despite a measured peak load of 39.11.
  - premise: The required default npm test invocation completes inside six minutes on this machine.
    evidence: The before-change invocation reached at least 661 successful tests and the after-change invocation reached 685 before their 360000ms suite deadline, with no reported assertion failures.
    resolution: Keep shared configuration and the default runner unchanged. The final lane check uses the runner's supported 540000ms suite and 480000ms file bounds, and reruns the offline acceptance suite.
---

The full passing gate exercised the lane candidate from **Give each release
acceptance case its own record actor** (`b2cf339`) in 421 seconds. Its evidence is
`/private/tmp/herdr-acceptance-gr6K3Y/evidence/`: **27 PASS / 0 FAIL / 0 PENDING,
READY**, including both cutover cases that previously failed. Focus retained
1,442 samples, zero errors and zero harness changes. Cleanup retained zero owned
workspaces, zero cleanup errors, zero authentication copies and zero discovery
roots. The later small-host threshold correction leaves this machine's threshold
at 18 and is covered by its added offline regression.

The earlier gate exercised **Classify release-gate timeouts using measured machine
load** (`1863c3e`). Its incomplete focus trace stayed **NOT READY**, with
`measured heavy load: 46.48/34.78/26.80 (1/5/15m), 18 CPUs, threshold 18` on the
PENDING screen line. It passed the actual held-report canary and every cutover
check. Both attempts retain load.jsonl, per-case load summaries, native command
receipts, focus traces and cleanup receipts.

Offline coverage includes a never-reporting normal-load worker, heavy-load report
timeouts, contention falling before a deadline, an earlier busy case followed by
a normal-load timeout, successful reporting under load, an actual bounded stalled
child, native focus timeout diagnostics, small-host capacity, product/safety
precedence and propagation through canary recovery, cleanup, aggregate and
retirement. Timeouts remain bounded and PENDING never counts as a release pass.

All implementation and report commits are local to lane/harness-load. Main remained
at the lane's original base while preparing this report, so no rebase was needed.
The live compatibility project was read only and copied into scratch. Shared lane
configuration, activated releases, user bin/configuration and unrelated panes were
not changed. No push or publication occurred; contrib/settle-watch.mjs is unchanged.

After checking and committing this report, the final command is lane check with
`npm test -- --file-timeout=480000 --suite-timeout=540000` followed by
`npm run test:acceptance`. The clean report commit is the head named by that gate.
---
