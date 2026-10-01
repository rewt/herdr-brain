# Brief: ENG-73, the housekeeping module

Org item **ENG-73**, under Phase 3 (ARCH-8). Read `docs/north-star.md`, `docs/roadmap.md`,
`AGENTS.md` and `docs/reports/INVENTORY-bch-cloak-workflow-2026-10-01.md` first. This brief is
only the ask.

## The outcome

Finished worker sessions get closed, tabs stay tidy and interrupted workers get resumed without
anyone thinking about it, for any project that switches housekeeping on. No model calls; a
schedule, not a resident agent. Herdr-brain uses it first, for its own lanes.

## Why it matters, and to whom

bch-cloak's janitor does this every day (`kit/bch-cloak-20261001/supervisor/janitor.sh`: every
10 minutes `close-finished-agents.sh` and `tidy-tabs.sh`, every 60 seconds
`resume-interrupted.sh`). Here, finished workers pile up: today's lanes left idle Codex sessions
in their workspaces until `lane close`. The operator should not be the janitor, and neither
should the supervisor's context.

## How the result will be judged

- A worker is closed only when its run in the record has a recorded report or is abandoned and
  its lane work is promoted or closed; never a worker with an open run, a blocked worker waiting
  on a question, or a session the record does not know (`AGENTS.md`: session metadata never
  authorizes deletion).
- A resumed worker is one that Herdr shows interrupted mid-run, with an open run; say how you
  tell interrupted from finished, with evidence from Herdr itself.
- It reuses `supervisor/tidy-tabs.mjs` (moved from `contrib/` in ENG-66) rather than copying it.
- How it is scheduled (launchd, Herdr, a loop the supervisor starts) is chosen with reasons; it
  can be switched off and its actions are logged where the console or supervisor can see them.
- Tests offline, with fakes for Herdr; `npm test` green.

## Premises to test

1. "Close, tidy and resume belong together." Resume may belong with watch or dispatch.
2. "A schedule is needed." Herdr events or the watch module's final notice may be the better
   trigger for closing.
3. "bch-cloak's scripts are the model." Read them as evidence, not a spec.
4. Anything else here you find wrong.

## Boundaries

- Work only in this lane's worktree. Never write bch-cloak's repository or record, the shared
  `.lane.json`, the release, `~/.local/bin` or launchd. Keep `contrib/settle-watch.mjs` as
  `AGENTS.md` says. No push or publish.
- Do not close, resume or type into real panes while testing; use fakes, or panes you create and
  close. Say in the report how the supervisor should switch it on here.

## Where you are free

Shape, triggers, schedule, where it lives, what it reuses.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject, not hash; `record
check` it, commit it, and run `lane check` last. Then stop.
