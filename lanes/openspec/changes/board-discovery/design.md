# Design: Discover local Herdr agents across repositories

## Discovery and coverage

Read the current endpoint and local `herdr session list --json`; probe only those
local endpoints, deduplicated by real socket path. The reported running flag is a
hint, not proof of reachability. Never attach/start a named session to inspect it,
guess socket paths, or contact SSH/remote sessions. List inaccessible endpoints
in coverage/errors. If enumeration is unavailable, use the current endpoint and
label coverage partial. Explicit --repo works from any cwd, including outside git.
Resolve every discovered repository's config independently. LANE_CONFIG applies
only to the anchor repository (--repo, otherwise the caller's repository), never
to unrelated roots. If LANE_CONFIG is set without an anchor outside git, refuse
with guidance to supply --repo; do not broadcast one config across the machine.

For each accessible server snapshot, enumerate **all** agents, including null names.
Union snapshots' repository workspaces with explicit --repo/current repository.
Use `herdr worktree list --cwd <canonical-repo>` once per distinct repository
(on its corresponding server) to map open workspace IDs, and git worktree metadata
to verify common-directory identity and checked-out branches. Herdr's
WorkspaceWorktreeInfo has no branch; do not invent one in tests. Deduplicate a
repository seen on multiple servers by git common directory; keep server-qualified
live session IDs distinct. Use terminal/occupant identity to reject reused panes.

Join metadata only after repo+server+workspace+agent identity is unambiguous. Preserve
every snapshot agent if metadata is absent, malformed, ambiguous, or foreign.
Unregistered rows use their actual cwd's verified repository (or "unknown
repository"), live status and pane; goal is title if available, explicitly labeled
as such, else unknown. Brief/role/report/gate are unknown unless independently
verifiable. Facilitators remain attached to canonical checkout rows, outside the
lane subgroup. Non-git agents remain visible under unknown identity/repository.

Schema audit: repository records already retain canonical path, root_id and repo_id,
which are authoritative for destination selection; labels remain presentation only.
**Needs field (board-discovery):** a stable public-safe display identity suffix when
duplicate root/repository labels collide, so the composer can disambiguate choices
without treating a label as canonical identity or inspecting the filesystem itself.

No recursive filesystem inventory and no OS-process promise. Offline historic
metadata is read only for repositories found in this run or explicitly selected.
A repository absent from all accessible Herdr inventories is not silently scanned.
With no server, --repo or current repo still gives its registry/git/report snapshot;
without either, show no accessible servers and coverage unavailable, not success
with an unexplained empty view.

## Filtering, state, and performance

Group root identity > canonical repository > facilitator/lanes; within a lane show
each dispatch session. Default hides records done through registry/CLI when offline
or idle. --all includes them; the UI toggles this flag. Herdr's own "done" means
unseen idle, not lane completion, so it alone never hides a live row. A recorded-done
row that is live working/blocked/unknown reappears with "marked done; active".
Do not manufacture metadata for unregistered rows to hide them.

Keep stable row IDs across sort/filter/refresh. Collect git/report data once per
checkout each five-second tick, asynchronously with at most two child samples at
once and one in-flight refresh. Coalesce event refreshes (max four per second);
agent state events can update rows directly. Apply request timeouts and keep prior
observations visibly stale if a server fails. A git/read error shows unknown data,
never clean/zero ahead. Drop runtime caches when sessions disappear; do not retain
a persistent history cache.
Mark observations stale after two missed five-second ticks (10 seconds since the
last successful sample), or immediately on a known disconnect. A timeout and an
unchanged but successfully sampled working session are different: silence alone
never implies blocked, completed, or overdue. Overdue means an explicit valid
deadline is in the past; no deadline means no overdue inference.

Acceptance target: a sanitized fixture with 100 sessions in 10 repositories should
accept keyboard/CLI control within 100 ms while a git request is delayed; report
refresh wall time and process counts on the available machine, without hardcoding
host-speed limits into tests.

## Pre-agreed split point

Choose combined delivery or this exact split at dispatch, before implementation.
The split needs no new product decision. If the combined scope will exceed one
focused session, use these boundaries instead of broadening the lane:

| Subphase / topic | Scope and required acceptance | Depends on |
| --- | --- | --- |
| 2c-i / board-inventory | Local endpoint enumeration, canonical repo/agent joins, coverage, machine default, --repo/--all, grouping and done semantics. Own the complete requirements Machine default with repository filter, Every discovered agent remains visible, and History filtering is independent of agent status. Test inaccessible/duplicate endpoints, foreign metadata, unnamed/non-git agents and history controls. Preserve existing sampling behavior. | board-actions (2b-ii) |
| 2c-ii / board-sampling | Asynchronous per-checkout sampling, concurrency/rate limits, freshness/error handling and bounded caches. Own Responsive bounded observation. Verify delayed-git responsiveness, one in-flight refresh, two-child limit, no duplicate sampling and cleanup on the 100-session/10-repository fixture. | board-inventory (2c-i) |

When activated, partition complete requirement blocks into those two OpenSpec
changes and one dispatchable brief each before writing code. Include each slice's
report under `docs/reports/<topic>.md`, tests and post-commit check. Keep full
discovery completion pending until board-sampling promotes; dependants requiring
board-discovery wait for both. The first slice is usable discovery with existing
sampling; it does not claim the second slice's responsiveness/freshness guarantees.
