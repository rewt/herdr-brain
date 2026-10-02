# Brief: ENG-75, housekeeping in the console

Org item **ENG-75**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Housekeeping (ENG-73) writes structured actions under the record and reads optional overrides from
`.housekeeping.json`, but the operator can only see it in log files. Show its activity in the modern
console's control plane (what it closed, kept and why, resumed, when it last ran, whether it is
running) and let the operator pause it or change an override through a validating CLI command into
tracked config, never by writing the file directly.

Judged by: `--print` renders of the housekeeping view against this record (it is running here) and a fixture; tests that pause and override land through the CLI; nothing existing in the console lost.

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
