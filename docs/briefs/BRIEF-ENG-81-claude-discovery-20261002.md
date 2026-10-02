# Brief: ENG-81, Claude discovery and other validation sandboxes

Org item **ENG-81**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Discovery was proven with real Codex sessions only; Claude's entry transport passes offline tests.
Prove real Claude entry in a pristine scratch project (cheapest Claude model, e.g. Haiku; report
tokens), and add bounded validation sandbox alternatives so validation does not require the Codex
binary on machines without it, and so projects using external Git filters can still be entered
safely. Harness-specific code stays out of the record core.

Judged by: test harness discovery cases passing for a Claude session as well as Codex; offline tests for the sandbox alternatives; no regression in existing cases.

## Frame (operator, 2026-10-01)

For anyone, on any project, with no special user configuration: agents discover the workflow when
they enter a project and the record fills from their work; a project may override defaults through
its own tracked config. bch-cloak is one existing project, not the design center.

## Boundaries

Work only in this lane's worktree and scratch directories (scratch homes for any install test).
Never write bch-cloak, the shared `/Users/rewt/development/rewt/.lane.json`, the activated release,
`~/.local/bin`, launchd, harness user configuration, or Herdr panes you did not create. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded in
time. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
