# Brief: ENG-100, Phase 5 adoption guide and publication audit

Org item **ENG-100**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Phase 5 (ARCH-10): adoption. With discovery (ENG-77, ENG-82) there is no `init`: installing the
plugin is the setup. Write the adopter's guide (`docs/ADOPTING.md` or similar): install and
uninstall, what an entering agent sees, project overrides (`.lane.json`, `.org/config.json`,
`.housekeeping.json`, entry settings), the cycle (dispatch, watch, settle, promote, housekeeping,
supervisor), the console, releases, activation and rollback. Rewrite `README.md` for a new adopter.
Prove the guide on a fresh scratch project and a scratch home, following only the guide. Then audit
the repository for publication readiness (HUM-14: before any push, review its contents): list every
file or path that must change or be removed before publishing (the bch-cloak kit snapshot, absolute
personal paths, private reports, anything naming accounts or machines), without changing them yet.

Judged by: the scratch walkthrough following only the guide works end to end; the audit is a complete list with a recommendation per entry; nothing is pushed or published.

## Frame (operator, 2026-10-01)

For anyone, on any project, with no special user configuration: agents discover the workflow when
they enter a project and the record fills from their work; a project may override defaults through
its own tracked config. bch-cloak is one existing project, not the design center. The operator's
Herdr focus must never move (lanes, tabs and panes are created with --no-focus).

## Boundaries

Work only in this lane's worktree and scratch. Never write bch-cloak, the shared `.lane.json`, the
releases, `~/.local/bin`, launchd, harness or Herdr user configuration, or panes you did not create.
Keep `contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is
bounded. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
