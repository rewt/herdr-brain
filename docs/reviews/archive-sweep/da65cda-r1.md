**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: da65cdab64eb6f61df0ce3fe78e539ebb8537072
Topic: archive-sweep
Round: 1
Review ID: lr-0c2d182104aa73b7c5bece6d02827883
Base branch: main
Base commit: 4b4bc07440dffcdcee892198f08298a669032f1b

## Findings
- [Moderate] lib/retire-runtime.mjs:823 - prepareScratchSweep runs and durably writes a new randomly named manifest in phase planned before the fresh plan, observeRemoval, laneKeep and deadline checks, and the catch block at line 886 discards duplicate preservation evidence but never finalizes or removes that manifest, so every refused or deferred close attempt (queue retry, RETIREMENT\_DEADLINE, a late keep) leaves another permanently planned manifest in the declared archive or beside the discarded evidence bundle that still lists entries as awaiting final checks, contradicting the stated no-accumulation rule and the registry claim that interrupted intents become explicit; Fix: in the removeLane catch path, before worktree removal, rewrite the manifest with a terminal phase such as not-executed and the refusal reason (or delete the unexecuted planned manifest when the fallback sits beside discarded evidence), and add a fixture where a post-prepare keep or deadline refusal leaves no planned-phase manifest behind.
- [Moderate] lib/scratch-sweep.mjs:215 - inside execute the per-entry durableWrite after the catch and the final complete-phase durableWrite at line 217 are unguarded, and execute is called at lib/retire-runtime.mjs:881 after the worktree and branch are already removed, so an archive write failure at that point throws out of removeLane, skips closeEmptyWorkspace for every workspace and reports the close as failed even though the lane is gone, turning a diagnostic manifest error into a lifecycle failure; Fix: make execute never throw after removal by catching manifest write errors, warning on stderr and logging them, and returning the result so removeLane continues to workspace closure, with a fixture that makes the manifest unwritable after planning.
- [Minor] lib/scratch-sweep.mjs:74 - unmarked names treat any r-digits token as a run id, so review-round suffixes common in this project such as topic-review-r2 are read as run R-2 and are kept forever whenever that number is not a reported run of the closing lane, and the test fixture topic-review-r1 only passes because R-1 happens to be the lane run; the measured-gap shape eng1685-pair-review-r2493 is subject to the same rule and has no fixture; Fix: either require the run token to match a run of the closing lane exactly and otherwise fall back to longest-topic ownership with the token ignored, or document the rule and add fixtures for a round-suffixed name and for the measured-gap name shape showing the intended disposition.
- [Minor] lib/scratch-sweep.mjs:79 - unmarked longest-topic ownership has no project binding even though the worker's own decision rejects unmarked run ids because they repeat across project records; lane topics also repeat across projects that share the same temporary roots, so closing a lane in one project removes an idle same-topic scratch directory of another project once both close through this executor; Fix: record the residual cross-project risk in lanes/README.md and the manifest reason for topic-only matches, or require that an unmarked topic match is also absent from other known project records or carries a project-bound marker, and add a fixture naming the chosen behaviour.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/scratch-sweep.test.mjs
- Test evidence not re-executed: test/closeout.test.mjs
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs
- Report record-check validation not independently executed.
- Whether the whole-user lsof open-file inventory with status 0 and empty stderr required completes on the operator and bch-cloak hosts was not observed; the earlier bch-cloak sweeper documents lsof exiting 1 with stat warnings, which here would keep all scratch and leave the measured gap unswept.
- No product code writes the herdr-scratch/v1 ownership marker, so the preferred run-marker path is exercised only by fixtures; whether real review and worker scratch will carry markers is not established.
- The inherited gate is red with 10 failures confined to test-slot/test/gate-profile.test.mjs; their attribution to native process-source refusal is the worker's inference and was not independently established.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
