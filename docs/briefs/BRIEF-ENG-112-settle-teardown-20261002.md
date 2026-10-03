# Brief: ENG-112, settle test teardown and the standalone test-hangs file

Org item **ENG-112**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Settle's record-safety tests sometimes fail in teardown with 'fixture inbox owner did not exit'
(quiet delivery's inbox owner, ENG-106, still running when the fixture removes its record); one promotion
gate failed on it. Also, `node test/helpers/run.mjs test/test-hangs.test.mjs` run on its own fails 7 of 22
on main (e.g. 'detached cancellation fixture reached its launch') while passing inside the full suite.
Make the settle fixture stop or isolate the inbox owner before removing directories, and make the
test-hangs file pass standalone or document precisely why it cannot, so a developer can run any test file
on its own.

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
