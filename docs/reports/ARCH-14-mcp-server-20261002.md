---
run: R-82
outcome: done
summary: |
  Added an optional foreground stdio MCP server over the record CLI, with ready work,
  show, add, ask, answer, start, report check and ingest, and a Markdown snapshot
  resource. The core and its dependency boundary are unchanged. Offline stdio tests
  and an installed official SDK client demonstrate the complete workflow in scratch
  projects, including a new Git project with no configuration.
headline: Agents can use the record through a foreground MCP server
blockers: []
proposals: []
learnings:
  - The CLI has no ready command; ready work is filtered from its status JSON while retaining CLI order and derived status.
  - Inline report ingestion retains an immutable CLI-owned copy but records a temporary source pathname; use the file input when the original source path must persist.
  - The CLI attributes report events to the reporting run, while ordinary MCP writes retain the configured agent actor.
  - Existing watcher fixtures are sensitive to temporary-directory execution overhead; they pass in an isolated private tmp directory.
artifacts:
  - "Commit subject: Add foreground MCP adapter over the record CLI"
  - "Commit subject: Report MCP adapter and offline client proof"
  - "Branch: lane/mcp-server"
  - mcp/server.mjs
  - mcp/cli.mjs
  - mcp/README.md
  - mcp/package.json
  - mcp/package-lock.json
  - mcp/test/server.test.mjs
  - mcp/demo.mjs
  - test/mcp.test.mjs
  - /private/tmp/arch14-mcp-tests.log
  - /private/tmp/arch14-demo.log
  - /private/tmp/arch14-serial-tests.log
  - .lane/gate.json
decisions:
  - text: Keep the MCP adapter in its own optional package and invoke the record CLI for every record operation.
    category: design
    why: The existing CLI owns discovery, validation, approval policy, locking, attribution and durability; the adapter needs no duplicate state model.
  - text: Accept full Markdown report text as well as project-relative report files.
    category: design
    why: An agent with only MCP access can finish a run without a shell or a separate filesystem tool; temporary staging still leaves validation and immutable storage to the CLI.
  - text: Use the official MCP SDK and Zod inside the optional module.
    category: tooling
    why: Established protocol framing, negotiation and schema validation keep the server small; isolated dependencies leave core installation and imports unchanged.
questions: []
challenges:
  - Initial default-concurrency npm test attempts reproduced existing watcher timeouts and a leftover fixture child before MCP changes could affect them. Validation uses the complete npm test suite with serial file execution and an isolated private tmp directory, with no tests omitted.
---

## Result

`node mcp/server.mjs` is a foreground stdio server owned by its launching harness.
The default cwd is the invoking project, and the CLI supplies canonical Git and
legacy record discovery. Optional launch arguments are `--cwd`, `--org` and
`--actor`; no harness user configuration is written. An absent/empty `ORG_ACTOR`
defaults to `record-mcp`, while an explicit actor is preserved.

The eight tools are `record_ready`, `record_show`, `record_add`, `record_ask`,
`record_answer`, `record_start`, `record_check` and `record_ingest`. The resource
is `record://snapshot`, freshly rendered as `text/markdown` on each read. Strict
schemas advertise the inputs. CLI stdout and diagnostics remain distinct MCP
content blocks; tool refusals return `isError`. Start records the run and returns
its full CLI-generated brief without launching an agent.

The adapter uses child processes and argument arrays, with `--` positional
delimiters and `--flag=value` options. It never imports the fold or store, never
appends events, and never adds stored status or a daemon. CLI calls have a
15-second bound, cancellation support and a 16 MiB output bound. Interrupted
writes explicitly tell the caller to inspect the record before retrying. The
adapter performs no automatic mutation retries. EOF and termination signals
cancel active CLI calls and close the server.

Check and ingest accept exactly one of `file` or inline `report` Markdown. Inline
content is staged in a private scratch directory and removed in `finally`; the
CLI alone stores the ingested report and creates events. Report idempotence and
the refusal of a second different report for a run remain the CLI's behavior.
Asking obeys the project's approval policy; `wait` keeps an otherwise automatic
question pending. Answers are attributed to the caller and require the caller's
authority, as with the CLI. Budget and alignment metadata stay advisory.

## Evidence

- `npm --prefix mcp test`: six offline tests pass, covering every tool and resource
  over raw JSON-RPC stdio, independently of the SDK client.
- `node --test test/mcp.test.mjs`: the same six cases pass through root test discovery.
- Complete `npm test` with serial file execution and private scratch TMPDIR:
  **471 passed, zero failed, four existing skips, 475 total**.
- A scratch-home `npm ci --offline --ignore-scripts` succeeds from the pinned
  lockfile and cached packages; installation touches only scratch paths.
- `npm --prefix mcp run demo`: installed **@modelcontextprotocol/sdk 1.31.0 Client
  + StdioClientTransport** completes ready, add goal/work, ask, answer, show, start,
  check and ingest in a brand-new scratch Git project, then reads and verifies the
  snapshot. The transcript confirms all eight tools and the resource are advertised.
  The demo removes its scratch project and writes no user configuration.
- The dependency-free boundary is unchanged: no changes to `bin/`, `lib/`, root
  `package.json` or `contrib/settle-watch.mjs`; root has no dependency declarations
  and core imports remain Node built-ins or relative modules.
- `git diff --check` passes. The module's own tests require its dependencies;
  root tests explicitly skip this optional integration when they are absent,
  preserving core-only offline validation.

The tests also prove literal leading dashes, quotes, shell syntax and newlines;
failed parent/route/report/schema inputs without partial writes; CLI approval
policy, declined blockers and overrules; report conflict refusal; file reports;
temporary cleanup; default and explicit actor attribution; signal and EOF exit;
and project discovery from a nested linked worktree. Handshake alone creates no
record; the first operation discovers and initializes the canonical record.

## Validation and handoff

The initial unmodified `npm test` run completed with 453 passes, 12 existing
watcher failures and four skips after its orphaned scratch watcher was stopped.
A bounded default-concurrency retry also stalled in the watcher suite. A separate
watcher run using `TMPDIR=/private/tmp/arch14-watch-validation` passes all 17 cases.
No watcher implementation or test was changed by this lane.

For complete validation, a scratch PATH wrapper injects only
`--test-concurrency=1` when `node --test` is invoked. All files from the unchanged
root npm test script remain included:

```sh
PATH=/private/tmp/arch14-test-bin:$PATH \
TMPDIR=/private/tmp/arch14-validation-home \
ORG_ACTOR=arch14-validation npm test
```

The lane is rebased onto current main before handoff. This report is checked
through `record check`, committed, and `lane check` runs last on the clean report
commit with that same complete validation command. Its committed-head receipt
is `.lane/gate.json`. No push, publication, activation, project-wide housekeeping
schedule, shared lane configuration or live pane mutation is part of this work.

Protocol implementation follows the official [MCP SDK server documentation](https://ts.sdk.modelcontextprotocol.io/server);
the adapter's launch instructions and exact tool mapping are in `mcp/README.md`.
