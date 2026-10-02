# Brief: ENG-94, the supervisor module

Org item **ENG-94**, the last module of Phase 3 (ARCH-8). Read `docs/north-star.md` (especially "The
problem", capability 3 and 4, and the 2026-10-01 revision about clearing the supervisor chat),
`docs/roadmap.md`, `AGENTS.md`, `supervisor/KICKOFF.md`, `supervisor/SETTLE.md`, and the module
READMEs for dispatch, watch, settle, promote, housekeeping and discovery. This brief is only the ask.

## The outcome

A fresh supervisor session in any project, entered through discovery's supervisor entry, picks up
where the last one stopped at near-zero cost, and the cycle runs on one protocol:

- **Cold start from the record, no model:** priorities, what is running and on which route, what
  reported and awaits settlement, what waits on the operator, what was decided since the last
  session, and what the supervisor should do next, in a compact brief generated from the record.
  Clearing the supervisor's chat loses nothing because all of this lives in the record.
- **One path per notice:** a watch `[org-report]` notice leads to `settle` (independent review on
  the project's review route), and a `promotable` result to the promote queue, with fix rounds and
  escalations handled as settle returns them. What is mechanical runs without a model; what needs
  judgment goes to the supervisor with a compact summary.
- **A generic protocol** that replaces this repo's hand-written `supervisor/KICKOFF.md` (keep a
  short project-specific part only where the record cannot hold it) and, after the release-gated
  switch, bch-cloak's `session-start.sh`, `SETTLE.md` and `WORK-PATTERN.md` (evidence in
  `kit/bch-cloak-20261001/supervisor/`).

## Why it matters

The North Star's primary measure: the supervisor's context should not grow all day. Tonight this
supervisor ran the cycle by hand (ingest, rebase, gate, review, read verdict, fix round, promote) for
about 30 runs; each step was mechanical except the judgment calls. Settle, dispatch, watch and the
promote queue now exist; the supervisor module ties them into the operator's long-running chat
without becoming a resident head.

## Judged by

- A test harness case: a fresh supervisor in an unconfigured project and one with history receives
  a correct cold start from the record (no model calls), and a scripted report goes from watch notice
  through settle to promotion with only the judgment steps left to the supervisor.
- The cold start for this repository's record is short (report its size in tokens) and accurate.
- No resident model, no background process in the core; supervisor-only actions stay
  supervisor-only (lane workers never get them).

## Premises to test

1. "The supervisor needs a module at all." Much may already be discovery's supervisor policy plus
   `record snapshot`/`record today`; say what is missing.
2. "Settle should run automatically on every watch notice." Maybe only for the mechanical part;
   decide where judgment must stay with the supervisor.
3. "KICKOFF.md can become generic." Some of it is this project's history; decide what belongs in
   the record instead.

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
release, `~/.local/bin`, launchd, or panes you did not create. Keep `contrib/settle-watch.mjs` as
`AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded in time. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
