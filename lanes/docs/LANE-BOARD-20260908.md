# Lane board implementation report — 2026-09-08

## What works

`lane board` spawns a small Ink 5 and React application from the separate `board/`
package using plain Node.js 20 and `React.createElement`. Registered sessions are
joined to live Herdr agents and workspaces, lane git
state, report files, deadlines, and output tripwires. Arrow keys or `j`/`k` select a
row; `a` presents the safe attach command, `d` marks it done through an atomic registry
rewrite, `r` refreshes, and `q` exits. Host and git/report state refresh on a five-second
tick; agent and output changes arrive through Herdr subscriptions. Interactive mode
refuses non-TTY input with a concise pointer to `lane board --once`.

`lane board --once` runs without Ink and prints the same fields as plain text. If the
socket is unavailable it still reports registry, git, report, deadline, and host state.
The board package has only two direct runtime dependencies: Ink and React. The main
CLI continues to use Node.js built-ins only.

Offline tests cover snapshot IDs, subscription handshakes, streamed status events,
reconnect/backoff, subscription construction, row joins, plain rendering, verdict
parsing, atomic done updates, and the `lane board --once` command. The socket client
uses an injected in-memory fake server in tests because the suite must not depend on
Herdr or filesystem socket permissions. Coverage includes split and batched socket
frames, timeouts, error bodies, close-before-reply, and permanent client shutdown.

## Verified Herdr protocol behavior

The installed Herdr 0.8.2 schema declares protocol 20. The socket path is supplied to
managed panes as `HERDR_SOCKET_PATH`. Requests and responses are newline-delimited JSON.
Each request carries a caller-chosen string `id`, and the one response repeats it.

The live probe confirmed that a socket handles one request. `ping` returns `pong` with
the server version and protocol; `session.snapshot` returns `session_snapshot` with
workspaces, panes, and registered agents. Long-lived observation therefore uses a
separate socket from one-shot snapshots.

An `events.subscribe` request contains a `subscriptions` array. Its initial response is
`subscription_started` with the request ID. Subsequent subscription messages on that
open connection have no request ID and use `{ "event", "data" }`. The board subscribes
per live registered pane to `pane.agent_status_changed`, to a generic
`pane.output_matched` matcher for the last output line, and to literal
`pane.output_matched` tripwires from the registry. Output-match events include the
matched line and a pane-read result. Closed or failed subscription sockets reconnect
with exponential backoff capped at five seconds; the next five-second snapshot adjusts
subscriptions when pane assignments change. Explicit client shutdown is permanent,
aborts pending requests, and prevents late refreshes from reopening a subscription
after the React view unmounts.

## Limits

- This is a pane-sized operator view, not a history store. Tripwire and last-output
  values are in memory and reset when the board restarts.
- Output subscriptions begin after the initial snapshot; they do not reconstruct old
  tripwire history.
- `--once` does not subscribe, so its tripwire and last-output columns remain `-`.
- `a` displays the explicit attach command instead of changing another client's focus.
- Worker counts classify process command lines and are intentionally approximate.
- Registry writes are local only. No command pushes, coordinates jobs, or changes the
  promotion contract. The registry path must be gitignored so it cannot block a clean
  promotion.
- Git dirtiness is read from the worktree registered to the lane branch in the target
  repository. If that branch has no locally registered worktree, its dirty state is not
  available; protocol-20 workspace metadata does not identify the checked-out branch.
