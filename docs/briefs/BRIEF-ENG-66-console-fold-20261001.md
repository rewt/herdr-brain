# Brief: ENG-66, one console

Org item **ENG-66**, under Phase 2 (ARCH-7) of the platform roadmap (G-3). Read
`docs/north-star.md` first, then `docs/roadmap.md` and `AGENTS.md`. They are the context;
this brief is only the ask.

## The outcome

One console. The modern console (`console/modern`, `record console --modern`) carries the
ideas from the standalone items pane (`console/items.mjs`, `console/items/`) that are worth
keeping, and the standalone pane is retired. Separately, every file in `contrib/` is kept,
moved or retired, each with a one-line reason.

## Why it matters, and to whom

The operator watches agents work from the console, beside a long-running supervisor chat.
On 2026-09-30 they asked for observability of agent-created items (typed IDs like ENG/ARCH/
HUM with the agent's reason, who is working each, reports, decisions, closes) rather than
human-maintained goal lists, because "the minute I create a list of goals it's out of
date". On 2026-10-01 they saw both screens and said they prefer the modern console's
design; the items pane was built standalone first. Two consoles is one too many.

The people who live with it:
- the operator, who judges the console by its screen, not by documents about it;
- the supervisor, which the console sits beside;
- a future adopter, who should meet one console.

## How the result will be judged

- By the screen. Show before and after with `--print` renders (or the console's own
  render-to-text path) in the report, against the live herdr-brain record
  (`/Users/rewt/development/rewt/.org`, read-only) and a fixture.
- Nothing the operator uses today is lost; the modern console's design is kept, not
  re-done. A glance should tell the operator whether anything needs them.
- `console/items.mjs` and anything only it used are gone, or the report says why one
  piece stays.
- `contrib/`: each file has a verdict and a reason. Retire what nothing uses. Note that
  `contrib/settle-watch.mjs` is still used by `supervisor/continue.sh` and
  `supervisor/arm-watch.sh`, and its retirement belongs to ENG-64; leave it in place.
- `npm test` green, tests offline, and the console still writes only through the CLI.

## Premises to test

1. "The items pane has ideas worth carrying over." Maybe the modern console already does
   most of it. Say which ideas, and which you left out and why.
2. "The operator wants items, not goals, as the frame." The modern console is built around
   projects and work blocks. Judge whether the two fit together or one should give way,
   and show it rather than argue it.
3. "contrib/ should exist." Perhaps its survivors belong elsewhere (`supervisor/`, a module
   folder, `docs/`).
4. Anything in this brief you find wrong.

## Already decided

- The modern console's design is the console (operator, 2026-10-01).
- The CLI's public name is `record`; `org` is a permanent alias (ENG-65, on main).
- The console depends on Ink/React and a markdown renderer only; the core stays
  dependency-free (`AGENTS.md`).
- Archived earlier work on the same ideas is at tag `archive/lane/block-review`
  (`console/modern/feed.mjs` there): mine it if useful, but the operator did not choose its
  other changes (block screen as default, typing into sessions), so don't bring those in.

## Boundaries

- Work only in this lane's worktree. Do not touch the `lane-console-autonomy` worktree:
  the operator's live console tab runs from it.
- Never write bch-cloak's repository or record, never touch the activated release.
- Read the live record only; never write it from tests.
- No push, publish or account sign-up.

## Where you are free

Which ideas to carry, how they fit the screen, what `contrib/` becomes. If the right move is
smaller or different than this brief says, do that and explain.

## Reply

Commit your work on this lane. Write the report at
`docs/reports/ENG-66-console-fold-20261001.md` using the template in your run brief (the
path `record start` printed, also `record brief <R-n>`), with `decisions`, `questions` and
`challenges` after `artifacts` as in `docs/briefs/BRIEF-ARCH-11-item-layer-20261001.md`.
Run `record check` on it until it passes, commit it, and run `lane check` last so the gate
records your final commit. Then stop.
