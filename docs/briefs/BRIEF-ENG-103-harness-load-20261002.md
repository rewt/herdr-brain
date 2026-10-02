# Brief: ENG-103, the release gate under heavy load

Org item **ENG-103**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

On 2026-10-02 the v0.1.8 gate ran at load average 25-29 (bch-cloak's own heavy work beside it) and
reported cases 19-20 as product FAIL ("timeout: held worker report") and case 27 as PENDING (Herdr
pane.current timeouts), while v0.1.7 passed the same cases at normal load. A busy machine must never
fail a release: measure load during the run, scale waits with it or classify timeouts under measured
heavy load as harness PENDING with the load named, and keep genuine product timeouts (a candidate that
never reports at normal load) as FAIL. Evidence: `/private/tmp/herdr-acceptance-Wj1fBy/evidence/` (read-only).

Judged by: offline tests for each behaviour; the release gate on a candidate from your lane still passes.

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
releases, `~/.local/bin`, harness or Herdr user configuration, or panes you did not create; create
Herdr objects with --no-focus. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its
own `ORG_ACTOR` and is bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
