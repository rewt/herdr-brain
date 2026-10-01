# Brief: ENG-64, one watcher (this repository's part)

Org item **ENG-64**, under Phase 3 (ARCH-8) of the platform roadmap (G-3). Read
`docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md`, `watch/README.md` and
`docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` first. This brief is only the ask.

## The outcome

This repository has one watcher for "a worker stopped; tell the supervisor":
`watch/watch.mjs` (ENG-67, on main, used live by the supervisor since 15:28 today).
`contrib/settle-watch.mjs` and Brain's `watch` either retire, narrow to a job `watch/` does
not do, or are shown to be worth keeping, each with evidence. And there is a written,
reversible plan for switching bch-cloak from its `notify-watch.sh` to `watch/` at a quiet
point, which the operator can activate through a release.

## Why it matters, and to whom

Three watchers is a duplicate the inventory names; a future adopter should not have to
pick one. The supervisor and operator depend on whatever survives, so nothing may go quiet.

## How the result will be judged

- For each of settle-watch and Brain watch: who calls it today (scripts, launchd, the
  console), what job it does that `watch/` does not, and what you did about it.
- Brain's `watch` runs as a launchd service from the activated release
  (`~/.local/share/herdr-monitor/current/brain/bin/brain.mjs watch`) and feeds the operator's
  queue. Change its code here if that is the answer, but do not stop, unload or edit the
  running service or its plist; say in the report what the switch is and how to undo it.
- `supervisor/continue.sh` and `supervisor/arm-watch.sh` still work, or are replaced by
  something that does, with `supervisor/SETTLE.md` updated to match.
- The bch-cloak plan names each file it touches (from `kit/bch-cloak-20261001/`), the order,
  how to check it worked, and how to roll it back.
- `npm test` green; tests offline.

## Premises to test

1. "settle-watch should retire." Its job (open a fresh settle session when a run stops) may
   be a different module (settle), not a watcher.
2. "Brain watch duplicates watch/." It may be the operator-facing queue, which is the
   console's input rather than the supervisor's.
3. "bch-cloak can switch watcher without touching its dispatch." `dispatch.sh` arms
   `notify-watch.sh` today; check what the switch really needs.
4. Anything else here you find wrong.

## Already decided

- `watch/` is the watcher (ENG-67). The core never runs in the background (`AGENTS.md`).
- Every bch-cloak switch waits for a release the operator activates.

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record. Never
  touch the activated release, `~/.local/bin`, or the launchd service. No push or publish.

## Where you are free

What retires, what narrows, what moves, and the shape of the plan.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-64-one-watcher-20261001.md` using the template in your run brief (`record
brief <R-n>`), with `decisions`, `questions` and `challenges` after `artifacts` as in
`docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`. Run `record check` on it until it passes,
commit it, and run `lane check` last so the gate records your final commit. Then stop.
