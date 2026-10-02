# Brief: ENG-88, tests never hang

Org item **ENG-88**. Read `AGENTS.md` and `watch/README.md` first.

## The outcome

`npm test` and `npm run test:lanes` always finish: pass or fail within a bounded time, never hang.
On 2026-10-01 a `node --test watch/test/watch.test.mjs` run spawned a fixture watcher (`watch.mjs
R-19 --org <tmp>`) that never exited; the test waited forever. One orphan ran 8.5 hours after its
lane closed, and a `lane promote` gate hung for 10 minutes until the supervisor killed the watcher.
It happens under load (several lanes running test suites at once). Find the cause in the watch tests
(and any other test that spawns long-lived children: dispatch, housekeeping, discovery, acceptance
unit tests), fix it, and add a guard: per-test timeouts, guaranteed child cleanup on failure, and a
suite-level bound so a hang becomes a failure with the culprit named.

Judged by: a test that deliberately leaves a child running fails with its name rather than hanging;
the watch tests pass repeatedly under parallel load (run the suite several times concurrently); no
orphan processes remain after a run.

## Boundaries

Work only in this lane's worktree. Never write bch-cloak, the shared `.lane.json`, the release,
`~/.local/bin`, or panes you did not create. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says.
No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
