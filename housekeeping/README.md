# Housekeeping

Housekeeping closes settled worker tabs, tidies exited watcher tabs, and recovers
accidental terminal interruptions without a model in the scheduler. It defaults
on. A project needs no housekeeping configuration: the record supplies the runs,
Git supplies repository and lane identity, and Herdr supplies live workers.

The project supervisor starts its schedule from the canonical project checkout,
using that checkout's code or an installed release copy:

```sh
node /path/to/herdr-monitor/housekeeping/housekeeping.mjs --start
```

Release activation delivers this startup instruction through
the [installed supervisor entry policy](../discovery/README.md). It needs no
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
tick runs `supervisor/tidy-tabs.mjs` for this Git project and record, so recorded
finished worker tabs can close while their lane remains open. It also tidies
finished reviews, exited watchers and older finished settle sessions, keeping the
newest finished session for reading. Tidy failures are logged as `tidy-failed`
and do not prevent recovery or subsequent ticks. Dry-run forwards `--dry-run`
to this pass and logs its preview without closing tabs.
A loop covers interruptions while watch waits,
and catches promotion/closure long after watch's final notice. Herdr events alone
do not include Git promotion or record ingestion; a small timer avoids wiring
several imperfect triggers together. The supervisor can start the same command;
no supervisor context is consumed after that.

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
- Per-tick worker closing requires a recorded report, no unresolved blocking item
  or waiting report, and an idle/done worker. Blocked and needs_human reports stay
  even when Herdr reports an idle worker. Review routes (`review`, `review-codex`,
  `review-max` and other `review-*` routes) require a newer verdict for their topic;
  the newest unambiguous review record must match the live pane, workspace,
  lane checkout and every recorded immutable occupant identity, with at least one
  identity recorded. Git resolves the recorded lane branch to its checkout for
  the cwd check. Missing or mismatched review evidence preserves the tab, including
  when a later reviewer reuses the name. These checks run again before each close;
  that evidence never overrides a recorded worker's missing identity or waiting run.
- Settled-lane cleanup requires a recorded report or abandonment, no open run in the same lane,
  no unresolved blocking item or waiting report, and an idle/done worker. Git
  must show its clean attached lane tip contained in the base branch, or an absent
  lane branch/worktree with its `archive/lane/TOPIC` tag. Unmerged work stays
  recoverable. A removed merged lane without archive evidence is left alone.
- Every agent in a tab must qualify. Unnamed/operator chats, blocked/working/unknown
  agents, running extra programs, unknown sessions and a foreground timer's own tab stay.
  A detached timer clears inherited pane/tab/workspace IDs; it has no terminal to protect.
  Agents identifying a tab directly are included even when their pane is absent
  from the earlier pane list; inconsistent tab/pane/workspace observations preserve
  the tab. Topology, processes, record and Git are reread before each close. The slower
  settled-lane cleanup uses `supervisor/tidy-tabs.mjs`'s shared planner in strict
  mode. The separate per-tick finished-tab command retains its existing
  report/review-verdict policy without requiring lane promotion or archival.
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
{ "enabled": true, "resume": true, "tick_seconds": 60, "cleanup_seconds": 600 }
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
`set` also accepts `--enabled=true|false`. Unknown keys, invalid booleans and intervals
below one second are refused. Config is a JSON object with these four optional keys.
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
