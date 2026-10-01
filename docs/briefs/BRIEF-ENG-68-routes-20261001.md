# Brief: ENG-68, the routes module

Org item **ENG-68**, under Phase 3 (ARCH-8) of the platform roadmap (G-3). Read
`docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and
`docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` first. This brief is only the ask.

## The outcome

One place says which harness, model, effort and arguments a kind of work runs on, and
everything that starts work reads it. Dispatching by route name is enough: the run's
record (`record start`) and the agent session (`lane dispatch`) both get the route's values
without the caller retyping them. A project can say which route a class of task should
use (a selection policy), and the console can later edit that table (Phase 4).

## Why it matters, and to whom

- The supervisor here typed `--harness codex --model gpt-5.6-sol --effort high` by hand on
  every `record start` today, copying `lane routes`. Copies drift.
- bch-cloak has the richer version (`kit/bch-cloak-20261001/lane/routing.json` and
  `routing.mjs`: 23 routes, dispatch defaults with launch environment, per-harness
  `always_args`, a `selection_policy`), and its own `authority` rule is broken by
  `settle.sh` and `dispatch.sh` copying values (inventory, "Drift and duplication").
- A future adopter configures routes once and never edits scripts.

## How the result will be judged

- `lane dispatch <topic> --route R` and `record start <ID> --route R` (or whatever shape you
  choose) produce a session and a run record that agree with the route, with tests.
- bch-cloak's `routing.json` (the kit copy) loads into the module without losing a field
  that its scripts use; say which fields are bch-cloak's own and stay project config.
- The core stays dependency-free and never branches on harness, provider or model: those
  stay opaque run metadata (`AGENTS.md`). If `record start` reading routes would break that,
  find the shape that doesn't.
- Herdr-brain's own `/Users/rewt/development/rewt/.lane.json` routes keep working.
- `npm test` and `npm run test:lanes` green; tests offline.

## Premises to test

1. "Routes belong in a module of their own." They may belong inside `lanes/` config, with
   the record only accepting a route name.
2. "`record start` should resolve routes." That may couple the record to dispatch; perhaps
   `lane dispatch` should call `record start` with the resolved values instead.
3. "bch-cloak's selection policy is generic." Some of it may be bch-cloak's own (pools,
   accounts, personas).
4. Anything else here you find wrong.

## Already decided

- Module names are plain (HUM-15); `record` is the CLI, `org` an alias (ENG-65).
- The order of Phase 3 and that every bch-cloak switch waits for a release the operator
  activates (roadmap, ARCH-8 notes).

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record
  (`/Users/rewt/development/bastian`); read the kit copy in this repo instead. Do not edit
  `/Users/rewt/development/rewt/.lane.json` (shared config); propose changes in the report.
- Never touch the activated release or `~/.local/bin`. No push, publish or sign-up.

## Where you are free

Design, file layout, config format, migration path. If the smaller answer is right, take it.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-68-routes-20261001.md` using the template in your run brief (`record brief
<R-n>`), with `decisions`, `questions` and `challenges` after `artifacts` as in
`docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`. Run `record check` on it until it passes,
commit it, and run `lane check` last so the gate records your final commit. Then stop.
