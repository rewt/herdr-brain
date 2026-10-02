---
run: R-76
outcome: done
summary: |
  Fixed all three round-one review findings. Ingest validates every proposal's
  priority link under the record lock before storing the report or appending events.
  Test fixtures choose their own actors, including human priority setup and agent
  dispatches. Priority confirmation supports keyboard scrolling through long orders.
  The full npm test suite passed with ORG_ACTOR=supervisor-herdr.
headline: Priority links validate before ingestion and long orders can be reviewed by keyboard.
blockers: []
proposals: []
learnings:
  - Proposal serves fields are parsed into extra metadata; ingestion must validate the entire batch before storing the immutable report.
  - Tests must select their own actor rather than inheriting the supervisor's ORG_ACTOR; an explicit empty actor exercises the existing unnamed-writer default.
  - Priority confirmation uses the rendered body's height and maximum scroll to support arrows and page keys without altering the draft or saving it.
artifacts:
  - 'Commit: Fix priority proposal ingestion, review scrolling and test actors'
  - 'Commit: Report ENG-89 round-two review fixes'
  - lane/priorities
  - bin/org.mjs
  - test/priorities.test.mjs
  - dispatch/test/dispatch.test.mjs
  - console/test/control-plane.test.mjs
  - console/modern/session.mjs
  - console/modern/README.md
  - docs/reports/ENG-89-priorities-r2-20261002.md
  - docs/reports/ENG-89-priorities-evidence-20261002/before.txt
  - docs/reports/ENG-89-priorities-evidence-20261002/after.txt
  - docs/reports/ENG-89-priorities-evidence-20261002/empty.txt
  - /tmp/eng-89-r2-baseline.log
  - /tmp/eng-89-r2-negative.log
  - /tmp/eng-89-r2-actor-negative.log
  - /tmp/eng-89-r2-focused.log
  - /tmp/eng-89-r2-agent-suite.log
  - .lane/gate.json
decisions:
  - text: Validate all proposal priority references inside the ingest mutation before the immutable report write.
    category: design
    why: An invalid later proposal must leave both the event log and stored report unchanged; null remains an allowed explicit choice of no priority.
  - text: Give record and runtime test fixtures explicit actors and prove the full suite with an inherited named agent.
    category: tooling
    why: Operator-only setup must not depend on the shell launching the test suite, and dispatch attribution must remain an agent identity.
  - text: Allow line and page scrolling while the operator reviews a priority draft.
    category: design
    why: Every proposed rank and the reason must be inspectable in a small terminal before Enter commits through the CLI.
questions: []
challenges:
  - 'A pre-existing untracked lane review would fail the clean-worktree gate. Preserved it reversibly at .lane/review-artifacts/priorities/aa6adc5-r1.md, under ignored lane runtime state. The external scratchpad findings were not copied into the repository.'
---

Implementation commit: **Fix priority proposal ingestion, review scrolling and test actors**.
Report commit: **Report ENG-89 round-two review fixes**.

Rebased onto `main` before editing; Git reported that the lane was already up to
date. The implementation remains on `lane/priorities`.

The ingestion regression supplies a valid proposal followed by one serving
`P-404`. Rejection leaves the event log byte-for-byte unchanged, creates no stored
report or proposal items, and leaves the run without an ingested report. Separate
cases ingest `P-1` and explicit `null`, then start the resulting work and verify its
alignment. Null overrides inherited alignment and useful unaligned work proceeds.

Dispatch's fixture selects `dispatch-test-agent`; priority creation explicitly
selects `human`. Assertions verify both recorded identities. Other subprocess
fixtures now select their actors as well; tests of legacy unnamed writers explicitly
use an empty actor. The suite invocation retains the inherited supervisor actor.

The 80×20 console regression uses twelve long, wrapped outcomes. Arrow keys scroll
one line and PageUp/PageDown scroll a viewport within the rendered limits. It
reaches the final outcome, reason and save control while retaining confirmation
and draft values. Scrolling and cancelling leave the record byte-for-byte unchanged.
The footer and console guide describe the keys; Backspace returns to editing.

Validation:

- Baseline `npm test`: **462 passed, 0 failed, 4 skipped, 466 total**.
- Before fixing production behavior, the new invalid-ingestion and overflowing-review
  regressions failed. The existing dispatch priority test also failed under
  `ORG_ACTOR=supervisor-herdr` before fixture isolation.
- Focused priority, console-control and dispatch suites with that actor:
  **45 passed, 0 failed**.
- Post-change `ORG_ACTOR=supervisor-herdr npm test`:
  **465 passed, 0 failed, 4 skipped, 469 total**.
- `git diff --check` passed.

The original actual console `--print` evidence remains in this lane:
[before](ENG-89-priorities-evidence-20261002/before.txt),
[after](ENG-89-priorities-evidence-20261002/after.txt), and
[empty project](ENG-89-priorities-evidence-20261002/empty.txt).
Before the simulated operator edit, Keep context durable is first and Make
adoption easy is second; afterwards Adoption is first with the operator's new
reason. Unaligned work remains visible in both frames. This round adds the
overflowing keyboard-review regression described above.

The report is checked with the record CLI and committed before the final command:

```sh
node lanes/lane.mjs check --cmd 'ORG_ACTOR=supervisor-herdr npm test'
```

That final command records its result against the report commit in
`.lane/gate.json`. It is the last task action; no promotion or push follows it.
