# Design: Add board actions and move the UI onto CLI processes

## Commands and verified targets

- `lane board focus <row-id>`: refresh and verify the selected live occupant, then
  invoke `herdr agent focus` using the explicit pane/name and server.
- `lane board done <row-id>`: mark an existing registered session done through the
  registry adapter. Unregistered rows give a clear unsupported message.

Consume the v1 schema and stable row IDs from
[board-cli](../board-cli/design.md). An opaque ID is a reference, not authority:
verify its server, current terminal occupant, canonical repository, and metadata
target at action time. Stale, tampered, missing, or now-foreign IDs fail without
focusing another pane or writing files. Reject missing/extra action arguments.
No observation changes focus, and no action automatically retries.

## UI process boundary

Rewire board/app.mjs to acquire data from one foreground `lane board --watch --json`
child and invoke actions through its own installation's lane.mjs using argument
arrays. The UI no longer reads target-repository files, runs git, opens Herdr
sockets, or writes registry state. Keep the built-ins-only service implementation
shared with the CLI; remove obsolete UI control paths and duplicate refresh logic.
Preserve the existing layout, row navigation, refresh, quit, and status messages.
Map a and Enter to verified focus and d to the done action, with matching help.

Add an import/process-boundary regression that fails if a UI control path directly
uses git, Herdr, target-file reads, or metadata writes. Fake CLI observations and
action responses let tests verify the boundary without importing UI dependencies.

## Lifetime and error behavior

On q, EOF, SIGINT, SIGTERM, render errors, or unmount, close the observation child
and pending requests/timers. A late frame cannot create a new child or revive a
closed client. Handle split/batched JSON lines and child errors without corrupting
the UI; render stale-selection and offline errors inside the table. Reconnection
may restore only the read stream, never replay focus/done/start/prompt.

A3 is approved/applied here because this lane establishes the CLI-only UI contract.
The dependency-free read-only predecessor needs no amendment and leaves the UI
unchanged until this lane lands.
