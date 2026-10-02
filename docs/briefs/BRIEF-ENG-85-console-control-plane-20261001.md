# Brief: ENG-85, console control plane, first slice

Org item **ENG-85**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

Phase 4 makes the console where the operator steers. First slice: at a glance, what agents
Decided, what they Asked, and what is Waiting on the operator; and the routes in effect for the
project. The operator can answer a waiting question and change a route from the console; both are
written only through validating CLI commands (record answer; a routes command into tracked
`.lane.json`), never by writing files directly (`AGENTS.md`). Build into the modern console the
operator prefers (`console/modern`); iterate on the screen, not on documents.

Judged by: before/after `--print` renders in the report against this record and a fixture; a test harness or console test showing an answer and a route change land through the CLI; nothing the operator uses today is lost.

## Frame (operator, 2026-10-01)

This product is for anyone, on any project, with no special user configuration: agents discover
it when they enter a project, and the project's record fills from their work. bch-cloak is one
existing project on an older release, not the design center. Start from an unconfigured project;
a project may override defaults through its own tracked config.

## Boundaries

Work only in this lane's worktree and scratch directories. Never write bch-cloak's repository,
record or workspaces, the shared `/Users/rewt/development/rewt/.lane.json`, the activated
release, `~/.local/bin`, launchd, or Herdr panes you did not create. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Tests offline (`npm test`, `npm run
test:lanes`); no push or publish.

## Where you are free

Design, shape, names, where it lives, what it reuses. If the brief is wrong, say so and do the
better thing.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject, not hash; `record
check` it, commit it, and run `lane check` last. Then stop. If another lane lands on main
first, rebase onto it yourself.
