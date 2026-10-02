# Brief: ENG-109, the release module

Org item **ENG-109**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md`, `settle/README.md`, `promote/README.md`, `supervisor/PROTOCOL.md` and `lanes/README.md` first; this brief is only the ask.

## The outcome

Promotions accumulate on main; a release batches them. Build a release module for any project: at a
quiet point (low load, no promotion running) cut a release candidate from main (a tag), run the
project's declared release gate once on that candidate, record the result in the record, and ask the
operator to ship or activate it (an operator-reserved category; never auto-approve). The supervisor
protocol (`supervisor/PROTOCOL.md`) gains the release step, and the console shows candidates, their gate
results and the pending decision. For this repo, the declared release gate is the acceptance harness
(`acceptance/run.mjs` against the built candidate) and the ship step is `herdr/release.sh build`;
activation stays the operator's. Prove it in a scratch project with a trivial declared gate; prove this
repo's wiring with a dry run that builds a candidate and invokes the gate in `--skip-live` mode.

Judged by: offline tests for each behaviour; a scratch project exercising the cycle end to end without the live harness.

## Frame

For any project, with no special configuration: defaults when a project declares nothing, tracked
overrides when it does; discovery tells entering agents what they run (workers never run the release gate).
bch-cloak adopts the same cycle later through a release; it is not the design center. The operator's
direction (2026-10-02): "we don't need to run the test harness for every little task item... it should
only validate before a release... package promotions into releases", and the same cycle must be in the
product "so bch-cloak could accept the same cycle as well." Also in `AGENTS.md` (e0c5282).

## Boundaries

Work only in this lane's worktree and scratch. Do not run the live acceptance harness (offline tests and
at most one `--skip-live` pass if you touch `acceptance/`). Never write bch-cloak, the shared `.lane.json`,
the releases, `~/.local/bin`, or panes you did not create; create Herdr objects with --no-focus. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded. No push
or publish; never activate a release.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
