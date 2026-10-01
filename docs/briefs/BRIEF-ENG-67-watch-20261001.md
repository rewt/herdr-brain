# Brief: ENG-67, the watch module, started early

Org item **ENG-67**, under Phase 3 (ARCH-8) of the platform roadmap (G-3), started during
Phase 2 because the supervisor needs it now. Read `docs/north-star.md` first, then
`docs/roadmap.md`, `AGENTS.md` and
`docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md`. They are the context; this brief
is only the ask.

## The outcome

When a worker this repository dispatched stops, the supervisor's pane (`supervisor-herdr`)
learns about it within a minute, with the run, its outcome and headline, and whether its
report passes `org check`. Nothing in that path calls a model or spends tokens while it
waits. This repository's supervisor is the first user; bch-cloak adopts it later in Phase
3, so it has to be generic enough for that without being built for it now.

## Why it matters, and to whom

The North Star's first measure is idle and polling inference, ideally zero. Today the
supervisor here has no way to learn a report landed except to keep a shell loop running
or look. bch-cloak's supervisor relies on `notify-watch.sh` every day; this repository
also has `contrib/settle-watch.mjs` and Brain's `watch`. Three watchers is one of the
duplicates the inventory names. The people who live with it:
- the supervisor, whose context should hold reports, not waiting;
- the operator, who should see in the console that a run is being watched and when it
  reported;
- a future adopter, who should not need to know which of three watchers to use.

## How the result will be judged

- The supervisor uses it for this lane's own successors: real runs, real reports,
  delivered to the pane, with no polling in the supervisor's turns.
- A report that fails `org check`, a worker that exits without a report, and a worker
  that is still alive after a long time each produce a clear, distinct notice rather
  than silence.
- It never writes `events.jsonl` itself; recording a report stays `org ingest`/`org sync`
  through the CLI (`AGENTS.md`).
- Tests are offline and cover the notices above without Herdr present.
- It says plainly which of the three existing watchers it replaces, which it builds on,
  and what is left to retire under ENG-64.

## Premises to test

1. "A new module is needed." Extending `contrib/settle-watch.mjs` or Brain's `watch` may
   be the smaller, better answer.
2. "Delivery means typing into the supervisor's pane." Herdr may offer a better channel
   (its socket, a notification, a file the harness reads). Check what Herdr actually
   offers before choosing.
3. "Waiting on the report file is enough." A worker can die, hang, or write a report
   somewhere else; the run record and the Herdr pane state may be better signals.
4. "notify-watch.sh is the model." It works for bch-cloak; that does not make its design
   right for a plugin. Read it as evidence, not a spec.
5. Anything in this brief you find wrong.

## Already decided

- The core (`bin/`, `lib/`) stays dependency-free, never calls a model and never runs in
  the background; a watcher is a separate module (`AGENTS.md`).
- Phase 2 does not create module folders wholesale (ARCH-7's 14:48 decision); creating the
  one folder this module needs is fine.
- bch-cloak keeps its own `notify-watch.sh` until Phase 3 switches it at a quiet point.

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record
  (`/Users/rewt/development/bastian`), never touch the activated release, never run
  `herdr/release.sh activate`.
- Do not type into the operator's or supervisor's real panes while testing; use a pane
  you create, and close it.
- No push, publish or account sign-up. No model calls.

## Where you are free

Design, language, where it lives, how it is armed (by `lane dispatch`, by the supervisor,
by a launchd job), and what it reuses. If the right answer is to retire two watchers and
keep one, say so and do it here when it is inside this repository.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-67-watch-20261001.md` using the template in your run brief (the path
`org start` printed, also `org brief <R-n>`), with `decisions`, `questions` and
`challenges` after `artifacts` as in `docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`.
Include in the report how the supervisor should arm it for the next run. Run `org check`
on it until it passes. Then stop.
