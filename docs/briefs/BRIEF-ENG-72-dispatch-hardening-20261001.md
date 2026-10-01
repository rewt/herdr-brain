# Brief: ENG-72, dispatch hardening

Org item **ENG-72**, under Phase 3 (ARCH-8). Read `AGENTS.md`, `dispatch/README.md` and
`docs/reviews/dispatch/f487d4f-r1.md` first. This brief is only the ask.

## The outcome

The four Minor findings in that review are fixed, each with a test, or shown moot with
evidence: a request stranded at `starting` after a refused `record start`; a run id accepted
as the item; the retry/lock race after a crash; and `--reuse` of a worker whose previous run
is still open.

## Why it matters

The dispatch module (ENG-71) is now how the supervisor starts every worker. Its promise is
that a failure part-way never leaves a half-dispatched run; these are the cases where it still
can. This run is also the module's first live use: it was dispatched by `dispatch/dispatch.mjs`.
If anything about how you were started looks wrong (prompt, report path, run fields, watcher),
say so in `challenges`.

## Judged by

- Each finding has a test that fails before the fix and passes after.
- No change to the record's core, no new event type, no stored status (`AGENTS.md`).
- `npm test` and `npm run test:lanes` green; tests offline.

## Boundaries

Work only in this lane's worktree. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Never
write bch-cloak's repository or record, the shared `.lane.json`, the release or `~/.local/bin`.
Do not dispatch real agents in tests. No push or publish.

## Where you are free

How each fix works. If a finding is wrong, say why and leave it.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject, not hash; `record
check` it, commit it, and run `lane check` last. Then stop.
