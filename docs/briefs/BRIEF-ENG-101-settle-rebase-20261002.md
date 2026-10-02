# Brief: ENG-101, settle rebases cleanly behind main

Org item **ENG-101**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

On R-110 settle reviewed a lane (PASS) and then escalated only because the lane was behind main; the
supervisor rebased it (clean), re-gated and promoted. Make settle perform a clean mechanical rebase
itself, re-run validation after it, and continue to `promotable`; a conflicting rebase still escalates
with the file list and leaves the lane intact; a rebase never discards the reviewed changes (the
reviewed head's diff must survive, or settle escalates).

Judged by: offline tests for clean rebase to promotable, conflict escalation, and reviewed-diff preservation.

## Frame (operator, 2026-10-01)

For anyone, on any project, with no special user configuration: agents discover the workflow when
they enter a project and the record fills from their work; a project may override defaults through
its own tracked config. bch-cloak is one existing project, not the design center. The operator's
Herdr focus must never move (lanes, tabs and panes are created with --no-focus).

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
releases, `~/.local/bin`, launchd, harness or Herdr user configuration, or panes you did not create.
Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is
bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
