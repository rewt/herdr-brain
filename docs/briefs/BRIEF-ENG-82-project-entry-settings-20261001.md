# Brief: ENG-82, project-level entry settings

Org item **ENG-82**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

Discovery (ENG-77, on main) gives every fresh `codex`/`claude` session the workflow through
machine-installed entry adapters. Projects can already set routes, validation, question
categories and housekeeping in their own tracked config, but the adapters' behaviour is
machine-wide. Let a project, through its own tracked config: opt out entirely (the wrappers then
pass straight through), choose its entry mode (e.g. fresh sessions as worker lanes, or in the
main checkout), declare its integration branch, and add to the policy text. The project's own
`AGENTS.md`/`CLAUDE.md` take precedence over the generic policy where they conflict.

Judged by: new test harness cases (a project that opts out is untouched; a project's settings and instructions shape what an entering agent is told), passing, with every existing case still passing.

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
