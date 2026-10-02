# Brief: ENG-83, the settle module

Org item **ENG-83**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

When a worker's report lands (`watch/` delivers it), one command settles the run: record the
report, check its claims against the diff, run an independent review on a review route, and
return a clear result: promotable, or a fix round (a new run on the same lane, by `dispatch/` with
`--reuse` or a fresh worker), or escalation to the operator with substance. Today the supervisor
does this by hand each time (ingest, `lane review`, read verdict, decide, dispatch fix);
bch-cloak's evidence is `settle.sh`, `apply-settle.sh`, `review-desk.sh` and its settle desks
(`kit/bch-cloak-20261001/`, inventory rows Settle/Review). Decide what is mechanical (run it) and
what needs judgment (hand to the supervisor or a settle session with a compact summary).

Judged by: the supervisor uses it on the next real report here; a test harness case runs report → settle → fix round → settle → promotable in an unconfigured project; offline tests.

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
