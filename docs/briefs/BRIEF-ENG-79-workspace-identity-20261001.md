# Brief: ENG-79, workspace identity for background workspaces

Org item **ENG-79**, platform roadmap G-3. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and `acceptance/README.md` first; this brief is only the ask.

## The outcome

The test harness's case 16 fails on main: a background Herdr workspace created for a project never
reports its canonical checkout in `workspace list` within 15 seconds after its shell's cwd is
ready, while an active configured workspace does. The supervisor launchers an existing project
uses (`supervisor/open-session.mjs` behind `settle.sh`/`continue.sh`, and bch-cloak's wrappers
per the ENG-64 cutover plan) refuse before running. Make canonical project identity available to
these callers reliably, without focusing operator panes or inventing metadata, and make case 16
pass. `contrib/settle-watch.mjs` must not change; if the fix belongs in the cutover (bch-cloak
moving to `open-session.mjs`), say so and prove it on the harness.

Judged by: `node acceptance/run.mjs --candidate <your lane>` shows case 16 PASS with every other case unchanged; offline tests for the lookup.

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
