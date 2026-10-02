---
run: R-74
outcome: done
summary: |
  Added a separate ranked list of operator outcomes with durable who/why history.
  Dispatch and record start can name the priority served; unaligned work remains
  visible and may proceed. The modern console reads the list, groups work and runs,
  and reviews additions and re-ranks through validating CLI commands. Agent proposals
  remain waiting questions. Offline tests cover these paths and older-fold compatibility.
headline: The operator can rank priorities and see which work serves them.
blockers: []
proposals: []
learnings:
  - Operator priorities use P-n identities and their own ordered events; legacy item priority numbers remain scheduling hints.
  - Run meta.serves captures an explicit priority or inherits item meta.serves through parents; an explicit empty serves flag selects no priority.
  - Priority questions always wait for the operator, including in records configured with an auto priorities category.
  - Answering a priority proposal records the answer; the operator applies the actual ordering through a separate reviewed priority command.
artifacts:
  - 'Commit: Add operator-owned priorities and advisory work alignment'
  - 'Commit: Report operator priorities and console evidence'
  - lane/priorities
  - lib/priorities.mjs
  - test/priorities.test.mjs
  - console/test/control-plane.test.mjs
  - dispatch/test/dispatch.test.mjs
  - docs/reports/ENG-89-priorities-20261002.md
  - docs/reports/ENG-89-priorities-evidence-20261002/empty.txt
  - docs/reports/ENG-89-priorities-evidence-20261002/before.txt
  - docs/reports/ENG-89-priorities-evidence-20261002/after.txt
  - docs/reports/ENG-89-priorities-evidence-20261002/priorities.json
  - /tmp/eng-89-focused.log
  - /tmp/eng-89-lifecycle.log
  - /tmp/eng-89-serial.log
  - .lane/gate.json
decisions:
  - text: Implement operator outcomes as separate ranked events instead of repurposing legacy item priority numbers.
    category: design
    why: Existing agent scheduling hints must not silently become or reorder operator commitments; older folds safely ignore the new events.
  - text: Implement operator-only additions and re-ranks using the existing human actor convention, required reasons, and optional revision checks under the record lock.
    category: design
    why: The console can review a concrete order without overwriting intervening edits; named agents leave waiting proposals instead.
  - text: Capture work alignment in validated run metadata and expose missing alignment as an advisory read projection.
    category: design
    why: Unknown priority IDs would make links inconsistent, while choosing no priority must never prevent useful work.
  - text: Run one test file at a time for final full-suite validation.
    category: tooling
    why: Parallel test runs exposed unrelated lifecycle partial-JSON and watcher deadline flakes, including one leaked fixture child; the complete test selection is preserved.
questions: []
challenges:
  - 'The roadmap still said agents rank priorities. The new ask reserves ordering to the operator; updated that sentence and retained old item priority numbers as separate hints.'
  - 'Parallel post-change test runs exposed unrelated timing failures: a lifecycle test read a partial JSON file and watcher tests exceeded two/three-second deadlines. One timed-out fixture leaked a child; only the verified child processes of this run were stopped. The lifecycle file passed all seven tests in isolation; final validation runs one test file at a time.'
---

Implementation commit: **Add operator-owned priorities and advisory work alignment**.
Report/evidence commit: **Report operator priorities and console evidence**.

The changes are confined to this lane. No live project priorities were added or
re-ranked: the examples and write tests use temporary records and projects. No
shared lane configuration, other project, release, installed executable or live
pane was changed; nothing was pushed or published. `contrib/settle-watch.mjs` is
unchanged.

## Behavior and evidence

`record priorities add "Outcome" --why "Reason"` appends an operator outcome.
`record priorities rank P-2 --rank 1 --why "Reason" [--expect REV]` moves one outcome
and records the complete previous/new order, actor, timestamp and reason. Each
displaced outcome also shows its rank history. Unknown priorities, out-of-range
ranks, missing reasons and stale reviews leave the record unchanged. An unchanged
rank writes no event. Named agents cannot add, re-rank or answer priority questions;
they use `record priorities propose "Question" --parent ID --recommend yes --why
"Reason"`, which appears in the ordinary Waiting on you queue even under auto policy.

`dispatch --serves P-n` validates the outcome before lane creation and preserves the
selection through recovery. `record start --serves P-n` and `--meta serves=P-n`
record the link. An omitted flag inherits the nearest item/parent `meta.serves`;
`--serves=` explicitly selects none. Without any link, work starts normally and is
flagged Unaligned in its brief, command output, status/today and Priorities view.
Active runs determine current work alignment; otherwise item/parent declarations
group open work. Historical runs retain their own links and outcomes in the view.
These associations do not authorize or schedule anything.

In the modern console, **P** or the overview/Control link opens Priorities. Enter
an outcome to edit its rank and reason, or choose Add priority. Tab changes field;
Ctrl+U clears; Enter reviews the resulting full order and a second Enter saves
through the record CLI. Esc or Cancel discards a draft. The editor owns shortcuts
and header clicks while open, pins the selected record and revision, and retains a
failed draft. `--print` blocks even a fully reviewed/confirmed addition or re-rank.

## Validation

- Baseline `npm test`: **456 passed, 0 failed, 4 skipped, 460 total**.
- Focused console-control and dispatch suites: **39 passed, 0 failed**.
- New core priority suite: **3 passed, 0 failed**.
- Isolated existing lifecycle suite: **7 passed, 0 failed**.
- Final complete offline suite, one file at a time: **462 passed, 0 failed, 4 skipped, 466 total**.
- `git diff --check` passed.
- Console priority renders and editor paths are exercised at **80, 100 and 140 columns**.
- A frozen older fold ignores both new event types and retains legacy item behavior.

The complete suite uses the same files as `npm test`, with `--test-concurrency=1`:

```sh
node --test --test-concurrency=1 test/*.mjs test/fixtures/*.mjs brain/test/*.test.mjs console/test/*.test.mjs console/test/fixtures/*.mjs console/proto/*.test.mjs watch/test/*.test.mjs dispatch/test/*.test.mjs housekeeping/test/*.test.mjs discovery/test/*.test.mjs promote/test/*.test.mjs
```

The report is checked through `record check`, then committed. The final action is
`node lanes/lane.mjs check --cmd '<complete suite command above>'`; its gate is
written to `.lane/gate.json` against the report commit. Main is checked before
that final action and the lane is rebased if it has moved.

## Console print frames

Actual `node console/app.mjs --modern --config <scratch-console.json> --print
100x40 --keys P` output is retained in the evidence directory. The configuration
only chooses a temporary project for the test; the project itself has no priority
configuration. Herdr topology is an offline empty-list stub and no model is called.
The first render opens a folder with no record and creates no files there.

Empty project, excerpt of [empty.txt](ENG-89-priorities-evidence-20261002/empty.txt):

```text
Priorities · 0 operator outcomes
The operator owns this order. Enter a priority to re-rank with a reason.
No priorities yet. Add the outcomes you want agents to serve.
+ Add priority
Initialize this project record to set priorities: record init
```

Before, excerpt of [before.txt](ENG-89-priorities-evidence-20261002/before.txt):

```text
Priorities · 2 operator outcomes

1. P-1 Keep context durable
Rank set by human · Fresh sessions should continue useful work
No open work serving this priority.

2. P-2 Make adoption easy
Rank set by human · Anyone should be able to use the platform
  ENG-1 · active · Build a fresh-project example
R-1 · active · Build a fresh-project example

Unaligned · 1 open work
No operator priority named. Alignment is advisory; work may proceed.
ENG-2 · ready · Explore a side path
```

After a simulated operator moves Adoption to first, excerpt of
[after.txt](ENG-89-priorities-evidence-20261002/after.txt):

```text
Priorities · 2 operator outcomes

1. P-2 Make adoption easy
Rank set by human · The operator wants a usable example first
  ENG-1 · active · Build a fresh-project example
R-1 · active · Build a fresh-project example
Previously rank 2 · human · Anyone should be able to use the platform

2. P-1 Keep context durable
Rank set by human · The operator wants a usable example first
No open work serving this priority.
Previously rank 1 · human · Fresh sessions should continue useful work

Unaligned · 1 open work
No operator priority named. Alignment is advisory; work may proceed.
ENG-2 · ready · Explore a side path
```

The unchanged **Waiting 1** count in both complete frames is the agent-style
Adoption re-rank proposal. Rank changes and answering a proposal remain separate
operator actions. Full rank history and work/run links are retained in
[priorities.json](ENG-89-priorities-evidence-20261002/priorities.json).
