# Brief: ENG-78, complete the test harness

Org item **ENG-78**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

The test harness (`acceptance/`, on main) leaves three cases pending: 22 (the default
supervisor dispatch/watch/ingest cycle in an unconfigured project, actually executed), and 18/19
(every switch in the ENG-64 bch-cloak cutover plan with its rollback, executed on scratch copies,
and the final `contrib/settle-watch.mjs` retirement only after zero callers). Implement them so
they pass or fail on product behaviour. Keep every safety rule the harness's reviews established
(no live paths, nothing model-written runs unsandboxed, capability refusals vs harness limits).

Judged by: cases 18, 19 and 22 execute and report PASS or a product FAIL with reason on main; one-screens for main and v0.1.3 in the report.

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
