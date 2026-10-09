# Scoped chat control: terminal execution prerequisite

The requested tab checks can constrain direct wrapper calls, but do not establish
the requested read-only boundary elsewhere when the chat can run arbitrary text
or send arbitrary input to ordinary terminal shells in its tab.

## Counterexample

Assume the wrapper is perfect at caller ancestry, kernel start identity,
launcher-owned receipts, executable/socket pinning and current pane membership.
Let `chats:p2` be an ordinary shell in the caller's tab, and `project:p1` be a
pane in another workspace. This call targets only an allowed pane:

```text
herdr-scoped pane run chats:p2 '/absolute/native/herdr pane close project:p1'
```

Herdr runs the text in the destination terminal's shell. That shell has its own
OS permissions, outside the chat's native sandbox. It can access the raw control
socket under the user's identity unless separately confined. The same command
can be typed with `send-text` followed by `send-keys enter`; wrapping only `run`
commands in a sandbox therefore leaves the input route open. Clearing the
socket environment variable also leaves its known filesystem path accessible.
Closing/typing into another chat's tab follows the same path.

The offline probe models these documented terminal semantics with a pinned fake
Herdr executable and an actual `/bin/sh` child. It proves four counterexamples
(run and text/Enter, each into another workspace and another chat's tab) even
when direct foreign calls and the chat's own input/close are all refused. It
does **not** test a production scoped wrapper or mutate live Herdr panes:

```sh
node docs/reports/evidence/R-364/scoped-input-probe.mjs
```

## Evidence in this checkout and installed CLI

- `supervisor/chats.mjs` creates an ordinary tab/root pane, waits for its shell,
  and launches the chat in that pane. It does not confine sibling shells.
- `discovery/native-sandbox.mjs` applies the native sandbox to the launched
  Claude/Codex process. A command typed into a separate terminal does not become
  a child of that sandboxed process.
- Installed `herdr pane run --help` documents command text and Enter in the
  target pane; `pane send-text` and `pane send-keys` expose the equivalent route.
- Installed `herdr pane split --help` exposes target, direction, ratio, cwd, env,
  right-click and focus options, with no shell confinement setting.
- Bundled `herdr api schema --json` (protocol 20, schema version 1) exposes pane
  split/input operations; no sandbox, permission or authorization field was
  found. This is evidence about the exposed interface, not a claim to have
  audited Herdr's server implementation.

## Required boundary before implementation

All processes receiving arbitrary chat input must run under an independently
enforced OS boundary that denies direct Herdr control and protects the wrapper,
binding, launcher, interpreter and canonical Git/config. This must include the
terminal's root shell and its descendants, so interrupting a sandboxed command
cannot return to an unrestricted shell. New/split/preset panes must inherit the
boundary from creation, before accepting input. Existing panes must be verifiably
confined or refuse arbitrary run/input; the existing wallet-host process in the
motivating example needs an explicit migration or bounded stop operation.

A scoped socket broker could supply permitted Herdr control inside those
confined shells. A server guard alone is insufficient if the same processes can
still reach the user's unrestricted socket. Target membership and any process
confinement proof must also be validated atomically with mutation, or the server
must provide a documented guarantee against target moves between check and use.

The wrapper, committed mode, installer and native exclusion probe can follow
once this execution boundary exists. Enabling `scoped` now would advertise a
boundary the implementation cannot maintain. Production files are unchanged;
`scoped` remains rejected by the current config parser.
