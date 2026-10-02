# Brief: ENG-87, every review yields a public copy

Org item **ENG-87**. Read `AGENTS.md` and `lanes/README.md` (the `lane review` section) first.

## The outcome

`lane review --route review-codex` (Codex reviewer) three times on 2026-10-01 produced a NEEDS-WORK
verdict but no public copy in the lane (`docs/reviews/<topic>/<sha>-rN.md`), with
`lane review: each finding must have an allowed tag, repository-relative file:line, and concrete
Fix`. The private review exists under `.lane/reviews/`; the worker who must fix the findings
cannot read it. Make a NEEDS-WORK or FAIL review always yield a public copy the worker can read:
make the reviewer's prompt/template produce the required shape for every route, and make the
projection keep findings it cannot fully parse (marked as such) rather than refuse, without ever
publishing the private-only sections. Examples: `.lane/reviews/promote/`,
`.lane/reviews/console-control/cd41a7b-r1.md`, `.lane/reviews/acceptance-completion/06b5d67-r1.md`
in the canonical checkout (read-only).

Judged by offline tests with malformed findings producing a public copy, private sections never
leaking, and `npm run test:lanes` green.

## Boundaries

Work only in this lane's worktree. Never write bch-cloak, the shared `.lane.json`, the release,
`~/.local/bin`, or panes you did not create. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says.
No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it,
commit it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
