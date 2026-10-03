---
{
  "run": "R-144",
  "outcome": "done",
  "summary": "Rebased the accepted R-141 lane onto main's settle teardown changes and resolved the conflicts in settle/README.md, test/helpers/inbox.mjs and test/test-hangs.test.mjs. Confirmed inbox-owner and transport-child teardown, scratch preservation on refusal, delayed startup regressions and finite standalone hang bounds are retained alongside load-aware allowances and fixed cancellation clocks. The fast tier, load/PTY/process/inbox suites, standalone hang file and final full settle suite pass. Validation also required a diagnostic-only correction to the existing ref-transaction test; no product feature or safety rule changed. The implementation is committed, and the checked report commit precedes the final fast lane check.",
  "headline": "The rebased load allowances preserve settle teardown and hang bounds.",
  "blockers": [],
  "proposals": [],
  "learnings": [
    "Main's base is Report settle teardown and standalone hang validation for R-139, following Stop settle fixture inbox owners and bound standalone hang scenarios. All seven prior lane commits were replayed; the accepted R-141 implementation remains in Fix remaining load-aware lock and fixture deadline boundaries.",
    "The inbox helper retains ENG-112's exact argv, live test-group and freshly checked birth-tuple requirements, owner freeze, transport-child capture, individual signals, exit confirmation and directory-preserving refusals. Its stop, exit and natural-idle waits now all use the existing load-aware five-second base. Two load-24 regressions independently permit twelve-second virtual stop and shutdown confirmations and verify the same pinned individual signal sequence.",
    "Standalone hang scenarios retain thirty-second receipt and thirty-five-second aggregate bases. The aggregate uses the existing spawnScenarioChild default so it scales once with load, including the nested runner. The eleven-second startup delay and 1.25-second blocked-loop preloads remain. Deliberate three-second file/suite and 2.5-second ownership-lookup cancellation clocks use --fixed-deadlines.",
    "The ref-transaction product already reports either injected stderr or its stage-specific generic refusal, depending on which pipe is observed first. The test now accepts either existing diagnostic. Nonzero exit, unchanged lane/main refs, checkout contents, HEAD/index locks and uncertainty assertions remain intact; settle/replace-lane-head.mjs was not changed in this round.",
    "An intermediate suite encountered one inbox identity refusal and retained its scratch record. Its owner lock was absent afterward; the cause of that transient identity mismatch is not established. The final full suite passed the same case without changing the ownership guard. ENG-112's three explicit teardown regressions passed in every full suite attempt."
  ],
  "artifacts": [
    "Commit: Preserve load-aware allowances through settle teardown rebase, on lane/load-robust.",
    "Rebase base commit: Report settle teardown and standalone hang validation for R-139. Git range-diff confirmed that the replay differences were confined to the conflict resolutions; main remained an ancestor before the implementation commit.",
    "settle/README.md; test/helpers/inbox.mjs; test/test-hangs.test.mjs: combined teardown, documentation and load-aware standalone bounds. test/load-deadlines.test.mjs: two loaded owned-shutdown regressions. settle/test/ref-deadlines.test.mjs: diagnostic-only validation correction.",
    "npm run test:fast before rebase: 140 passed, zero failures or skips; /private/tmp/eng113-r144-fast-before.log. Post-rebase fast tier: 140 passed, zero failures or skips; /private/tmp/eng113-r144-fast-after.log.",
    "Load, PTY, process-safety and shared inbox delivery suites: 67 passed, zero failures or skips; /private/tmp/eng113-r144-helper-tests.log.",
    "Standalone test/test-hangs.test.mjs through the bounded runner: 22 passed, zero failures or skips; /private/tmp/eng113-r144-hangs.log.",
    "Final full settle suite: 94 passed, zero failures or skips; /private/tmp/eng113-r144-settle-final.log. Earlier attempts: 93 passed / 1 failed in /private/tmp/eng113-r144-settle.log; 92 passed / 2 failed in /private/tmp/eng113-r144-settle-rerun.log.",
    "Report: docs/reports/ENG-113-load-robust-r4-20261003.md. Checked with ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs check, then committed as Report load robustness rebase validation for R-144.",
    "Final operation after report validation and commit: ORG_ACTOR=run-R-144 node lanes/lane.mjs check. Its final gate result is retained in terminal output and .lane/gate.json."
  ],
  "decisions": [
    {
      "text": "Preserve ENG-112's explicit owned teardown and standalone hang bases while applying the lane's existing load allowances and fixed cancellation mode.",
      "category": "design",
      "why": "The rebase must retain both accepted behaviors. Longer response allowances change neither signal authority nor the finite, exact clocks used to reproduce cancellation."
    },
    {
      "text": "Accept either existing stage-specific refusal diagnostic in the ref-transaction regression, retaining every state-preservation assertion.",
      "category": "prover",
      "why": "Two full-suite attempts rejected a valid generic commit-refusal diagnostic because stderr and stdout are independent pipes. The correction tests both existing diagnostics while preserving every ref and lock assertion."
    }
  ],
  "questions": [],
  "challenges": [
    "The first two full settle attempts were not green: both rejected the generic commit-refusal diagnostic, and the second also refused an inbox owner identity during teardown. Both are reported above rather than omitted; the final full run passes all 94 cases. The inbox refusal guard remains unchanged and its retained scratch directory is /private/var/folders/st/gcpbkfdj1hbb618vgcf59j3w0000gn/T/settle-test-uwWZDi.",
    "This is the requested offline rebase round. Load-24 shutdown proof uses virtual time, while the inherited Git regressions use real 15.2-second response delays. No live acceptance harness or sustained-load release acceptance was run. The independent PTY leaf lifetime work remains with ENG-115 as established by R-141."
  ]
}
---

The rebase preserves both documentation paragraphs and both inbox teardown paths.
Settle continues to stop its confirmed owner and transport children before deleting
the record; delivery tests can still wait for natural owner completion. Unknown
ownership and unconfirmed shutdown preserve scratch evidence. No broad signal or
new teardown fallback was added.

Required checks used the bounded offline runner:

```sh
npm run test:fast
node test/helpers/run.mjs test/load-deadlines.test.mjs test/pty.test.mjs test/processes.test.mjs supervisor/test/delivery.test.mjs
node test/helpers/run.mjs test/test-hangs.test.mjs
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 settle/test/*.test.mjs
```

All final checks passed. The restricted baseline attempt could not invoke `ps`;
tests were rerun with authorized process inspection and fixture cleanup enabled.
No model, live pane, project housekeeping loop, promotion, push or release was
invoked. The final lane check follows this report's validation and commit, after
which this run stops.
