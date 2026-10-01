# Brief: ENG-74, local release acceptance

Org item **ENG-74**, under Phase 3 (ARCH-8). Read `docs/north-star.md`, `docs/roadmap.md`,
`AGENTS.md`, `docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` and the bch-cloak
cutover plan in `docs/reports/ENG-64-one-watcher-20261001.md` first. This brief is only the ask.

## The outcome

One local command that shows, before anything reaches bch-cloak, that a candidate release works
the way we expect. The operator asked for this (2026-10-01): "before we push this to bch-cloak,
design some local test cases to ensure things are working the way we expect." No bch-cloak
switch happens until it passes against the release that carries the switch.

## Why it matters, and to whom

Today's checks were offline unit tests (fakes for Herdr) and real use by the supervisor here.
Neither runs the whole cycle end to end, and neither runs bch-cloak's own calls against the
release that would replace them. Two lanes today nearly broke a bch-cloak command through a path
nobody tested (`contrib/settle-watch.mjs`, see `AGENTS.md`). bch-cloak runs real work every day;
the operator should be able to read one screen and know a release is safe to activate.

## What it should cover (the cases are yours to design)

- **The cycle, end to end, in a scratch project:** a scratch git repo with a scratch record and
  lane config; dispatch an item by route (`dispatch/dispatch.mjs`) to a scripted stand-in worker
  (a real Herdr pane running a script, not a model) that commits and writes a report; the watcher
  delivers the notice to a stand-in supervisor pane; the report is ingested; the lane is checked,
  promoted and closed; housekeeping (when ENG-73 lands) closes the finished worker. Include the
  failure paths that matter: no report, invalid report, blocked worker, a fix round.
- **bch-cloak's calls against the candidate release:** the exact invocations bch-cloak's scripts
  make today (`launch-supervisor.mjs` → `contrib/settle-watch.mjs` with `--model`/`--effort`;
  `org` from PATH in `apply-settle.sh` and `close-finished-agents.sh`; `routing.json` loading;
  `notify-watch.sh`'s replacement per the ENG-64 plan), run against copies in scratch, never the
  live repository. Read the live bch-cloak scripts only to copy them into scratch; the kit in this
  repo is an older snapshot.
- **Release mechanics** in a scratch `HERDR_MONITOR_HOME` and bin directory: build, activate,
  rollback, restore, including the `record` launcher on an install activated before it existed.
- **Each switch in the ENG-64 cutover plan:** the switch and its rollback, each with a check.

## How the result will be judged

- One command runs every case and prints a one-screen result the operator can read: each case,
  pass or fail, and where its evidence is.
- No model calls. Nothing outside scratch directories, scratch Herdr workspaces it creates and
  closes, and scratch homes changes. It cleans up after itself, or says what it left.
- It runs against a chosen release directory or tag, so the supervisor can run it against v0.1.3
  now and against each later candidate.
- It is not part of `npm test` (which stays offline and fast); say how it is run and how long it
  takes. Run it against the current main and against v0.1.3, and report both results.

## Premises to test

1. "Scripted stand-in workers are enough." Some behaviour (Codex/Claude idle and blocked states,
   prompt delivery timing) may only show with a real harness; say which, and whether an optional
   live case on the cheapest route is worth having.
2. "Real Herdr in tests is safe." Prove the cases cannot touch the operator's or supervisor's
   panes, or bch-cloak's workspaces.
3. "The bch-cloak calls listed above are all of them." Find any others.
4. Anything else here you find wrong.

## Boundaries

- Never write bch-cloak's repository, record or workspaces; read its live scripts only to copy
  them into scratch. Never touch the activated release, `~/.local/bin`, `~/.local/share/
  herdr-monitor` (use a scratch home), launchd, or the shared `.lane.json`. Keep
  `contrib/settle-watch.mjs` as `AGENTS.md` says. No push, publish or model calls.
- Never prompt, close or type into panes you did not create.

## Where you are free

Case design, harness shape, language, where it lives, what it reuses.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`, and the one-screen results for main and v0.1.3
in the body; cite commits by subject, not hash; `record check` it, commit it, and run
`lane check` last. Then stop.
