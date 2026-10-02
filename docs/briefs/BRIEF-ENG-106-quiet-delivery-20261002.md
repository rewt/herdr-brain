# Brief: ENG-106, watch never interrupts the operator's typing

Org item **ENG-106**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

On 2026-10-02 the operator was typing a message to the supervisor in its pane when watch delivered an
`[org-report]` notice with `herdr agent prompt`; the notice text was spliced into the middle of the
operator's message. The supervisor pane is shared: the operator types there too. Deliver a notice only
when the pane is idle and its composer is empty (determine this from Herdr: agent status, the visible
composer line, or anything better Herdr offers; check what it actually exposes); otherwise queue it
durably and raise a non-focusing Herdr notification, and deliver when the composer is clear. Never lose
or duplicate a notice; preserve order. Apply the same rule to every place the product types into a
supervisor pane (watch, promote queue notices, settle/dispatch notices).

Judged by: offline tests for each behaviour; for ENG-106, a test where a notice arrives while a fake composer holds text and is delivered only after it clears; for ENG-107, a run of both suites and a harness run leaving the Herdr workspace list unchanged.

## Boundaries

Work only in this lane's worktree and scratch. Tests must not create, prompt, focus or close anything in
the operator's real Herdr session (use fakes or an isolated Herdr server/socket if one exists; say which).
Never write bch-cloak, the shared `.lane.json`, the releases, `~/.local/bin`, or panes you did not create;
create Herdr objects with --no-focus. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets
its own `ORG_ACTOR` and is bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
