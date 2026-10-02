# Brief: ENG-102, Phase 4 completion

Org item **ENG-102**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Phase 4 (ARCH-9) makes the console the control plane: Decided / Asked / Waiting on you, priorities,
routes and desks, every change through a validating CLI command into tracked project config. Landed
so far: the control plane slice (ENG-85), priorities (ENG-89), housekeeping view (ENG-75). Audit the
modern console against Phase 4's goals and build what is missing, starting with desks (how settle and
review run for the project: review route, fix route, round cap from ENG-96, timeouts) and anything else
the operator cannot yet see or steer from the console. The operator judges the console by its screen;
iterate on the screen, not documents.

Judged by: a gap table in the report, each gap closed or justified; before/after `--print` renders of every changed screen against this record and a fixture; tests showing each new change lands through the CLI.

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
