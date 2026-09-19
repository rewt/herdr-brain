# Design: Register dispatched sessions and retire closed lanes

## Storage and concurrency decision

Keep the existing registry key and legacy JSON array readable. New automation writes
one immutable JSON file per session at `<registry>.d/<session-id>.json` rather than
rewriting the shared array. For the default these are
.lane/sessions.json and .lane/sessions.json.d/. Completion is a separate atomic
`<session-id>.done.json` marker. A random UUID identifies a dispatch; legacy records
get deterministic IDs from canonical repo + workspace + name. Distinct dispatches
write distinct files; done is monotonic and repeated marks are harmless. This avoids
lost-update array rewrites without locks, leases, retries, or a database.
The board must read this format in this same lane, before any new UX lands.

Resolve registry relative to the canonical checkout, even during lane dispatch/close.
For automated writes require the array and sidecar directory to be untracked and
gitignored within that checkout, with symlink/escape protection. Existing external
registries can remain read-only board inputs; dispatch automation refuses them with
guidance to configure an ignored repository-local path. After Git close succeeds,
an external, unignored, or tracked registry produces a warning without changing the
successful exit status. Never edit .gitignore automatically.

Record fields: session_id, repo_id, root_id, repo (canonical checkout), topic, name,
workspace (opaque ID), pane, server (local endpoint identity), lane (full branch),
role (selected route name, else "agent"), brief (absolute local path or null),
goal (string), report (repository-relative convention), deadline (null by default),
done (false), created_at (UTC). No new role config key is needed.
Preserve legacy name/workspace/lane/role/report/deadline/done/tripwires on read.
Missing optional new fields in old records remain unknown; malformed records
produce localized errors rather than silently dropping all healthy sessions.

For @file dispatch, retain the resolved source path and use the first ATX Markdown
heading outside fenced code as goal, removing heading syntax. If absent use the
first nonempty prose line. An inline prompt uses its first nonempty line outside
fenced code, removing ATX syntax only when that line is itself a heading. Empty or
fence-only input uses the topic. Store at most 200 Unicode code points of goal; keep
full brief text only in its file. Report convention is `docs/reports/<topic>.md`,
resolved first in the lane checkout, then canonical checkout after promotion/close.
A missing report stays missing: dispatch does not fabricate a verdict or report.
The stable topic path does not drift when work crosses midnight. Preserve explicit
legacy report paths; do not rename historical reports. New report files identify
their topic and full measured/reviewed commit inside the content.
Do not append instructions to an explicitly supplied brief. The new composer will
put the convention into its generated brief.

## Lifecycle boundaries and partial failures

Preflight route, lane ownership, input readability, ignore status, and writable
registry directory before starting an agent. Preserve both shell and agent cwd
checks. A successful prompt (or successful ready agent for empty dispatch) is
followed by one atomic session record. Start once, wait boundedly for readiness,
and inspect ambiguous outcomes; never blindly repeat agent start or prompt.
No metadata record may assert a successful dispatch before these checks complete.

If prompting/start fails, report the exact known outcome; no success record. If
metadata persistence fails after the prompt was sent, report nonzero **partial
success**, live agent/pane and worktree IDs, and that the brief was already sent.
Never resend, kill a working agent to roll back, or imply that no work started.
Discovery will still show the unregistered live agent once that phase lands.

Mark sessions for the exact repo/topic done only after git close completes.
Failed dirty close or archive creation leaves metadata unfinished. A post-close
marker write error reports "lane closed; metadata update failed" without recreating
or deleting work. A registry policy refusal after successful Git close is warning-only.
Promoting alone does not mark done. Git-only close still works with no registry or
Herdr, and must not create empty registry state.
