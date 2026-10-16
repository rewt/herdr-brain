# Roadmap: the Herdr platform

Status lives in herdr-brain's own record (`/Users/rewt/development/rewt/.org`, goal **G-3**):
`record show G-3`, `record status`, or the console's herdr-brain project. This page holds only the
shape and the reasons; it names items by ID and never repeats their state.

## Goal

bch-cloak's agent cycle works: dispatch, routing, watch, settle, promote, housekeeping and the
supervisor. Standardize it as a standalone product that requires Herdr, with an optional thin Herdr
plugin front door, that any project on any machine can adopt, without disturbing bch-cloak while it
runs. The inventory of what bch-cloak runs today is `docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md`.

## Operating model (operator, 2026-10-01)

Agents decide, the record captures, the console shows, the human steers. Most question categories
are answered automatically and tracked; the operator ranks priorities in the record, where they survive
context clears; agents serve them or propose changes as waiting questions; questions and decisions come from structured report fields, never from reading an
agent's narrative.

## Shape

A standalone product made of modules a project switches on in its config. Herdr is the runtime;
Brain is the control plane. The optional thin Herdr plugin front door supplies keybound actions
that open the operator chat, logs viewer and status; the core never depends on it.
Names: plain module names, chosen by the operator (HUM-15).

| Module | Job | Comes from (bch-cloak) |
|---|---|---|
| record | The record: items, runs, reports, questions, decisions, priorities | `org` (permanent alias) |
| routes | Models, efforts, route table, selection policy | `scripts/lane/routing.json`, `routing.mjs` |
| dispatch | Record the run, brief, lane, routed agent, watcher | `dispatch.sh`, `lane.mjs dispatch` |
| watch | Wait for the worker, validate the report, deliver it | `notify-watch.sh` |
| settle | Settle and review desks, hand-off to review, fix rounds | `settle.sh`, `apply-settle.sh`, `review-desk.sh` |
| promote | Promotion queue | `promote-queue.sh`, `promote.sh` |
| release | Batch promotions, tag a candidate, gate once, ask the operator to ship | Release acceptance and operator ship/activation |
| housekeeping | Housekeeping | `janitor.sh` and the scripts it runs |
| supervisor | Supervisor session setup and protocol | `session-start.sh`, `SETTLE.md`, `WORK-PATTERN.md` |
| console | The console, as a pane; edits the configuration | `lane/console-autonomy` |

## Phases

Phases are guideposts, not a task list. The tasks under each one come from the agents doing
the work (their reports' proposals become items) when the phase starts; only what is
actionable now is written in advance.

| Phase | Item | Why it comes here |
|---|---|---|
| 0. Protect what works | ARCH-5 | bch-cloak's live kit is gitignored and has no history |
| 1. Separate deploying from developing | ARCH-6 | Today a merge to main is a live deploy, because bch-cloak's `org` is a symlink into this working tree |
| 2. Restructure and rename | ARCH-7 | The item layer stays our own record (ARCH-11) and the names are plain (HUM-15) |
| 3. Bring the cycle over, module by module | ARCH-8 | Each module runs alongside the bch-cloak piece it replaces, then is switched at a quiet point; order: routes, watch, housekeeping, dispatch, settle, promote, supervisor |
| 4. The console as control plane | ARCH-9 | Decided / Asked / Waiting on you, priorities, routes and desks, all written through validating commands into tracked config |
| 5. Adoption | ARCH-10 | `init`, a pilot on herdr-brain itself, docs, the marketplace when the operator decides |

## Rules for the whole programme

1. bch-cloak keeps running its own kit until a module replaces that exact piece, and every switch can be undone.
2. Development happens on lanes here and runs standalone against Herdr; bch-cloak only runs installed releases.
3. Project configuration lives in the project, tracked; machine-specific values (paths, persona, accounts) stay local.
4. The contract in `AGENTS.md` holds: the record never calls a model, budgets are advisory, status is derived, older code ignores newer event types.
