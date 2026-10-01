# Brief: ENG-71, the dispatch module

Org item **ENG-71**, under Phase 3 (ARCH-8) of the platform roadmap (G-3). Read
`docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md`, `watch/README.md`, `lanes/README.md` and
`docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` first. This brief is only the ask.

## The outcome

One command takes an item, a lane, a route and a brief to a running, watched worker. Today
the supervisor does this in five steps for every run, by hand:

1. `lane open <topic>` (or reuse an open lane);
2. `record start <ID> --route R --workspace <worktree> --report <path>`;
3. `lane dispatch <topic> --route R "<prompt naming the brief and the run brief>"`;
4. `record set R-n agent=<name> pane=<id>`, parsed from dispatch's output;
5. `supervisor/arm-watch.sh R-n`.

bch-cloak does the same in `kit/bch-cloak-20261001/supervisor/dispatch.sh` (25 lines), with
lane preparation and a fast-forward of a reused lane to a base.

## Why it matters, and to whom

Coordination should not cost reasoning. Each hand step is a place to slip (today: a run's
agent and pane were recorded into one field; a fix round was sent to a worker on the wrong
model). The supervisor, bch-cloak's supervisor after its switch, and a future adopter all
dispatch this way.

## How the result will be judged

- The supervisor uses it for the next real dispatch here, and the run shows route, harness,
  model, effort, agent, pane and lane without the supervisor typing any of them twice.
- A fix round on an existing lane works too: a new run on the same item, either prompting the
  worker already there or starting a fresh one, as the caller chooses.
- A failure part-way (open fails, dispatch fails, watch fails) leaves the record and the lane in
  a state the supervisor can see and retry; never a run that looks dispatched but has no worker
  or no watcher.
- The record stays a library-free core that never runs in the background; dispatch is a module
  that calls the CLIs (`AGENTS.md`).
- Tests offline, with fakes for Herdr; `npm test` and `npm run test:lanes` green.

## Premises to test

1. "Dispatch is its own module." It may be a `lane` subcommand, or a `supervisor/` script.
2. "The prompt to the worker can be generated." Today each prompt names the brief, the run
   brief, the report path and the run id; most of that is mechanical, but the caller may need
   to add words for a fix round.
3. "bch-cloak's dispatch.sh is the model." Read it as evidence of what is needed (prepare,
   base, detached watcher), not as a design.
4. Anything else here you find wrong.

## Already decided

- Routes come from `lanes/routes.mjs` (ENG-68); `record start --route` records declared metadata.
- `watch/watch.mjs`, armed by `supervisor/arm-watch.sh`, is the one watcher (ENG-64, ENG-67).
- bch-cloak switches only through a release the operator activates.

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record, the shared
  `/Users/rewt/development/rewt/.lane.json` (propose changes instead), the activated release or
  `~/.local/bin`. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. No push or publish.
- Do not dispatch real agents or type into real panes while testing; use fakes, or a pane you
  create and close.

## Where you are free

Shape, name, where it lives, flags, and what it reuses.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-71-dispatch-20261001.md` using the template in your run brief (`record brief
<R-n>`), with `decisions`, `questions` and `challenges` after `artifacts` as in
`docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`. Cite commits by subject, not hash. Run
`record check` on it until it passes, commit it, and run `lane check` last. Then stop.
