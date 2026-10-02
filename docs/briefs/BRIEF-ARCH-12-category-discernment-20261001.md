# Brief: ARCH-12, category discernment

Org item **ARCH-12**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

Questions and decisions carry a category that decides whether they wait for the operator
(security, funds-and-chain, publish, licensing, delete-data, priorities, other) or are answered
automatically. A wrong category silently skips the operator. Give agents an ordered, action-based
checklist for choosing a category (in the report template and question help), make them pause
(ask) when unsure, and add a no-model check at ingest that flags auto-category items whose text
mentions keys, pins, push, publish, broadcast, a vulnerability or deletion, so the operator sees
them. Flag, never refuse (`AGENTS.md`: refuse only what makes the record inconsistent).

Judged by: offline tests with mis-categorized fixtures flagged and correct ones not; the flag visible in `record status` and the console; no stored status, older folds ignore any new event type.

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
