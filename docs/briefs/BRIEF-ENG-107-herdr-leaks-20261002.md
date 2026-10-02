# Brief: ENG-107, tests and the harness leave nothing in the operator's Herdr

Org item **ENG-107**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

245 leaked Herdr workspaces were found in the operator's session on 2026-10-02, all with deleted
directories: 212 from `monitor-plugin-test-*` (the plugin-install tests open real Herdr workspaces and
never close them) and 33 from `herdr-acceptance-*` runs (the harness misses some, including linked
worktree workspaces). The supervisor closed the 106 linked-worktree ones; 139 scratch main-checkout
workspaces remain for now. Make `npm test` and `npm run test:lanes` never touch the operator's Herdr (fake
it, or an isolated server if Herdr supports one), and make the harness close every workspace it opens,
on pass, fail or interruption, with an end-of-run audit that names anything left. Do not close the
operator's existing leaked workspaces yourself; report how many your change would have prevented.

Judged by: offline tests for each behaviour; for ENG-106, a test where a notice arrives while a fake composer holds text and is delivered only after it clears; for ENG-107, a run of both suites and a harness run leaving the Herdr workspace list unchanged.

## Boundaries

Work only in this lane's worktree and scratch. Tests must not create, prompt, focus or close anything in
the operator's real Herdr session (use fakes or an isolated Herdr server/socket if one exists; say which).
Never write bch-cloak, the shared `.lane.json`, the releases, `~/.local/bin`, or panes you did not create;
create Herdr objects with --no-focus. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets
its own `ORG_ACTOR` and is bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
