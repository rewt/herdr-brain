# Brief: ENG-113, the cycle under machine load

Org item **ENG-113**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

This machine is shared with bch-cloak's heavy work; load averages of 20-30 are normal. On 2026-10-02
fixed internal deadlines failed real work: the test runner's `ps` identity lookup (2 s; raised to 10 s
as a stopgap), `git` calls inside promotion validation (ETIMEDOUT), and dispatch's watcher-startup
acknowledgement (R-137 timed out twice; the watcher never started). Find every fixed internal deadline in
dispatch, watch, settle, promote, housekeeping, supervisor and the test runner; make each scale with
measured load or retry with backoff, failing only on a genuine non-response. No safety rule may weaken:
a failed lookup still never authorizes a signal, refusals stay refusals.

Judged by: offline tests that reproduce each failure (simulate load or slow processes) and pass after the fix.

## Boundaries

Work only in this lane's worktree and scratch. Lanes run the fast tier (`npm run test:fast`) and the
tests you touch; never run the live acceptance harness (AGENTS.md). Never write bch-cloak, the shared
`.lane.json`, the releases, `~/.local/bin`, or panes you did not create; create Herdr objects with
--no-focus. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and
is bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
