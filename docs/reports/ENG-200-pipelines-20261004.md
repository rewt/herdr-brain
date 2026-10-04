---
run: R-250
outcome: done
summary: |
  Added clickable train-batch and run-lifecycle pipelines to the minimal console.
  Each link shows its derived state and recorded duration, opens its evidence,
  and preserves selection and scroll through Back. Targeted offline tests and
  real --print snapshots cover failures, refusals, interruptions and fix rounds.
headline: The console now shows clickable run and train pipelines
blockers: []
proposals: []
learnings: ["The live train phase is batch.phase; attempt.phase stays prepared during CI so recovery can resume safely.", "A running validation log can be matched through lane-validation/<key>.lock/owner.json argv naming promote-batch and the exact batch receipt; select only one matching temporary log.", "Current receipts have no independent rebase, fast-forward, lane-close or notify clocks, and many settle review receipts have no clocks; display unknown.", "Fix rounds are joined by explicit settle fixRun/result.fix.run or dispatch fromRun relationships, not by shared item titles or lane labels."]
artifacts: ["commit 550ec2c: Add console run and train pipeline chains", "branch lane/pipelines", "console/modern/pipelines.mjs", "console/modern/details.mjs", "console/modern/detail-view.mjs", "console/test/pipelines.test.mjs", "console/test/pipeline-details.test.mjs", "console/test/pipeline-view.test.mjs", "console/test/fixtures/pipeline-*.txt", "console/evidence/ENG-200/targeted-tests.tap", "console/evidence/ENG-200/focus-regression.tap"]
decisions:
  - text: Derive pipelines from existing record, settlement, promotion and delivery receipts, with unknown durations wherever clocks are absent.
    category: design
    why: The console remains model-free and read-only, without adding stored status or changing lifecycle operations.
  - text: Keep Enter on active Runs rows opening the live session; add p and the clickable stage cell for their lifecycle pipeline.
    category: design
    why: This keeps the established session interaction while making active pipelines reachable.
  - text: Select a running CI temporary log only through its explicit batch lock reference and unique matching log.
    category: design
    why: Live output stays tied to this batch; ambiguity remains visible instead of showing another check's output.
questions: []
challenges: []
---

The train chain is queued → rebase → CI → fast-forward → close lanes → notify.
The lifecycle chain is dispatch → engineering → report → review, repeated
fix/report/review links for explicit corrections, then train → landed → release
candidate. Marks and status words distinguish done, running, failed, waiting and
skipped without colour. Wide panes use horizontal chains and connected bands;
narrow panes use vertical links. Arrows select links, Enter or click opens their
evidence, and Esc or ‹ Back restores the prior selection and scroll.

Links open briefs, archived reports, review findings and settlement receipts,
check output, promotion receipts, notice delivery evidence, and the exact
candidate's gate result and log. Candidate membership uses the recorded promoted
commit and canonical project identity. Refusals appear at their evidenced stage;
older receipts without a refusal-phase field use their explicit reason and gate
checkpoint. Interrupted clocks stop; stale interruption results cannot overwrite
a resumed batch or run lifecycle. Lane closure and notify are separate from
integration, including retained lanes, pending notices and autopilot handling.

CI evidence retains each attempted check's own output, including bisection
attempts. Running tails are bounded to 64 KiB / 200 lines. Failed checks also
extract structured failing tests and diagnostic messages from the full completed
log so earlier failures remain visible after scrolling out of the tail. The CI
link's clock is the current/latest attempted check's recorded clock, not a guessed
sum across checks. Missing dispatch/review clocks and the uninstrumented stages
show unknown. The new fact projection and readers have no UI dependencies; Ink
and React still load through the existing lazy renderer. No record write, model
call, background loop, promotion or pane mutation was added.

Validation: 112 targeted tests passed with zero failures or skips; evidence is in
`console/evidence/ENG-200/targeted-tests.tap`. A subsequent selection-preservation
change passed its focused active-run regression, recorded separately. The test
files cover derivation, explicit correction relationships, malformed/foreign
evidence, real prepared recovery checkpoints, live and frozen clocks, temporary
log ownership and ambiguity, earlier TAP diagnostics, check-output attribution
across bisection, handled notices, both responsive layouts, every batch link's
click and Enter targets, nested Back, and existing session input safety.

Seven new real `console/app.mjs --print` snapshots cover running batches at
116×30 and 60×40, red CI, post-CI refusal, interruption, and repeated-fix
lifecycles at 116×30 and 60×40. Existing run/report/train and dashboard snapshots
were updated. Tests use local fixtures and fake Herdr/record executables. No live
release acceptance harness, baseline, promotion suite, lane suite, model or real
agent session was run. Live visual operation is not claimed.

After checking and committing this report, the final action is the requested
lane check against the committed report HEAD, using this targeted offline command
so the promotion batch retains ownership of the full merge checks:

```sh
node lanes/lane.mjs check --cmd 'node --test console/test/feed.test.mjs console/test/details.test.mjs console/test/detail-view.test.mjs console/test/pipelines.test.mjs console/test/pipeline-details.test.mjs console/test/pipeline-view.test.mjs console/test/minimal.test.mjs console/test/minimal-input.test.mjs console/test/session-input.test.mjs'
```

That final operation writes its result to the ignored `.lane/gate.json`. Its
outcome is reported in the final handoff; this report is intentionally committed
before the final gate, as the ask requires.
