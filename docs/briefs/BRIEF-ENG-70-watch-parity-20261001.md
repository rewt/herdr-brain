# Brief: ENG-70, watch parity before bch-cloak's switch

Org item **ENG-70**, under Phase 3 (ARCH-8). Read `AGENTS.md`, `watch/README.md`,
`supervisor/SETTLE.md`, `docs/reports/ENG-64-one-watcher-20261001.md` (the bch-cloak cutover
plan) and `docs/reviews/one-watcher/ae63a6a-r2.md` first. This brief is only the ask.

## The outcome

The three Minor findings in that review are fixed or shown moot, so bch-cloak's watcher switch
can proceed when the operator releases it:

1. the idle grace is gated on the worker having been seen working, and notices a worker that
   turns blocked during the grace;
2. the cutover plan names `continue.sh`'s change from waiting to refusing, carries the retry
   rule into the planned bch-cloak `SETTLE.md` edit, and adds a check for it;
3. (already handled in KICKOFF.md by the supervisor; confirm and leave it.)

## Judged by

- A fixture test for idle-then-blocked inside the grace, and one showing the grace does not start
  before the worker was seen working.
- The plan's parity table and checks updated; nothing in bch-cloak changed.
- `npm test` green; tests offline.

## Boundaries

Work only in this lane's worktree. Never write bch-cloak's repository or record, the release or
`~/.local/bin`. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject, not hash; `record
check` it, commit it, and run `lane check` last. Then stop.
