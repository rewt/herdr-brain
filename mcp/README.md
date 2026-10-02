# Record MCP adapter

An optional foreground stdio server for agents whose harness can call MCP tools.
It invokes `bin/org.mjs` with argument arrays for every record operation, using
the CLI's discovery, policies, validation, locks and views. It never imports the
fold/store, appends events, launches a worker/model, schedules work or installs a
service. MCP SDK and Zod dependencies live only here; the core needs no install.

## Install and launch

Node 20+:

```sh
npm --prefix /path/to/herdr-brain/mcp ci
cd /path/to/your/project
node /path/to/herdr-brain/mcp/server.mjs
```

The harness starts and owns the process. Default cwd is the invoking project.
The CLI finds `ORG_DIR`, a canonical Git project's `.org/` (also from a linked
worktree), or a legacy ancestor record. A fresh Git project initializes its
record on the first record operation, with no user config. Outside Git, initialize
a record with `record init` or select an existing one with `--org`/`ORG_DIR`.
Startup and tool discovery alone do not initialize a record.

Launch arguments: `--cwd PROJECT`, `--org RECORD_DIR`, `--actor NAME`. Relative
`--org` paths resolve from the selected project. CLI file paths and route discovery
use that same cwd. `ORG_ACTOR` is inherited; absent/empty defaults to `record-mcp`.
Use a session name via `--actor` or `ORG_ACTOR`; this adapter does not impersonate
the operator. An answer is a CLI operation attributed to that caller, so expose it
only to callers authorized to answer. CLI approval policy still governs `ask`.

A host that supports stdio server definitions can launch, for example:

```json
{
  "command": "node",
  "args": ["/path/to/herdr-brain/mcp/server.mjs", "--cwd", "/path/to/project"],
  "env": { "ORG_ACTOR": "my-agent-session" }
}
```

This is a launch definition, not an installer; adapt its envelope to the host.
No harness config is read or written by this module. EOF, SIGINT and SIGTERM close
the process and cancel active CLI calls. stdout contains MCP messages only.

## Interface

Every tool advertises a strict JSON schema. Text is literal, including leading
dashes, shell syntax and newlines; no shell interprets client input. Optional
arguments map to their corresponding CLI flags; underscores map to hyphens.
Clients may omit the `arguments` member for `record_ready`, which is equivalent
to an empty object. Its optional `role` filter and strict schema still apply.

| Tool | Required input | CLI behavior |
| --- | --- | --- |
| `record_ready` | none (optional `role`) | `status --json`, filtered to ready work excluding goals/human questions, preserving CLI order; structured JSON contains `org`, `events`, `as_of`, `items` |
| `record_show` | `id` | `show`, optional `json` |
| `record_add` | `title` | `add`; supports `goal`, `role`, `capability`, `parent`, `blocked_by`, `accept`, `priority`, `budget`, `meta` |
| `record_ask` | `question`, `parent`, `category`, `recommend`, `why` | `ask`; supports `wait`, `on_yes`, `on_no`, `memo`, `blocks`, `priority` |
| `record_answer` | `id`, `answer` | `answer`; supports `note`, `overrule`; a no answer keeps dependents blocked |
| `record_start` | `id` | `start`, then `brief`; supports `route`, `route_config`, `harness`, `model`, `effort`, `workspace`, `report`, `escalation`, `serves`, `meta`; records the run and returns its full brief without launching it |
| `record_check` | exactly one of `file`, `report` | `check`; validates without ingesting |
| `record_ingest` | exactly one of `file`, `report` | `ingest`; optional `run` hint; identical content is idempotent, different content for the same run is refused |

`blocked_by`, `accept` and `blocks` are arrays. `budget` and `meta` are objects
converted to repeated `key=value` flags. `report` on check/ingest is full Markdown
with YAML front matter (including `run`, `outcome`, `summary`), not a pathname.
`report` on start is the pathname for that run's report, as in the CLI.

Inline reports are staged in a private temporary directory and removed in
`finally`; the CLI keeps the immutable ingested report in its own record. Its
recorded source pathname is temporary. Use `file` if a persistent source path
matters. Relative files resolve from the project cwd. This is a local stdio
adapter with the launching account's filesystem access, not a remote file API.

Resource `record://snapshot` has MIME type `text/markdown` and runs `record
snapshot` on each read. No cached or stored status and no resource subscription.
Server instructions explain the ready → show → start → check → ingest workflow.

Successful tools return CLI stdout as text and stderr as a separate diagnostics
block. `record_ready` also returns structured JSON. CLI refusals and schema errors
return MCP tool errors (`isError`); protocol/resource errors use MCP errors. Each
CLI call has a 15-second bound and a 16 MiB output bound. Cancellation, timeout or
lost transport can interrupt after an event committed: inspect the record before
retrying a write. The adapter never automatically retries mutations. Budgets and
alignment stay advisory.

## Offline verification and real-client demo

```sh
npm --prefix mcp test
npm --prefix mcp run demo
npm test
```

The tests drive real server processes over raw JSON-RPC stdio, independently of
the SDK client. They cover every tool and the resource, report idempotence/conflict,
approval policy and attribution, literal arguments, CLI refusals, canonical Git
discovery, file reports, cleanup, timeout and EOF/signal shutdown. Every test uses
its own scratch project/home, explicit actor and time bounds. No model or network.

The demo uses the installed official SDK `Client` and `StdioClientTransport` to
complete the same workflow in a new Git project without configuration; it prints
a transcript and removes the scratch project. Root `npm test` includes these tests
when this module is installed, or explicitly skips them when it is absent, so
core validation still works without optional dependencies. To validate the MCP
module itself, install it and run its mandatory test command above.

Protocol handling uses the pinned official [MCP TypeScript SDK v1](https://ts.sdk.modelcontextprotocol.io/server)
and its [stdio client](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).
The lockfile pins transitive dependencies. HTTP, background services and MCP Tasks
are outside this synchronous CLI adapter.
