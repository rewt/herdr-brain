# Brief: ENG-105, validation without a C compiler

Org item **ENG-105**. Read `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Every validation session compiles discovery's native process-lifetime owner with `/usr/bin/cc`
(`discovery/bounded.mjs`; ENG-81 added it for validator lifetime identity), so every adopter needs a C
toolchain (`docs/ADOPTING.md` now says so). That cuts against "any project, no setup". Remove the
requirement without weakening the lifetime guarantees ENG-81 established: ship the helper prebuilt per
supported platform (with checksums and a rebuild path), or a no-compiler mechanism with equivalent
guarantees, falling back clearly when neither is available. Update `docs/ADOPTING.md`.

Judged by: offline tests for each behaviour. (Amended 2026-10-02: the release gate runs once per release candidate, not per lane; see AGENTS.md.)

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
releases, `~/.local/bin`, harness or Herdr user configuration, or panes you did not create; create
Herdr objects with --no-focus. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its
own `ORG_ACTOR` and is bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
