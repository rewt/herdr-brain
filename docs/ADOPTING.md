# Adopting Herdr Monitor

Install once on the machine; entering a project is the setup. Monitor uses the
project's canonical Git common directory as its identity, so similarly named
projects and linked worktrees cannot be mistaken for each other. Your project
needs an initial commit and a known integration branch. It also needs a real
validation command before completed work can integrate.

The distribution is currently a local candidate. Publication, marketplace
availability, an approved publisher identity and the root license are still
pending; see [the publication audit](PUBLISHING-AUDIT.md). Use an inspected local
checkout and tag supplied by your operator. Do not guess a GitHub installation
URL. The commands below do not push or publish.

## Install on a machine

The operator or supervisor owns installation. Requirements: Node.js 20+, npm,
Git 2.38+, Bash, Herdr 0.8.0+ (the native UI proof used 0.8.2), and an installed
native Codex executable. Claude is optional. Codex must support the native
`sandbox --permission-profile` interface used for validation. The default install
requires Codex even when you plan to use Claude workers. Configure and authenticate
your native harness normally before adopting; Monitor does not replace its
account, permissions, model, effort or user settings.

Use an inspected tag from the local Monitor checkout. Substitute your actual
checkout and tag in these commands:

```sh
cd /path/to/herdr-monitor
bash herdr/release.sh build TAG
bash herdr/release.sh activate TAG
bash herdr/release.sh status
```

Build archives the tag, installs console and MCP dependencies with pinned
`npm ci`, then makes the release read-only. It does not install entry. Activate
installs entry from the final release, creates `record`, `org` and `lane`
launchers, switches `current`, and links the plugin. If an existing Brain
LaunchAgent is present, activation moves and reloads it; it creates no new one.
No project scheduler starts during installation.

Defaults are `$HOME/.local/share/herdr-monitor` for machine state/releases,
`$HOME/.local/bin` for record/org/lane, and
`$HOME/.local/share/herdr-monitor/entry/bin` for entry adapters. They are separate
directories. Fresh zsh/Bash shells receive removable PATH snippets in `.zshenv`,
`.zshrc`, `.bashrc` and the first existing Bash login file (or a new
`.bash_profile`). Open a fresh pane after activation. The snippet installs entry
adapters on PATH; if your shell does not already include `$HOME/.local/bin`, use
`node /path/to/release/bin/org.mjs` and `node /path/to/release/lanes/lane.mjs`
for record/lane commands, or add that launcher directory yourself.

Confirm the fresh shell's `command -v codex` points into the entry directory and
`command -v monitor-codex` exists. `codex --help`/`--version` still reach native
Codex. A later PATH reset, shell alias or function can bypass the adapter.

Optional machine destinations/native executable overrides are
`HERDR_MONITOR_HOME`, `HERDR_MONITOR_BIN`, `HERDR_MONITOR_ENTRY_BIN`,
`HERDR_MONITOR_CODEX` and `HERDR_MONITOR_CLAUDE` (`-` skips Claude). Keep these
consistent during build, activate, rollback and removal; do not put machine
paths or account data in tracked project routes. [Installation details](../herdr/README.md)
cover ownership checks, interruption recovery and native executable receipts.

For a future published GitHub plugin, Herdr's `plugin install` runs the manifest
build automatically, installs pinned dependencies and snapshots entry to a stable
machine runtime before relocating its temporary checkout. It is that build which
makes installation the setup. `herdr plugin link /path` skips builds: for a local
non-release checkout first run `bash herdr/install.sh`, then link it. A local
mutable checkout is for development; normal projects should use a release.

## Enter any project

From its canonical checkout on the integration branch, launch fresh interactive
`codex` (or `claude`) in a zsh/Bash pane. Supply the work you actually want done.
You do not need `.org`, `.lane.json`, `AGENTS.md`, `CLAUDE.md` or a parent workflow
configuration beforehand. Existing project instructions remain authoritative.

Monitor initializes `.org/` exclusively under a lock, ignores runtime state via
local Git `info/exclude`, creates a worker worktree, and injects:

- Canonical checkout, shared record, assigned branch/worktree, role and settings.
- The actual session's bounded command prefix (called `monitor` below), task
  start/resume, report location and completion procedure.
- Root project instructions, any `entry.policy`, and pointers to deeper context.
- A single pending routing question when routes have not been chosen.

The worker first runs `monitor start 'actual task'` and reads the returned brief;
`monitor resume ITEM` continues existing recorded work with a fresh run. `monitor`
is shorthand for the exact `node .../discovery/client.mjs` command in the injected
policy, **not another installed shell executable**. Its request queue exists only
for this session. Do not run the client after the adapter exits.

The worker edits its checkout, writes a report at the returned path, checks its
format with the supplied record CLI, and runs:

```text
monitor commit 'Describe the change'
monitor check
monitor promote
monitor finish
```

Check and promotion use the actual project tests inside a native filesystem
sandbox, protect Git metadata and shared record/state, and deny validation
network access. Unknown checks require your real `validate` override. For a
blocked/needs-human outcome, commit the report and finish without promotion. A
done report cannot finish before integration. If main moves or a rebase conflicts,
inspect and use `monitor rebase`, resolve in this checkout, `monitor continue`,
then check/promote again; `monitor abort` restores the pre-rebase lane. Git-only
promotion never pushes or creates merge commits.

This direct entry path is a worker completion workflow. Project instructions may
require a supervisor review desk before integration; dispatched work follows the
separate reviewed cycle below. Entry does not invent a review receipt.

Interrupted work remains recoverable: recorded, dirty, ignored-file or committed
lanes survive. An unused untouched lane can be removed at adapter exit or stale
entry recovery, after its ownership and liveness checks. Session display metadata
never authorizes that removal or any scheduling/promotion action.

Routes are suggestions until the operator answers. The installed preset proposes
Codex `gpt-6.1-sol` high for engineering and Claude `opus` high for independent
review. Agents must not answer for you. After an actual answer, a worker can run
`monitor apply-routes`, commit, validate and integrate the exact approved config.
A no leaves it unapplied; a text answer must be complete route JSON. Task work can
proceed while that advisory preference question waits.

Automatic entry covers fresh interactive PATH launches and fresh native Herdr
agent starts. Batch/print, resume, utilities, existing linked worktrees and
Monitor-assigned dispatches pass through. `monitor-codex -- exec ...` and
`monitor-claude -- --print ...` explicitly opt batch work in. Non-Git folders,
empty repos or the wrong integration branch warn and pass through automatically;
explicit entry fails on invalid project settings. Absolute native binary paths,
desktop/remote sessions, custom shells and later PATH overrides need their own
supported transport. Install entry on a remote host for sessions running there.
Linux uses native Codex validation; the bubblewrap alternative is experimental,
disabled by default, and documented for scratch only in [Discovery](../discovery/README.md).

## Project overrides

Defaults work without config. Commit overrides when the project needs them.
The generated record is locally ignored; to share only its policy deliberately,
use `git add -f .org/config.json`, keeping events, reports and runtime receipts
private. Track `.lane.json` and `.housekeeping.json` normally when present.
Never edit `events.jsonl` directly; status is derived from events. Keep records,
account data, runtime evidence and tokens out of a public release.

| File | Purpose and precedence |
| --- | --- |
| Canonical `.lane.json` | Integration branch (`main`), actual `validate`, `prepare`, lane paths, routes, selection policy and settle settings. Nearest parent config supplies defaults; project fields override them as the module guides describe. `lane config` shows sources. |
| `.lane.json` → `entry` | Only the canonical project's file controls entry; parent config, `LANE_CONFIG` and a linked lane's edits cannot change entry. `enabled` defaults true, `mode` defaults worker, `policy` defaults empty. |
| Discovered `.org/config.json` | Advisory budgets, stale-run threshold and approval policy. Default categories wait for the operator. Selectively set `auto` only within your project's authority; `record ask --wait` still waits. Item budgets inherit and can override defaults. |
| Canonical `.housekeeping.json` | `enabled`, `resume`, `tick_seconds`, `cleanup_seconds`; defaults true, true, 60, 600. The schedule reads edits on its next tick. |
| Canonical `.promote.json` | Optional queue delivery target/retry settings and gate override. See [Promote](../promote/README.md). |

A project using another branch or another test command can begin with:

```json
{
  "main": "trunk",
  "validate": "make test",
  "entry": { "enabled": true, "mode": "worker", "policy": "Read CONTRIBUTING.md before edits." },
  "settle": { "review_route": "review-codex", "review_round_cap": 3 }
}
```

Change `main` to the branch actually checked out in the canonical repository;
Monitor never switches it. `entry.enabled=false` declines entry, including explicit
`monitor-*` launches, without creating runtime state. `entry.mode=main` works in
the integration checkout with the worker role: commit/check/finish, no lane
promotion and no supervisor capability. That mode requires coordination of
concurrent edits and keeps the record protected through the bounded parent.

Example record policy (merge into the discovered config; leave other fields):

```json
{
  "budget": { "max_runs": 3, "max_children": 4, "max_depth": 3, "escalation_budget": 1 },
  "stale_run_hours": 24,
  "approvals": { "default": "ask", "categories": { "design": "auto", "tooling": "auto" } }
}
```

Existing category defaults are merged, so unspecified categories still ask.
An agent uses `record ask` for substantive decisions and records structured
`decisions`, `questions` and `challenges` in reports; category is determined by
the action being authorized. Operator priorities are separate durable ranked
outcomes: agents propose changes with `record priorities propose`, never rank
on the operator's behalf. Budgets and Unaligned work are advisory.

The record CLI honors explicit `ORG_DIR`, then discovers a local/canonical or
ancestor record. Fresh entry does not let inherited `ORG_DIR` silently redirect a
new session. Deliberately shared ancestor records and nested records are supported;
use the injected record path to avoid ambiguity. A sandboxed manual run may place
its report in its workspace with `record start ITEM --report PATH`.

## Supervisor and the reviewed cycle

Herdr must be running for live dispatch, watch, housekeeping and session views.
Open the plugin's supervisor pane from the project workspace, preserving focus:

```sh
herdr plugin pane open --plugin rewt.herdr-monitor --entrypoint supervisor --no-focus
```

Or from the canonical checkout, use `monitor-codex --role supervisor --` (or
`monitor-claude --role supervisor --`). Supervisor role is explicit; a fresh native
Herdr agent start is a worker. Installed supervisor policy supplies the generic
protocol and a compact read-only cold start. Only that canonical supervisor starts
`node /path/to/release/housekeeping/housekeeping.mjs --start`. Repeated starts reuse
the schedule. Workers never start it. Installation itself starts no loop.

The supervisor reads record priorities and standing authority, checkpoints new
decisions after reading their full content, and coordinates this sequence:

1. **Dispatch:** `node /path/to/release/dispatch/dispatch.mjs ITEM --lane TOPIC
   --route engineer --brief /absolute/ask.md --report docs/reports/TOPIC.md
   --to supervisor-project`. It creates/reuses a lane, prepares it, records the
   run and verified worker, arms watch, then sends work. `--to` must name the
   actual registered supervisor; the default `supervisor-herdr` is not a promise
   that an arbitrary project has that agent name.
2. **Watch:** waits without inference for the worker's final state and validates
   its report. It delivers a final `[org-report]` notice, never ingests. A report
   file appearing while work runs is not a final notice.
3. **Settle:** the canonical supervisor runs
   `node /path/to/release/supervisor/supervisor.mjs handle --notice 'COMPLETE NOTICE'
   --role supervisor --to supervisor-project`. Settle checks pinned Git/report
   evidence, ingests through record, requests independent review, and dispatches
   a watched correction when needed. Blocked, failed, needs-human, uncertain or
   conflicting work returns a substantive handoff. A review-round cap may return
   `promotable_with_findings`; the supervisor decides whether to fix or accept.
4. **Promote:** after reviewing readiness and project authority,
   `node /path/to/release/supervisor/supervisor.mjs promote RUN --why 'Reason'
   --to supervisor-project --role supervisor` queues the exact reviewed head/run.
   The finite FIFO worker checks cleanliness/rebase/validation and fast-forwards
   locally, then performs scoped finished-tab cleanup and guarded lane closure.
5. **Complete:** the supervisor handles the queue's final notice. Receipt and
   integrated tip checks guard `record close --if-current-run RUN`. Duplicate or
   stale notices do not authorize another integration or overwrite newer work.

Lane tab/workspace/pane creation uses `--no-focus`. Explicit operator navigation
in the console can focus a selected session. Session metadata is display-only.
No worker calls supervisor cycle mutations, no core command starts inference,
and the queue exits when drained. The supervisor chat can be cleared: record
history, briefs and mechanical receipts preserve continuity.

For recovery, use the printed dispatch/settle/queue receipts and the respective
[module references](../README.md#references). Do not blindly resend a prompt,
start another uncertain review or remove a live lock. The canonical
`.lane/supervisor/STOP` refuses cycle mutations; it does not terminate workers
already running. Clearing it permits explicit retry of retained evidence.

Housekeeping can be paused with the console or `record housekeeping pause`.
It closes only identity-verified finished worker tabs, leaves operator chats and
unrecognized panes, and recovers interruptions through guarded requests. For a
read-only preview, including from a lane:

```sh
ORG_ACTOR=housekeeping-preview node /path/to/release/housekeeping/housekeeping.mjs \
  --once --dry-run --state-dir "$PWD/.lane/housekeeping-preview"
```

## Observe and steer with the console

```sh
herdr plugin pane open --plugin rewt.herdr-monitor --entrypoint console --no-focus
# Standalone, from the project:
node /path/to/release/bin/org.mjs console --modern --folder "$PWD"
```

The plugin opens the modern console. It discovers the calling workspace's project
or accepts a folder; no console catalog edit or record initialization is required
to inspect a project. `record console` without `--modern` opens the older interface
which requires a catalog; it is not the new-adopter default.

`g`/`t`/`a`/`s`/`!` open Goals/Tasks/Activity/Sessions/Waiting on you;
`c`/`d`/`f`/`u`/`P`/`H` open Control/Decided/Asked/Routes/Priorities/Housekeeping.
Enter opens evidence; Esc goes back. Route and housekeeping edits, question
answers and priority changes show a draft/review before saving through record
commands. Route and housekeeping overrides become project files to commit;
saving housekeeping config does not start a stopped schedule. `i` types into a
selected session; Ctrl+] returns control to the console. `o` explicitly opens
the native terminal. `q` exits. [Console reference](../console/modern/README.md)
has the complete key map and limitations.

For a bounded read-only screenshot/frame:

```sh
node /path/to/release/console/app.mjs --modern --folder "$PWD" --print 100x34
```

The older optional Brain capture/digest service is separate from the project
cycle; it can call models and has legacy machine integration. New adoption does
not need to install it or edit launchd. MCP is an optional foreground stdio
adapter, using the record CLI for writes; see [MCP](../mcp/README.md).

## Upgrade, rollback and uninstall

Build a different inspected tag and run the release acceptance gate before
activating it. The [acceptance guide](../acceptance/README.md) explains prerequisites,
real-session costs and PENDING versus FAIL. Its local runner can touch only owned
scratch resources; a green offline suite alone is not a ready release. Activation
is a machine change separate from merging development code. Existing sessions
and housekeeping processes retain their own lifetime and loaded release code;
the supervisor plans the handoff at a quiet point rather than assuming a pointer
change restarts every process.

```sh
bash /path/to/monitor/herdr/release.sh build NEW_TAG
bash /path/to/monitor/herdr/release.sh activate NEW_TAG
bash /path/to/monitor/herdr/release.sh rollback
bash /path/to/monitor/herdr/release.sh restore
```

Rollback selects `previous`, reinstalls that release's entry and re-links the
plugin. It requires a previous activation. Rolling back to a pre-discovery release
removes entry. Restore returns managed launchers and any pre-existing Brain
service to their saved pre-activation state, removes unchanged entry adapters and
PATH snippets, and unlinks the release plugin. It keeps immutable releases and
project records. It does not stop existing agents or project schedules. Pause
housekeeping and let the supervisor manage running sessions before uninstalling.
Do not delete `.org` to uninstall the machine plugin.

For a GitHub-plugin build or manual `herdr/install.sh` installation, invoke its
**restore-entry** action, or run:

```sh
node /path/to/installed-plugin/herdr/entry-install.mjs --remove
herdr plugin uninstall rewt.herdr-monitor
```

For a local link, use `herdr plugin unlink rewt.herdr-monitor` after restoration.
Herdr has no manifest uninstall callback; unregistering alone leaves the shell
snippets/adapters. Removal refuses edited managed snippets, adapters and symlinked
shell files before overwriting them. Resolve the printed ownership conflict,
then retry. An interrupted transaction is recovered by
`node /path/to/monitor/herdr/entry-install.mjs --recover` or the next install/remove;
an old-format pending journal needs its original installer first. See
[the machine guide](../herdr/README.md) for detailed recovery.

## Prove the guide in scratch

The reproducible [scratch walkthrough](adoption/WALKTHROUGH.md) supplies only this
guide's commands, a new unrelated project, a fresh home and a scripted coding
worker. It runs actual install/build/activation, shell discovery, record start,
commit, native sandboxed validation, local fast-forward, report ingestion,
console rendering, supervisor cold start, dry-run housekeeping with a scripted
empty Herdr topology, upgrade,
rollback and restoration. It uses no model, credentials, live panes or launchd;
its scripted worker proves mechanics rather than model judgment.

From a Monitor checkout with the supported native Codex executable available:

```sh
ORG_ACTOR=adoption-rehearsal node docs/adoption/rehearse.mjs \
  --native-codex /absolute/path/to/native/codex
```

Each subprocess is bounded and evidence is retained in scratch. The final JSON
names the clean integrated commit and confirms restored shell bytes. Native UI,
actual Herdr install/build/move and supervisor-pane transport can be proved
separately on macOS from an authorized Herdr pane, with no prompt or inference:

```sh
ORG_ACTOR=adoption-native-canary node acceptance/plugin-entry.mjs \
  --candidate /path/to/candidate-copy --native-codex /absolute/path/to/native/codex
```

That canary uses its own named server and home, closes only its own workspaces,
and restores/uninstalls only its scratch installation. Its transport replaces
GitHub fetching with a local repository and omits dependency downloads. Neither
proof claims GitHub distribution, Linux/desktop/remote coverage, live review
quality or automatic release readiness. [Walkthrough evidence](adoption/WALKTHROUGH.md)
records the actual result and remaining limits.
