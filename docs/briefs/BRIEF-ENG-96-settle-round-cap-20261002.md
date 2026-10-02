# Brief: ENG-96, settle honours a review-round cap

Org item **ENG-96**. Read `AGENTS.md`, `settle/README.md` and `supervisor/PROTOCOL.md` first.

## The outcome

Settle dispatches a fix round on every NEEDS-WORK. Overnight on 2026-10-02 several items (ENG-80,
ENG-88, ENG-94) went five to seven rounds, each finding narrower Moderate issues, and the
supervisor had to decide by hand to stop reviewing and check the last round itself; settle had
already dispatched the next fix round by then. Give settle a review-round cap that the supervisor
(per item, recorded) or the project (tracked config default) can set: once the cap is reached and
the review has no Major or FAIL, settle does not dispatch; it returns the findings to the supervisor
as a distinct result (for example `promotable_with_findings`) with the reviewed head, so the
supervisor can promote and file follow-ups, or send one more round. Majors and FAIL still produce
a fix round or escalation. The cap and the decision are recorded.

Judged by offline tests for: cap not reached (fix round as today); cap reached with Moderates only
(no dispatch, findings returned, recorded); cap reached with a Major (fix round); the supervisor
module's `handle` path passing the new result through.

## Boundaries

Work only in this lane's worktree. Never write bch-cloak, the shared `.lane.json`, the release,
`~/.local/bin`, or panes you did not create. Every test sets its own `ORG_ACTOR` and is bounded.
No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
