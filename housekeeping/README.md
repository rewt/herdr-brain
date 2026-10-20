# Housekeeping

Housekeeping retires eligible recorded worker tabs and recovers
accidental terminal interruptions without a model in the scheduler. It defaults
on. A project needs no housekeeping configuration: the record supplies the runs,
Git supplies repository and lane identity, and Herdr supplies live workers.

The project supervisor starts its schedule from the canonical project checkout,
using that checkout's code or an installed release copy:

```sh
node /path/to/herdr-monitor/housekeeping/housekeeping.mjs --start
```

Release activation delivers this startup instruction through
the [supervisor policy](../discovery/README.md). It needs no
project AGENTS.md edit. Native
fresh Herdr starts receive worker policy and never start a schedule. Installation
itself starts no project loop; the canonical supervisor performs the start.

The command discovers the canonical Git checkout, its checked-out base branch,
and the nearest record using the record's existing discovery (`ORG_DIR`, then
`.org/events.jsonl` above the entered checkout or canonical checkout). Outside Git,
or without a record, it exits without starting anything. It never creates a record.
Repeated `--start` reports the existing process. `--once` runs one full pass;
`--loop` runs the timer in the foreground. Paths and `--main` can be overridden for
unusual layouts. No dependency, launchd installation, user-specific path, release
change, or inference call is required.

Lane workers never start the project-wide loop. Every live mode (`--once`,
`--start`, `--loop`) refuses when the script or record CLI lives in a linked Git
worktree, or when the target checkout is linked. This prevents unreviewed,
removable lane code from acting on live panes. Workers can run `--once --dry-run`
with an isolated state directory. Installed release copies outside Git
remain supported.

The detached process is a timer, not an agent: tidy finished tabs and resume every
60 seconds, with settled-lane cleanup on startup and every 600 seconds. Every
tick runs `supervisor/tidy-tabs.mjs` through the same pure retirement planner
and guarded executor as settled cleanup. Projects opting into
`retirement.closeout_queue: true` in their canonical `.lane.json` transfer both
scheduled retirement passes to the [event-driven closer](../docs/contracts/CLOSEOUT.md).
The queue and updated legacy ticks share the retirement ownership lock; older
housekeeping must be stopped/restarted before activation. Other housekeeping
work continues. Named recovery is `node supervisor/retire.mjs sweep --lane PATH`.
For projects retaining scheduled retirement, the default-on `release_sessions` policy
releases a recorded reviewer after any validated verdict (PASS, NEEDS-WORK or
FAIL), and a worker after its exact run's PASS is consumed by landed integration
or a different successor is bound to its own native pane, terminal and session.
The old worker must have an ingested report or a recorded supersession
(`run.abandoned`); the successor must be observed in its recorded pane. An explicit
confirmed handoff remains supported. This does not wait for the item's other
children to finish. A reused pane/terminal/session, mismatched identity, HOLD and
live references keep the session. Other ingested reports keep their pane while
review, correction or integration can return to it.
Unrecorded reviews, sessions and watcher shells stay. See the exact eligibility
and generic reference contract in [the supervisor README](../supervisor/README.md#safe-retirement).
Tidy failures are logged and do not prevent recovery or subsequent ticks.
Each tick also consumes a newer `retirement/request.json` revision through the
guarded executor, without waiting for the cleanup interval. Requests coalesce;
a request written during apply remains pending, as does a request under the
project HOLD. A preview never acknowledges a request. No schedule is added.
Dry-run previews the plan without closing tabs or removing worktrees, including
`would-remove-lane` rows for eligible integrated lanes.
The policy uses the same guarded transaction as `record pane-release`, recording
its authority, exact session/terminal/pane/head and evidence before retirement.
It never removes an open Git lane. The existing exit receipt closes an unchanged
bare shell; a freshly verified empty workspace closes with its last tab while
its worktree and branch remain available. A failed close is retryable.

To disable these automatic per-run releases, run
`record housekeeping set --release-sessions false`. This writes the canonical
project's `.housekeeping.json`; `--unset release_sessions` restores the default.
Malformed policy settings keep the project. The setting changes no schedule.
Each canonical live cleanup pass also refreshes the owner's
[`record summary`](../docs/PROJECT-SUMMARY.md), reusing its observed retirement
snapshot after cleanup and recovery. Recovery-only ticks, scoped checks and dry-run
previews never publish. A publication failure
is logged as `summary-publish-failed` and does not stop cleanup or recovery.
A loop covers interruptions while watch waits,
and catches promotion/closure long after watch's final notice. Herdr events alone
do not include Git promotion or record ingestion; a small timer avoids wiring
several imperfect triggers together. The supervisor can start the same command;
no supervisor context is consumed after that.

`supervisor/retire.mjs status` derives terminal age by replaying record events:
the close or final ingested report that completes the chain, or the exact recorded
pane release. A reopening clears that chain's age. JSON exposes `terminalAt` and
`terminalAgeMs`; text and `--out` show the age and count/list TERMINAL rows older
than 30 minutes. IDLE-NONTERMINAL rows name the next actor and include the exact
pane/session/head release command; authority, disposition and evidence placeholders
must be filled by the supervisor. When the recorded identity cannot support a
pane release, the recommendation uses guarded `lane close`, which archive-tags
unmerged work. These projections never authorize retirement.
Missing or prunable Git worktree entries stay as individual rows with their lane,
canonical common-directory identity and reason; status never prunes them.

Housekeeping remembers when it first observes an unchanged IDLE-NONTERMINAL tab.
After more than 24 hours it queues one notice through the existing supervisor
inbox and action log, addressed to `MONITOR_SUPERVISOR_AGENT` (default
`supervisor-herdr`). The tab notice coalesces the duplicate pane rows. Its release
recommendation includes all required flags. Changed occupants or recommendations
restart the observation period; unchanged rows do not repeat across restarts.
`retirement-notices.json` lives in housekeeping's state directory, never the
record event log. Previews neither queue notices nor update this bookkeeping.

## Evidence before action

External dispatchers use the supported
[`dispatch/record-worker.mjs` launch step](../dispatch/README.md#external-dispatchers)
immediately after starting each worker, before arming watch. It records the same
identity as Monitor dispatch through the record CLI and refuses mismatches.
It is never used to reconstruct missing launch evidence for legacy tabs.
See [existing-project adoption](../docs/ADOPTING.md#switch-an-existing-project-and-clean-up-its-backlog)
for canonical-supervisor startup and the manual one-time backlog procedure.

- A live worker must match the newest run for its name, recorded pane, workspace and cwd,
  and at least one recorded occupant identity (`terminal_id` or `agent_session_id`).
  Both identities are checked when recorded. Legacy runs missing pane, workspace,
  cwd or occupant identity are preserved; session registry data cannot fill it in.
- Both per-tick and settled cleanup require report ingestion and a terminal chain,
  an exact pane release, or an eligible per-run policy release. Pending promote,
  verify, host-slot, declared references and watcher callbacks keep panes.
- Every occupant and process in a tab must qualify. The executor rechecks record,
  jobs, Git path/head/common directory, pane, terminal and native session against
  the plan. It logs the current refusal if anything changed. Unknown, lab-owned,
  persistent and operator sessions stay; display metadata cannot supply authority.
- After a recorded agent exits through the shared executor, its observed terminal,
  pane and shell birth identity are saved under `ORG/retirement/exits/`. A cleanup
  retry or settled housekeeping pass can close that single bare shell after Herdr
  unregisters the agent. It rechecks the original run's release policy, clean and
  integrated Git, references, focus and holds. A changed terminal or shell, extra
  pane or remaining child process keeps the tab. Successful close prunes the
  receipt. Each canonical settled cleanup pass also runs the promotion queue's
  bounded cleanup retry under its shared `cleanup.lock`, so the integrated lane
  leaves through the existing guarded merged-lane path without a later drain.
  Previews, scoped checks and recovery-only ticks do not run queue retries.
- Each canonical settled cleanup pass also inventories registered linked
  `lane/<topic>` worktrees, including lanes merged outside the promotion queue.
  After eligible occupants retire, the sweep requires clean Git, the exact tip
  integrated in the base branch, a terminal chain or established absence of a
  chain, zero panes and no live process/job references. Missing or ambiguous
  record/reference evidence keeps the lane. The existing lifecycle lock and
  guarded removal executor recheck identity, ancestry and canonical HOLD and
  verify evidence preservation outside the lane before removal. Archival
  retirement is disabled by default. A project's reviewed activation may set
  `retirement.archival_retirement: true` in its canonical `.lane.json` to also
  consider non-ancestor lanes whose non-merge patches all appear in main's
  history. `integrated` remains the ancestry fact. The archival case requires a
  complete Git observation, at least one matching patch, no unmatched patches
  or unique merge commits, and the same terminal-chain, reference, protection
  and zero-occupant checks. A historical match after a revert does not discharge
  an open obligation. Untouched dispatch preparations remain kept. Both the
  lane tip and main snapshot are bound and rechecked under the lifecycle lock;
  removal requires the exact verified `archive/lane/<topic>` tag and preserved
  evidence. Conflicting tags are never overwritten. Missing, malformed or
  unreadable policy cannot enable this case; lane copies and `LANE_CONFIG`
  cannot enable it either. This capability's development does not activate it.
  Pending queue cleanup retains its existing
  retry limits. The sweep has the same finite 30-second foreground allowance as
  retirement catch-up and attempts each lane at most once per pass. The lanes
  view and action log show keep reasons; scoped and recovery-only ticks do not
  sweep.
- Recovery requires an open run, idle/done Codex, a current `■ Conversation
  interrupted` (or `■ Turn interrupted`) banner at the end of the visible output,
  and only SGR wheel junk (`<64` through `<67`; coordinates; `M`/`m`) in the composer.
  Human words, wrapped input, an old interruption above a final reply, any report
  file awaiting ingestion, and an approval/question are preserved. Other kinds of
  interruption need human judgment and receive no automatic input.
- Recovery attempts are persisted before input, keyed by run, pane, occupant and
  Herdr `state_change_seq`. An uncertain failure is logged and never replayed at
  that sequence, even after restart. Identity/record are checked again before
  input and between composer clearing and the continue prompt. Herdr's CLI does
  not offer a compare-and-act transaction; a change in the final command window
  remains possible. Failed or incomplete reads stop the pass.

Herdr evidence: installed `agent list` exposes `agent_status`, `state_change_seq`,
`terminal_id`, `agent_session`, pane/workspace and cwd. `agent explain` on our live
worker matched `osc_title_working`, manifest `2026.10.01.1`. A read of an older,
finished Codex worker showed its final response and empty placeholder composer,
with `idle` in `agent list`. The synthetic interruption fixture in
`test/fixtures/interrupted.txt`, evaluated through the installed
`herdr agent explain --file ... --agent codex --json`, returned `idle`,
`default_known_agent_idle_fallback`. Thus idle/done alone cannot distinguish an
interrupted turn from a finished one; the visible banner and composer supply the
extra evidence. We did not interrupt a real worker to obtain a specimen.
The original mouse-wheel incident is documented in bch-cloak's
`.lane/supervisor/WORK-PATTERN.md` (the retired `kit/bch-cloak-20261001/` copy
remains in Git history).

## Optional overrides and stopping

An optional `.housekeeping.json` in the canonical checkout overrides defaults:

```json
{ "enabled": true, "resume": true, "tick_seconds": 60, "cleanup_seconds": 600, "release_sessions": true }
```

Use the validating CLI from the project or one of its worktrees; it always targets
that Git project's canonical checkout, never an ancestor configuration:

```sh
record housekeeping --json
record housekeeping pause
record housekeeping set --resume=false --tick-seconds=60 --cleanup-seconds=600
record housekeeping set --unset=resume
```

`--unset KEY` may repeat and removes only the named override, restoring its default.
`set` also accepts `--enabled=true|false` and `--release-sessions=true|false`.
Unknown keys, invalid booleans and intervals below one second are refused. Config
is a JSON object with these five optional keys.
Writes reject symlinks, hardlinks and conflicting writers, preserve other overrides,
and replace the file atomically. `--expect REV` rejects a stale revision from
`record housekeeping --json`. The optional config belongs in Git; add and commit it
as a project choice. Reads create neither config nor record nor schedule.

`record housekeeping` shows process state, the last live scan and recent actions
with reasons; `record housekeeping pause` and `set` edit through the validating
record CLI. Enabling permits work but never starts a stopped schedule; only the
project supervisor starts the default schedule from the canonical checkout. Stale
locks remain visible and are never removed by these commands.

Set `enabled` to `false` to stop at the next tick, or send SIGTERM/SIGINT to the
PID in the reported state directory's `lock/owner.json`. Setting `resume` to `false` keeps
cleanup and disables input recovery. Invalid configuration stops the loop. A
missing configuration uses defaults; removing an override does not disable it.

Actions, failures, scan counts and dry-run plans go to
`ORG/housekeeping/REPOSITORY_KEY/actions.jsonl`, readable by the supervisor. Live cleanup passes include per-tab
keep reasons; scan entries distinguish cleanup due from recovery-only ticks. The key hashes the canonical Git common directory, separating
projects that share a record. `--start` prints the state directory. This avoids
creating untracked files in a project that has configured no ignore rules.
Detached stdout/stderr also go to `schedule.log`; recovery attempt
keys go to `resume-attempts.jsonl`. These are module bookkeeping, never org events
or stored work status. Logs currently have no retention policy. One state directory
must be used per project; `--state-dir` is intended for isolated tests/previews.
A directory lock prevents overlap. After a crash it deliberately refuses startup:
inspect the owner PID and log, verify that the process is gone, then remove only
that stale lock and restart. It never kills a PID discovered in a stale lock.
The owner record includes the canonical script path and resolved record CLI
paths. An existing owner with missing paths, a different runtime, or no runtime
identity (a legacy lock) refuses startup instead of reporting already-running;
inspect it and stop the old schedule before removing its lock and restarting.

For a preview without changing panes or starting a timer:

```sh
node housekeeping/housekeeping.mjs --once --dry-run --state-dir "$PWD/.lane/housekeeping-preview"
```

`--dry-run` previews even a disabled project. Tests use disposable Git repositories,
fake Herdr/record commands and synthetic screens; they never call a model or mutate
real panes. `npm test` includes them.

Each existing live tick also checks the shared supervisor notice inbox and
restarts its finite delivery owner if necessary. That owner replays unacknowledged
notice IDs through the composer gate. Dry-run previews never start delivery, and
a missing or fully acknowledged inbox starts no worker.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Supervisor native session entry uses `--start --resume` when the canonical
`.housekeeping.json` has `enabled` and `resume` true (both default true). Resume
serializes starts, validates the existing lock's project, record, config and
runtime, and recovers only a confirmed dead matching owner before restarting.
Owner locks retain the kernel start-time `identity` beside the PID. A reused PID
with a different birth is a dead owner and can be recovered without signaling the
replacement process. A present legacy PID without a birth or an unreadable
identity requires inspection. Live owners are reused; unknown owners and mismatched or missing runtimes require
inspection. Ordinary `--start` retains its stale-lock refusal. These are only
housekeeping locks; supervisor entry reports promotion, settle and release locks
without removing them. Worker lanes never use either live start mode.
