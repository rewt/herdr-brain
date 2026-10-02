# Brief: ARCH-14, a thin MCP server over the record CLI

Org item **ARCH-14**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Agents on harnesses without a shell wrapper should still be able to read and write the record. Build
a thin MCP server outside the dependency-free core that exposes the record CLI: ready work, show,
add, ask, answer, start, check and ingest a report, and the snapshot as a resource. It calls the CLI
with argument arrays (like the console), never writes `events.jsonl` itself, never runs in the
background unless the harness starts it, and adds no dependency to the core (the server may have
its own, like `console/`). The operator is open to MCP and tied to no existing tool (HUM-18).

Judged by: an offline test driving the server over stdio for each tool and the resource; a scratch-project demo with a real MCP client if one is installed (say which); `npm test` green; the core's dependency-free check unchanged.

## Frame (operator, 2026-10-01)

For anyone, on any project, with no special user configuration: agents discover the workflow when
they enter a project and the record fills from their work; a project may override defaults through
its own tracked config. bch-cloak is one existing project, not the design center.

## Boundaries

Work only in this lane's worktree and scratch directories (scratch homes for any install test).
Never write bch-cloak, the shared `/Users/rewt/development/rewt/.lane.json`, the activated release,
`~/.local/bin`, launchd, harness user configuration, or Herdr panes you did not create. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded in
time. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
