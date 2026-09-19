# Design: Inventory local Herdr agents across repositories

## Discovery and coverage

Read the current endpoint and local `herdr session list --json`; probe only those
local endpoints, deduplicated by real socket path. The reported running flag is a
hint, not proof of reachability. Never attach or start a named session to inspect it,
guess socket paths, or contact SSH/remote sessions. List inaccessible endpoints in
coverage and errors. If enumeration is unavailable, use the current endpoint and
label coverage partial.

Explicit `--repo` works from any cwd, including outside Git. Resolve every discovered
repository's configuration independently. `LANE_CONFIG` applies only to the anchor
repository (`--repo`, otherwise the caller repository), never to unrelated roots. If
`LANE_CONFIG` is set without an anchor outside Git, refuse with guidance to supply
`--repo`.

For each accessible server snapshot, enumerate all agents, including null names.
Union snapshots' repository workspaces with the explicit/current repository. Use
`herdr worktree list --cwd <canonical-repo>` once per distinct repository on its
corresponding server to map open workspace IDs, and Git worktree metadata to verify
common-directory identity and checked-out branches. Herdr's
`WorkspaceWorktreeInfo` has no branch. Deduplicate repositories by Git common
directory while keeping server-qualified live session IDs distinct, and use
terminal/occupant identity to reject reused panes.

Join registry metadata only when repository, server, workspace, and agent identity
are unambiguous. Preserve every snapshot agent when metadata is absent, malformed,
ambiguous, or foreign. Unregistered rows use the actual cwd's verified repository or
unknown repository, live status and pane. Title may supply an explicitly labeled
goal; brief, role, report, and gate remain unknown unless independently verifiable.
Dispatch records optional agent-session and terminal IDs only when the same occupant
is seen around delivery. A live join requires the recorded agent-session ID, checks
the terminal ID when present, and requires the recorded lane to equal the verified
live branch. A switched or detached checkout and a same-name replacement remain
separate from historical metadata. Older records without immutable evidence still
load for display but never claim a current occupant. A terminal-title goal does not
become a brief excerpt. Status-only watch events retain their immediate status frame
and schedule the existing coalesced preview refresh.
Facilitators attach to canonical-checkout rows outside lane subgroups. Non-Git agents
remain visible under unknown identity/repository.

Repository records already retain canonical path, `root_id`, and `repo_id`. Add a
stable public-safe display identity suffix when readable root/repository labels
collide; labels remain presentation only.

No recursive filesystem inventory or OS-process promise is made. Offline historical
metadata is read only for repositories found in this run or explicitly selected. If
no server is accessible, an explicit/current repository still yields its offline
registry, Git, and report snapshot; without either, report unavailable coverage.

## Filtering and state

Group development-root identity, then canonical repository, then facilitator/lanes;
within a lane show each dispatch session. Default history filtering hides metadata-
done records when offline or idle. `--all` includes them. Herdr `done` means unseen
idle and never hides a live row by itself. A metadata-done row that is live working,
blocked, or unknown reappears with an active-after-done marker. Unregistered rows do
not receive manufactured metadata.

Keep row IDs stable across sort and filtering. Preserve the existing sampling
behavior from board-cli and board-messages. Bounded asynchronous sampling,
concurrency/rate limits, freshness, and cache behavior belong to board-sampling.

## Split boundary

This change owns the complete requirements Machine default with repository filter,
Every discovered agent remains visible, and History filtering is independent of
agent status. [`board-sampling`](../board-sampling/) owns Responsive bounded
observation and depends on this change. Dependants requiring complete
board-discovery wait for both.
