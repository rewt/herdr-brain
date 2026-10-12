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
