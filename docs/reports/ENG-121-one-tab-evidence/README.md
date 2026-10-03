# Herdr 0.8.2 blocks background tab selection

The lane change is blocked on a Herdr capability. No product behavior was changed.
Selecting a new agent tab in an existing workspace requires an operation that
changes that workspace's active tab without changing global focus. Herdr 0.8.2
provides no such operation in its CLI or advertised socket protocol.

## Captured behavior

The dependency-free [probe](probe.mjs) starts its own server with a private home,
config and socket. It disables update checks, uses `/bin/sh`, creates a scratch
Git repository and linked worktree, and never starts an agent or model. The
operator server is never contacted. The private server exits cleanly with code 0.

Run it from this checkout:

```sh
node docs/reports/ENG-121-one-tab-evidence/probe.mjs
```

It explicitly prints `SKIP` when Herdr is absent. It is an evidence reproduction
script, not part of the offline test suites or the release acceptance harness.
Its assertions describe the observed 0.8.2 limitation; rerun after a Herdr change
to determine whether the blocker still applies.

[observations.json](observations.json) records the actual installed binary:

| Operation | Lane active tab | Global workspace/tab/pane |
| --- | --- | --- |
| `worktree open --no-focus`, then `tab create --no-focus` | initial `w2:t1` | `w1` / `w1:t1` / `w1:p1` |
| socket `tab.move`, agent tab to index 0 | initial `w2:t1` | `w1` / `w1:t1` / `w1:p1` |
| socket `tab.focus` with extra `focus: false` | agent `w2:t2` | `w2` / `w2:t2` / `w2:p2` |

The last experiment runs solely against the private scratch server. An extra
`focus: false` field is ignored; it does not turn `tab.focus` into a safe selector.

## CLI and socket contract

Discovery commands executed: `herdr --version`, `herdr --help`, `herdr --skill`,
`herdr worktree --help`, `herdr tab --help`, `herdr worktree open --help`,
`herdr tab create --help`, `herdr tab focus --help`, `herdr api schema --json`.

The relevant request definitions are copied from that bundled schema into
[api-params.json](api-params.json):

- `tab.create` has `focus` (default false), cwd, env and label; no independent selection flag.
- `tab.focus` accepts only a `TabTarget` containing `tab_id`.
- `tab.move` accepts `tab_id` and `insert_index`, and preserves the active tab ID.
- The request method list contains no `tab.select` or workspace active-tab setter.
- `worktree.open` creates the initial shell without an env parameter.
- `agent.start` accepts pane, name, kind, args and timeout, without an env parameter.

## Why the alternatives do not fulfill the complete ask

Focusing the agent and then restoring focus moves focus twice. A snapshot and
restore also races with the operator; it fails the requirement that focus never
moves during dispatch.

Closing the initial shell based only on its current foreground process, cwd or
label does not establish that the operator never used it. An operator can run a
command and return to an idle prompt. `lane open` and `lane dispatch` are separate
CLI invocations, and `open` already exposes that shell before dispatch begins.
Closing other tabs to make the agent the only selection would delete operator
or prior-agent work. Reordering tabs does not select them.

Reusing a new initial shell can address the fresh-workspace subset, but cannot
select a *new* tab on a reused lane or fix round. It also needs a deliberate
solution for configured route env and `MONITOR_ENTRY_BYPASS=1`: current dispatch
sets those at tab creation, while worktree opening and agent starting lack env
parameters. That subset should not be reported as completing this ask.

## Required unblocking capability

Add an atomic Herdr operation to select a tab in a background workspace while
preserving the global workspace/tab/pane tuple, for example `tab.create` with
independent `select: true, focus: false`, or a background-only `tab.select`.
The server must decide atomically what to do if the operator has focused that
workspace; a client-side check followed by a mutation cannot enforce the focus
contract. Preserve all existing tabs and terminals.

Then complete the lane implementation with a safe initial-shell strategy:
reuse a dispatch-owned fresh initial pane with launch env support, or an atomic
server check that a dispatch-owned default tab has never received operator input
before replacing it. Exercise fresh dispatch, lane reuse, fix rounds, operator
activity, failures and focus races. Keep the core dependency-free and live
Herdr checks explicitly skippable when the binary is absent.
