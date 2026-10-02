# Herdr Monitor

Herdr Monitor gives coding agents a durable record and isolated Git lanes, with a
console where you can see the work and steer it. A fresh session recovers tasks,
reports, decisions and priorities from the record instead of a long chat history.

Install the plugin once on the machine. Enter an existing Git project through a
fresh Codex or Claude shell session: Monitor supplies the workflow, creates a
worker lane and records the actual task as the agent works. There is no project
`init`, required instruction-file edit or required user configuration.

**Start with [the adoption guide](docs/ADOPTING.md).** It covers installation,
uninstall, project overrides, the agent cycle, the console and release rollback.
This repository is still a local development candidate; no public repository or
marketplace installation is promised. The [publication audit](docs/PUBLISHING-AUDIT.md)
lists the work required before any publication.

## What happens

- A worker gets its own checkout, the project's instructions, record context and
  bounded commands to commit, validate, integrate and report its work.
- A supervisor dispatches recorded work, receives a final watch notice, settles
  reports through independent review, and authorizes queued local promotion.
- Housekeeping handles finished worker tabs and interrupted sessions. Only the
  canonical project supervisor starts its schedule.
- The console shows tasks, sessions, questions, decisions, priorities, routes,
  housekeeping and recent activity. Your choices go through validating commands.

Coordination is deterministic. The dependency-free record core runs in the
foreground and never calls a model. Workers and reviews use your native harnesses;
routes and budgets remain visible, and exceeding an advisory budget does not
refuse work. Promotion requires clean trees, a clean rebase, green validation and
a local fast-forward. Background pane creation preserves Herdr focus.

## Requirements and limits

Node.js 20+, npm, Git 2.38+, Bash, a supported Herdr installation (the manifest
requires 0.8.0+) and native Codex are needed for the normal machine install.
Claude is optional. The scratch walkthrough was proved on macOS; native Codex is
the default validation provider. The Linux bubblewrap provider remains an
explicit scratch-only experiment. Absolute harness paths, desktop/remote
sessions and custom shells need their own entry transport; see the guide.

## References

| Module | Reference |
| --- | --- |
| Record | `node bin/org.mjs help` (`org` is the permanent `record` alias); [MCP adapter](mcp/README.md) |
| Entry and project settings | [Discovery](discovery/README.md) |
| Machine installation | [Herdr](herdr/README.md) |
| Lanes and routes | [Lanes](lanes/README.md) |
| Dispatch / watch | [Dispatch](dispatch/README.md), [Watch](watch/README.md) |
| Review and integration | [Settle](settle/README.md), [Promote](promote/README.md) |
| Supervisor / housekeeping | [Supervisor](supervisor/README.md), [Housekeeping](housekeeping/README.md) |
| Console | [Modern console](console/modern/README.md) |
| Release validation | [Acceptance](acceptance/README.md) |
| Intent | [North star](docs/north-star.md), [Roadmap](docs/roadmap.md) |

## Development

Run `ORG_ACTOR=developer npm test` before and after changes. Tests are bounded,
offline and make no model calls. `npm run test:lanes` covers the separate lane
suite; Herdr-only checks explicitly skip when Herdr is absent. Console and MCP
have pinned dependencies; the core, lanes and cycle modules have none.

Develop in an isolated lane. Projects use immutable releases: merging development
code does not activate it. See [AGENTS.md](AGENTS.md) for repository boundaries,
including the legacy watcher that an existing pilot still calls.
