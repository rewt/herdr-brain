# Brief: ENG-84, the promote module

Org item **ENG-84**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

An ordered promotion queue: the supervisor (or settle) enqueues a lane; one detached worker
drains the queue in order: clean, rebase, gate, fast-forward (`lane promote`), close the lane and
its finished tabs, and tells the supervisor after each, including every refusal (bch-cloak added
that after a silent 02:02 refusal). Evidence: bch-cloak's `promote-queue.sh` and `promote.sh`
(kit, inventory row Promote). Two promotions must never race; a red gate or conflicting rebase
leaves the lane intact and says why.

Judged by: a test harness case queues two lanes in an unconfigured project and both promote in order with a message each; a refusal case; offline tests. Never pushes or makes merge commits.

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
