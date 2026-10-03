---
{
  "run": "R-141",
  "outcome": "done",
  "summary": "Fixed all four Moderate review findings: load-aware record-lock contention, single scaling of native test command allowances, a separate load-aware PTY cleanup window, and delayed Git ref-transaction coverage. The fast tier and every affected suite passed, and scratch negative controls reproduced each former failure. No launch stall recurred. The independent PTY leaf lifetime boundary remains tracked by ENG-115; this round does not duplicate or close that work.",
  "headline": "The remaining load deadline review fixes pass their offline regressions.",
  "blockers": [],
  "proposals": [],
  "learnings": [
    "The record-lock contention base is ten seconds. At simulated load 24 on four CPUs it allows sixty seconds; a live holder releasing after twelve seconds now permits one correctly attributed append. The missing-PID initialization grace scales from thirty to 180 seconds with the same load sample, so the longer contention wait cannot erase a newly initializing owner. Exhausted live, EPERM-refused and initializing locks preserve the lock and event-log bytes.",
    "Native child_process timeout options are already response allowances. The bounded helper now scales its default fifteen-second command ceiling once and caps explicit options without multiplying them again. With the helper installed and the default ps executor used, load 24 produces twelve-, 24- and 48-second timeout attempts, rather than the former 72-, ninety- and ninety-second attempts. Exhaustion still supplies no identity evidence. Per-test bases continue to scale independently.",
    "The PTY helper samples command and cleanup allowances together and supplies both finite bounds to the native owner. At load 24 the fifteen-second command base becomes ninety seconds and the three-second cleanup base becomes eighteen seconds. The synchronous transport reserves their 108-second sum through an explicit compound fixture allowance, still bounded by the enclosing test cap. Native retained-session identity checks, stop/kill sweeps, three empty scans and cleanup refusal status 125 are unchanged.",
    "The native PTY regression delays its first real enumeration by 3.3 seconds, then performs the original kernel-backed sweeps and preserves command exit status seven. A separate injected enumeration refusal still returns status 125 with cleanup unconfirmed.",
    "The guarded Git replacement now has real transaction regressions at simulated load 24. Delaying each start, prepare and commit acknowledgement for 15.2 seconds independently succeeds under its ninety-second allowance, updates only the pinned lane ref, installs a clean target checkout, and releases only owned locks. Each delayed command is sent once. Exhausted and refused replies at every phase preserve refs; a post-checkout commit failure retains HEAD/index locks and reports uncertainty. Concurrent compare-and-swap refusal and pre-existing lock bytes remain protected.",
    "The original executable launch blocker did not recur. ENG-114 is closed; no new launch-stall diagnosis or follow-on item is needed. No processes matching this round's PTY, transaction or negative-control fixture paths remained in the final pre-commit process inspection.",
    "ENG-115 already tracks the fix beyond ENG-88's runner: a PTY leaf in an independent session needs its own lifetime bound and cancellation coverage when the native owner itself receives SIGKILL or cannot confirm cleanup. Expanding the owner's cleanup response window does not make a killed owner able to clean its descendants."
  ],
  "artifacts": [
    "Commit: Fix remaining load-aware lock and fixture deadline boundaries, on lane/load-robust.",
    "Rebase onto main was the first operation and reported already up to date. Main remained at subject Record final rebase onto supervisor notice delivery through the implementation commit.",
    "lib/store.mjs; test/helpers/bounded-test.mjs; test/helpers/command-allowance.mjs; test/helpers/pty.mjs; test/helpers/pty-owner.c: record, synchronous command and native cleanup fixes.",
    "test/load-deadlines.test.mjs; test/pty.test.mjs; settle/test/ref-deadlines.test.mjs: delayed-success, exhaustion and refusal regressions. docs/reference/load-deadlines.md records the updated allowance inventory.",
    "npm run test:fast before changes: 140 passed, zero failures or skips; /private/tmp/eng113-r141-fast-before.log. After changes: 140 passed, zero failures or skips; /private/tmp/eng113-r141-fast-after.log.",
    "Load, PTY, process safety and hang guard suites: 69 passed, zero failures or skips; /private/tmp/eng113-r141-helper-tests.log.",
    "Git ref deadlines, rebase safety and rebase review suites: 27 passed, zero failures or skips; /private/tmp/eng113-r141-ref-tests.log.",
    "Core record/CLI, suite, startup and copied-plugin compatibility suites: 85 passed, zero failures or skips; /private/tmp/eng113-r141-core-tests.log.",
    "Scratch-only negative controls each failed as expected with the corresponding old behavior: the fixed ten-second record wait refused the delayed holder; double scaling yielded 72000/90000/90000 milliseconds; fixed native cleanup returned 125 instead of seven; fixed ref response timeout returned one instead of zero. Evidence: /private/tmp/eng113-r141-negative-record.log, /private/tmp/eng113-r141-negative-scaling.log, /private/tmp/eng113-r141-negative-pty.log and /private/tmp/eng113-r141-negative-ref.log.",
    "This report is checked with the canonical record CLI and committed before node lanes/lane.mjs check runs as the final operation. The final lane-check result is recorded in the run's terminal output."
  ],
  "decisions": [
    {
      "text": "Treat explicit native command timeouts as response allowances and scale only default command and declared per-test bases; reserve command plus cleanup time for the known compound PTY fixture.",
      "category": "design",
      "why": "Each allowance keeps its original units, with finite synchronous and outer test bounds and a separate response window for native cleanup."
    },
    {
      "text": "Keep independent PTY leaf lifetime and cancelled promotion-gate coverage in the existing ENG-115 item.",
      "category": "tooling",
      "why": "The supervisor already recorded that separate ownership boundary. All four requested review findings can be resolved without duplicating it or claiming that response deadline changes fix owner SIGKILL."
    }
  ],
  "questions": [],
  "challenges": [
    "The proof uses simulated load 24, virtual lock time, real 3.3-second native enumeration and real 15.2-second Git acknowledgement delays. It establishes the reviewed offline deadline behavior, not a live release acceptance run under sustained host load. Exhaustion tests compress the sampled Git response timers by 100 while retaining the real transaction and its safety guards."
  ]
}
---

All four review findings are addressed in **Fix remaining load-aware lock and fixture deadline boundaries**. The review findings file stayed outside the repository. The core remains dependency-free, process identity refusals remain non-authorizing, and `contrib/settle-watch.mjs` was not changed.

The affected checks were:

```sh
npm run test:fast
node test/helpers/run.mjs test/load-deadlines.test.mjs test/pty.test.mjs test/processes.test.mjs test/test-hangs.test.mjs
node test/helpers/run.mjs settle/test/ref-deadlines.test.mjs settle/test/rebase-safety.test.mjs settle/test/rebase-review.test.mjs
node test/helpers/run.mjs test/flow.test.mjs test/approvals.test.mjs test/priorities.test.mjs test/name-alias.test.mjs test/recap.test.mjs test/suite.test.mjs test/startup-deadlines.test.mjs test/plugin-install.test.mjs
```

All passed. Each negative control used a scratch source copy with one former deadline behavior restored; none changed the lane implementation. No live acceptance harness, model, real pane, project housekeeping loop, promotion, push or release was run.

The report commit is **Report final load robustness review fixes for R-141**. Per the requested ordering, the final lane check follows report validation and that commit; no further work is scheduled after it.
