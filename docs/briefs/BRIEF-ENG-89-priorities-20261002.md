# Brief: ENG-89, priorities the operator owns and agents serve

Org item **ENG-89**, Phase 4 (ARCH-9). Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md`
and `console/modern` (the Control view landed in ENG-85) first. This brief is only the ask.

## The outcome

The project has a short ranked list of priorities that the operator owns. Agents serve them: a
dispatch can name the priority it serves (`dispatch/dispatch.mjs` and `record start` metadata),
work that serves none is visible as such (never refused: budgets and alignment are advisory,
`AGENTS.md`), and the console has a Priorities view where the operator reads the list, sees the
work under each, and re-ranks through a validating CLI command. The record keeps who changed a rank
and why. Agents may propose a priority or a re-rank as a question to the operator; they do not
re-rank on their own.

## Why it matters

Agreed with the operator (2026-09-30): the real risk in agentic work is scope drift into rabbit
holes, and "it's important to maintain alignment on priorities." In bch-cloak, item priority
numbers were changed about 1,000 times by supervisor sessions while the operator's real priorities
lived in prose notes. Priorities that agents can rewrite are not the operator's.

## Judged by

- Offline tests: a ranked list, re-rank with who/why, dispatch serving a priority, unaligned work
  flagged, an agent's re-rank proposal arriving as a waiting question.
- Console `--print` renders of the Priorities view (before/after) in the report.
- Works in an unconfigured project (no priorities yet: the console says so and invites the operator).
- Status stays derived; older folds ignore any new event type.

## Boundaries

Work only in this lane's worktree. Never write bch-cloak, the shared `.lane.json`, the release,
`~/.local/bin`, or panes you did not create. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says.
No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
