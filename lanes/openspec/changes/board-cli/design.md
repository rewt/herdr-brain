# Design: Expose board read interfaces through lane CLI

## Commands and boundary

- `lane board --once [--repo <path>]`: dependency-free plain snapshot.
- `lane board --json [--repo <path>]`: one JSON snapshot, no Ink, one stdout document.
- `lane board --watch --json [--repo <path>]`: foreground newline-delimited JSON
  snapshots; no detached process or persistent observation cache.
- `lane board`: existing interactive entrypoint, left unchanged in this lane.

Reject contradictory modes, unknown flags, extra operands, and missing values
before effects. Help documents the interface; one-shot errors go to stderr.
This slice keeps the existing repository default scope. Machine default arrives in
board-discovery; retain the same interfaces and make scope explicit in JSON now.

JSON schema v1 has schema_version=1, captured_at (UTC), scope, coverage, repositories,
rows, host, and errors. Each row carries an opaque row_id, repo_id, root_id, server_id,
name (nullable), pane/tab/workspace IDs, registered, topic/branch/role, goal,
brief {path, excerpt}, status, done, git {head, ahead, behind, dirty, available},
gate {state, head, exit_code, signal}, report {path, mtime, verdict, reviewed_head},
deadline, overdue, last_message {text, source, observed_at, truncated, available},
tripwire, and stale. Unknowns are null/available=false, never green or clean.
Support optional fields being absent in v1; unknown fields are ignored by consumers.
Snapshot row IDs must survive sorting and refresh while the same session exists.
Repository records include repo_id, root_id, canonical path, root/repository labels,
and the resolved lane destination base, so the UI need not resolve paths itself.
Gate state is pass, fail, stale, or missing; the human display remains
exit=0 `@<head7>`, `exit=<n>` `@<head7>`, STALE, or -. Observation staleness is separate
from gate-head mismatch. A failed prepare step writes no new gate, matching current
check behavior; document this when updating the reference.

For this slice last_message retains the old value but labels it "pane-output";
board-messages replaces it. Do not claim the footer is a real assistant message.
A done marker never changes git or gate data. A report can have a verdict and full
reviewed_head (when supplied); absence of reviewed_head means freshness unknown.

Schema audit: v1 already provides `brief {path, excerpt}` and each repository's
canonical path plus resolved lane destination base. **Needs field (board-cli):**
recorded gate command, observation timestamp, and duration, bounded to nullable
read-only evidence metadata, before consumers claim a full gate record. Do not
derive these values through UI file, git, or process reads.

Move read-command parsing, canonical config resolution, and service orchestration
into lane.mjs, reusing the built-ins-only board services as modules/children.
Keep modules import-safe and preserve exports used by the current UI; do not copy
two independently maintained sampling implementations. board/app.mjs and its direct
I/O paths remain untouched. This is an independently usable scripting interface;
the UI process-boundary rewire and its import regression belong to board-actions
(2b-ii). A3 is approved/applied in that second lane, not this read-only slice.

## Lifetime and failure behavior

Use one observation process per watch invocation. Consumer pipe closure, SIGINT,
SIGTERM, and service errors close subscriptions, pending requests, timers, and
children. Preserve permanent client shutdown; a late refresh cannot revive it.
Reconnect only observations. Read interfaces never focus an agent or write session
metadata. Repository paths are passed as arguments, never interpolated as shell code.
Keep all existing UI/client framing and teardown regressions green without changing
the interactive application; add watch-lifetime regressions at the CLI boundary.
