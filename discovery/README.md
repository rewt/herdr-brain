# Fleet and project conversations

The fleet maps canonical Git common-directory identities to project checkouts,
records, worktree roots and configuration layers. Reads never register a project.
Use the dependency-free command directly from the installed product:

```sh
node discovery/client.mjs fleet join
node discovery/client.mjs fleet show
node discovery/client.mjs fleet join --record /path/to/.org --worktrees /path/to/lanes --layer /path/to/.lane.json
node discovery/client.mjs chat PROJECT --kind codex --no-focus
```

`HERDR_MONITOR_FLEET` selects the directory containing `fleet.json`; the default is
`~/.herdr-monitor`. `join` is idempotent and supports an advisory `--session-limit`.
Existing shared records and parent configuration require explicit adoption.
Moved or re-cloned checkouts retain stale mappings for inspection; `join --replace
NAME --record PATH` repairs a stale mapping without deleting record data. Names
never prove ownership. Records cannot belong to two projects.

## Record and release resolution

Record selection and software selection are separate. `lib/store.mjs` exports
`findOrgDir({ cwd, env })`; its order is:

1. Explicit `ORG_DIR`, resolved to an absolute path, takes precedence and does not
   launch Git. Commands with `--org` generally select that argument before calling
   discovery; dispatch and settle also use `ORG_DIR` as their argument default.
   An explicit record path does not prove that the current checkout owns it.
2. With no explicit record, `lib/fleet.mjs` resolves the canonical Git common
   directory, including linked worktrees, and selects that identity's fleet record.
   A matching identity with a different canonical checkout is stale and refuses.
   Settings layers and worktree roots use the same project binding.
3. Without a registered project, legacy discovery remains available. With a fleet,
   local checkout records precede the canonical checkout's record, then an unclaimed
   ancestor record; an ancestor record or settings layer claimed by another fleet
   project cannot be inherited. Without a fleet, the nearest nested checkout
   `.org/events.jsonl` precedes the canonical checkout's `.org`, then discovery
   walks upward from the canonical checkout to a parent `.org`. Outside Git it
   walks upward from `cwd`. Discovery can therefore select a parent record for an
   unregistered repository; use an explicit path or join to establish its mapping.

The fleet is one JSON document, so it remains a shared failure dependency for
invalid JSON, an invalid version/projects/session-limit envelope, or ownership
fields that cannot be resolved safely. Explicit record reads (including
`record init PATH`) validate the entry selected by its canonical record path;
registered-project reads validate the entry selected by fresh Git identity.
Both inspect every entry's absolute identity, checkout and record paths to rule
out conflicting ownership. Only the selected entry's worktrees and layers are
validated. Malformed unrelated worktrees/layers cannot stop that local operation.
A malformed selected entry refuses, as do overlapping identity/checkout/record
claims (including symlink aliases). An entry missing usable ownership paths
refuses with `cannot isolate project NAME`; no name or basename is used to guess.
These scoped reads never repair, register, or rewrite the fleet. Unregistered
legacy discovery, `fleet show`, project-chat selection, and fleet writes still
require full validation of every project. Before this scoped lookup, even an
explicit `ORG_DIR` validated every unrelated project's settings.

Installed `org`/`record` and `lane` launchers follow
`~/.local/share/herdr-monitor/current` into an immutable `releases/TAG` directory
(`HERDR_MONITOR_HOME` and `HERDR_MONITOR_BIN` select installation destinations).
A direct `node /path/to/script.mjs` call runs that supplied source or release;
relative child CLI paths normally come from that same bundle. The fleet selects
records/settings/worktrees, not a release. Activation changes the shared `current`
pointer for projects using those launchers; per-project release pinning is separate
work. See [machine releases](../herdr/README.md).

## Record resolver inventory

The following is the runtime source inventory for
`rg -n 'findOrgDir|fleetPath|ORG_DIR' --glob '*.mjs'`, excluding tests and archived
`docs/` evidence. Paths grouped in a row are separate callers.

| Callers | Resolution or propagation |
| --- | --- |
| `lib/store.mjs`, `lib/fleet.mjs` | Implement record discovery, fleet-path selection, ownership validation and legacy layout discovery; fleet join passes its selected record to the record CLI. |
| `bin/org.mjs` | Discovers records for commands and lesson proposals; init selects its positional path, `ORG_DIR`, then `.org`. |
| `dispatch/dispatch.mjs`, `dispatch/metrics.mjs` | Explicit record or discovery; dispatch passes the selected path to child commands. |
| `housekeeping/housekeeping.mjs`, `housekeeping/command.mjs` | Explicit record or discovery from the current/canonical checkout; housekeeping binds child record commands. |
| `lib/retire-trigger.mjs`, `lib/retire-command.mjs`, `lib/retire-runtime.mjs` | Discover records when not already supplied and bind retirement child commands. |
| `promote/promote.mjs`, `promote/completion.mjs` | Explicit/job record or canonical-project discovery; completion independently checks the canonical record with inherited `ORG_DIR` cleared. |
| `sessions/observe.mjs`, `sessions/authorization.mjs`, `sessions/live.mjs`, `sessions/sessions.mjs` | Discover records from canonical project context for observation, authorization and launches. |
| `settle/settle.mjs` | Explicit `--org`/`ORG_DIR` or discovery; binds child commands. |
| `supervisor/context.mjs`, `supervisor/status.mjs`, `supervisor/prompt-supervisor.mjs` | Explicit record or discovery; prompt-supervisor also accepts an existing checkout-local record first. |
| `supervisor/reconcile.mjs` | Checks the supplied record against canonical discovery with inherited `ORG_DIR` cleared; binds completion commands. |
| `verify/verify.mjs`, `watch/watch.mjs` | Explicit record or discovery; verify also discovers the canonical record among protected paths. Watch binds record commands. |
| `supervisor/chats.mjs` | Fully validates the fleet, selects a project and binds its record in chat/worker launch environments. |
| `supervisor/supervisor.mjs`, `supervisor/entry.mjs`, `supervisor/autopilot.mjs`, `dispatch/record-worker.mjs`, `contrib/settle-watch.mjs`, `discovery/policy.mjs`, `board/brain.mjs` | Propagate an already selected record to commands, launches or generated policy; board reads through the selected project's CLI when available. |
| `brain/bin/brain.mjs` | Selects `--org` then `ORG_DIR` for a foreground digest; the record is read-only. |
| `lanes/validation.mjs` | Treats `ORG_DIR` as bookkeeping when computing validation identity; does not discover a record. |
| `acceptance/run.mjs`, `acceptance/environment.mjs`, `acceptance/worker.mjs`, `acceptance/record-shim.mjs` | Acceptance-only scratch fleet-path checks, explicit record propagation and pinned-record enforcement. |

`lanes/lane.mjs` and `lanes/routes.mjs` additionally call `projectFleet` for the
same project binding's settings and worktree roots. `discovery/client.mjs` exposes
fleet join/show and project chats. `board/board.mjs` selects project roots and uses
`board/brain.mjs` to read their queue-bound records; it does not call `findOrgDir`.

Project chats use one receipt-bound tab per canonical identity in a shared `chats`
workspace. `--workspace`, `--route`, `--to`, `--arg` and `--no-focus` select their
launch context. Existing receipts and operator prototypes are reused only when
checkout, pane and identity bindings agree. Uncertain startup retains its receipt
and tab, so reopening never repeats a launch.

The launcher starts the native harness with `herdr agent start NAME --kind KIND
--pane PANE --timeout STARTUP_MS -- POLICY_ARGS`. Claude receives `--append-system-prompt`; Codex receives
`-c developer_instructions=…`. The harness owns its permission and sandbox settings. Agent start runs with the
launcher environment overlaid by the resolved route and chat environment pairs.
The policy points the agent at the project instruction files and includes the
record command and active lessons.

Legacy `.lane.json` fields `chat`, `entry` and `always_args`, validation fields
`host_suites` and `tier_suites`, and fleet fields `temp` and `excluded_roots` remain
parseable and have no effects. Older chat receipts remain readable.
