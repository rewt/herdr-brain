# Roadmap: the Herdr platform

Status lives in herdr-brain's own record (`/Users/rewt/development/rewt/.org`, goal **G-3**):
`org show G-3`, `org status`, or the console's herdr-brain project. This page holds only the
shape and the reasons; it names items by ID and never repeats their state.

## Goal

bch-cloak's agent cycle works: dispatch, routing, watch, settle, promote, housekeeping and the
supervisor. Standardize it as one Herdr plugin that any project on any machine can adopt, with the
console as its control plane, without disturbing bch-cloak while it runs. The inventory of what
bch-cloak runs today is `docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md`.

## Operating model (operator, 2026-10-01)

Agents decide, the record captures, the console shows, the human steers. Most question categories
are answered automatically and tracked; agents rank priorities in the record, where they survive
context clears; questions and decisions come from structured report fields, never from reading an
agent's narrative.

## Shape

One plugin made of modules a project switches on in its config. Herdr installs plugins per machine
and has no plugin-to-plugin dependencies, so modules share one install and one version. Names are
proposed in HUM-15.

| Module | Job | Comes from (bch-cloak) |
|---|---|---|
| tally | The record: items, runs, reports, questions, decisions, priorities | `org` |
| routes | Models, efforts, route table, selection policy | `scripts/lane/routing.json`, `routing.mjs` |
| dispatch | Record the run, brief, lane, routed agent, watcher | `dispatch.sh`, `lane.mjs dispatch` |
| lookout | Wait for the worker, validate the report, deliver it | `notify-watch.sh` |
| settle | Settle and review desks, hand-off to review, fix rounds | `settle.sh`, `apply-settle.sh`, `review-desk.sh` |
| chute | Promotion queue | `promote-queue.sh`, `promote.sh` |
| wrangler | Housekeeping | `janitor.sh` and the scripts it runs |
| trail boss | Supervisor session setup and protocol | `session-start.sh`, `SETTLE.md`, `WORK-PATTERN.md` |
| monitor | The console, as a pane; edits the configuration | `lane/console-autonomy` |

## Phases

Phases are guideposts, not a task list. The tasks under each one come from the agents doing
the work (their reports' proposals become items) when the phase starts; only what is
actionable now is written in advance.

| Phase | Item | Why it comes here |
|---|---|---|
| 0. Protect what works | ARCH-5 | bch-cloak's live kit is gitignored and has no history |
| 1. Separate deploying from developing | ARCH-6 | Today a merge to main is a live deploy, because bch-cloak's `org` is a symlink into this working tree |
| 2. Restructure and rename | ARCH-7 | Decide the item layer (ARCH-11) and the names (HUM-15) once, before anything is built on them |
| 3. Bring the cycle over, module by module | ARCH-8 | Each module runs alongside the bch-cloak piece it replaces, then is switched at a quiet point; order: routes, lookout, wrangler, dispatch, settle, chute, trail boss |
| 4. The console as control plane | ARCH-9 | Decided / Asked / Waiting on you, priorities, routes and desks, all written through validating commands into tracked config |
| 5. Adoption | ARCH-10 | `init`, a pilot on herdr-brain itself, docs, the marketplace when the operator decides |

## Rules for the whole programme

1. bch-cloak keeps running its own kit until a module replaces that exact piece, and every switch can be undone.
2. Development happens on lanes here and runs as a dev plugin; bch-cloak only runs installed releases.
3. Project configuration lives in the project, tracked; machine-specific values (paths, persona, accounts) stay local.
4. The contract in `AGENTS.md` holds: the record never calls a model, budgets are advisory, status is derived, older code ignores newer event types.
