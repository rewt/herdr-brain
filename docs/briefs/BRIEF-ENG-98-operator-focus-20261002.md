# Brief: ENG-98, the operator's focus never moves

Org item **ENG-98**. Read `AGENTS.md`, `acceptance/README.md` and `lanes/lane.mjs` first.

## The outcome

The operator (2026-10-02): "I want to be able to stay on the screen I'm on while the acceptance
project runs independently and not take focus there." `lanes/lane.mjs` now passes `--no-focus` on
worktree and tab creation (main 6c8a24e), yet during a full acceptance run against
`releases/v0.1.7`, sampling `herdr pane list` every 2 s showed focus leaving the operator's pane
(`wFN:pY6`) for scratch panes (w22P:p1, w22K:p3, w22J:p3, w1YQ:p1, w239:p1) about a dozen times,
mostly early and once late in the run.Trace:
`/private/tmp/claude-501/-Users-rewt-development-rewt-herdr-brain/4ec1de75-93e3-447f-9929-5114c8ae1f1d/scratchpad/focus-trace-v017.log`
(read-only). Find every Herdr call, in the product and in the harness, that moves focus (agent start,
pane run, plugin pane open, workspace/worktree/tab creation, anything else; check what Herdr's
`--no-focus` actually covers), stop each one, and add an acceptance case that samples the operator's
focused pane for the whole run and fails, naming the call, if it ever changes. The same rule holds
for real use: dispatching a worker must never move the operator's focus.

Judged by: a full acceptance run against a candidate built from your lane with zero focus changes in
the new case's trace; offline tests for each fixed call site.

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
releases, `~/.local/bin`, or panes you did not create; never focus a pane yourself. Real discovery
sessions on the cheapest route are approved for acceptance runs. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop.

## Decision added during the work (supervisor, 2026-10-02)

The operator is live and other projects (bch-cloak) run beside acceptance. The focus case therefore
fails only when focus moves to a pane or workspace the harness created or owns, or when the move is
correlated with a harness or candidate call. A move to any other pane is an external change: it is
recorded in the trace and reported, the monitor re-baselines on it, and it does not fail the run.
