# bch-cloak's agentic workflow, as built (2026-10-01)

A read-only pass over `/Users/rewt/development/bastian/bch-cloak` and its workspace root, to find
every piece that orchestrates the agent cycle, so Herdr Monitor can take over the generic parts
and leave bch-cloak only its configuration. Nothing in bch-cloak was changed.

**The biggest risk:** almost none of it is in version control. `.lane/` is in the global gitignore
(`~/.config/git/ignore`); only `SETTLE.md`, `arm-watch.sh` and `continue.sh` are force-tracked,
and those are the dormant parts. The live kit (dispatch, watcher, settle, review desks, promotion
queue, janitor) exists only on this disk, with no history.

## The cycle

| Step | Piece | What it does |
|---|---|---|
| Dispatch | `.lane/supervisor/dispatch.sh ITEM LANE ROUTE HARNESS MODEL EFFORT BRIEF REPORT [BASE]` | `org start` (run record, brief with org context) → opens and prepares the lane worktree if new, fast-forwards a reused one to BASE → `lane.mjs dispatch --route` → `org set` agent and pane → starts a detached `notify-watch.sh` with `env -u HERDR_PANE_ID` |
| Route | `scripts/lane/routing.json` + `routing.mjs` (+ tests) | 23 named routes (kind, model, effort, use); `dispatch` defaults with launch env (persona, `CLAUDE_CONFIG_DIR`, `GH_CONFIG_DIR`); `always_args` (claude-mem adapter per harness); `selection_policy` (task class → route per primary pool) |
| Launch | `scripts/lane/lane.mjs dispatch` | Opens a tab in the lane's Herdr workspace, starts Codex or Claude with the resolved route, submits the brief |
| Watch | `.lane/supervisor/notify-watch.sh R-n --to supervisor-opus` | Waits for the worker to stop; rejects reports with placeholders; runs `org check`; sends `[org-report] run= item= outcome= verdict= report=` to the supervisor pane by `herdr agent prompt`; logs to `notify-log.tsv`; closes a done worker's tab, then itself. No report or a failing one sends `[watch] … stopped (blocked …)` |
| Settle | `.lane/supervisor/settle.sh R-n KIND LANE` | Picks a free settle desk (3), writes `archive/BRIEF-SETTLE-R-n-DATE.md` pointing at `archive/SETTLE-DESK-POOL-20260927.md`, dispatches on route `settle` under ORCH-39 |
| Apply settle | `.lane/supervisor/apply-settle.sh REPORT SETTLE-RUN` | Runs the settle report's `org_commands` (normalising placeholder spellings), ingests the settle, extracts the `## Draft` brief (`extract-brief.py`), dispatches the review on a free review desk (`review-desk.sh`, 4 desks) on the other provider |
| Review | Review desks | Reviewer detaches at the engineer SHA first and returns the desk to its branch last; never commits; verdict PASS / NEEDS-WORK |
| Fix rounds | Supervisor decision | Reuse the topic lane; revision cap; escalation routes after two stuck rounds |
| Promote | `.lane/supervisor/promote-queue.sh` + `promote-queue.txt` → `promote.sh TOPIC` | One detached worker pops topics in order; waits for no running gate; forces the `.nvmrc` Node; `BCH_CLOAK_TEST_SLOT_WAIT_SECONDS=7200`; `lane.mjs promote` (rebase, full gate, fast-forward, no push); closes the lane and finished tabs; messages the supervisor after each (added 2026-10-01 after the silent 02:02 refusal) |
| Housekeeping | `.lane/supervisor/janitor.sh start` | Every 10 min: `close-finished-agents.sh` and `tidy-tabs.sh` (also prints runs per provider and effort for the last 24 h). Every 60 s: `resume-interrupted.sh` |
| Supervisor session | `.claude/settings.local.json` SessionStart → `.lane/supervisor/session-start.sh` | In `wFN` only: renames the pane `supervisor-opus`, starts the janitor |
| Handoff | `.lane/supervisor/OPEN-STATE.md` (2,471 lines), `WORK-PATTERN.md` (118), `GAPS.md`, `PROJECT.md`, `TODAY.md` | Prose state and rules the live chat reads; priority #1 lives here |
| Fresh-session settle (dormant since 2026-09-20) | `SETTLE.md`, `continue.sh`, `arm-watch.sh`, `scripts/lane/launch-supervisor.mjs` → herdr-brain `contrib/settle-watch.mjs` | A short-lived orchestrator per finished run. The live chat never loads `SETTLE.md` |
| Stage view (dead) | `stage.sh`, `stage.py` | Prints items of `G-1 meta.stage_now`; the stages were dropped |

## Where state lives

- **Record:** `/Users/rewt/development/bastian/.org/` (the workspace root, outside the repo), read through `~/.local/bin/org` → herdr-brain `bin/org.mjs` on main.
- **Briefs and reports:** `/Users/rewt/development/bastian/archive/` (about 2,000 files: `BRIEF-<ITEM>-<SLUG>-<DATE>.md`, `<ITEM>-<SLUG>-<DATE>.md`, `SETTLE-R-n-…`, `REVIEW-…`).
- **Worktrees:** `~/.herdr/worktrees/bch-cloak/lane-<topic>`; scratch under `/private/tmp/<topic>-*/`, swept by `lane close`.
- **Logs:** `.lane/supervisor/watch-logs/` (per run, janitor, promote queue), `notify-log.tsv`.
- **Desks:** long-lived lanes `settle-desk{,-2,-3}`, `review-desk{,-2,-3,-4}`.

## Rules the workflow depends on

From `WORK-PATTERN.md`, `AGENTS.md` and `routing.json`:

- **Roles:** only the orchestrator marks work done, after an independent review; reviewers never edit or commit; implementers stop and report rather than change library crypto, relations, frozen contracts or vector corpora.
- **Lanes:** one lane per topic, opened by the first engineer dispatch, closed by its promotion; reviews never get a lane; research lanes are closed by hand after ingest; unmerged lanes are archive-tagged.
- **Routing:** select by task class; the reviewer runs on the other provider from the engineer; adversarial, covert-channel and custody work goes to Codex (Opus trips its cyber safeguard); tier equivalence (Opus high = Sol high, …); the operator flips `primary_implementation_pool` by quota.
- **Host:** one full gate at a time (host test slot, exit 75 is a slot refusal); targeted suites don't wait; pinned Node for gates.
- **Harness quirks:**
  - Codex `[tui] alternate_screen = "never"` in `~/.codex/config.toml`, so the mouse wheel doesn't interrupt it; `resume-interrupted.sh` is the backstop.
  - Detached processes must not inherit the supervisor's `HERDR_PANE_ID`.
  - `pgrep` patterns are bracketed so a waiter doesn't match itself.

## Generic, configuration, or bch-cloak's own

| Generic: belongs in Herdr Monitor | Configuration: bch-cloak supplies | bch-cloak's own: stays in its repo |
|---|---|---|
| Dispatch pipeline (record a run, brief, lane, routed agent, watcher) | Routes, models, efforts, task classes, primary pool | Domain rules in `AGENTS.md` (crypto, proving, chain, publication) |
| Report watcher and delivery to the supervisor, notify log, tab self-close | Supervisor name and workspace, delivery target | The full-gate command and test-slot variable |
| Desk pools for settles and reviews (pick a free desk, reviewer detach/return) | Desk counts | Settle-desk protocol content (`SETTLE-DESK-POOL`) |
| Settle → apply → review hand-off, fix rounds, escalation | Archive directory and file naming | Stage plans and runbooks |
| Promotion queue (one worker, ordered, messages on finish) | Node pin, gate wait time | |
| Janitor (close finished, tidy, resume interrupted) | Memory integration args, persona env | |
| Supervisor session bootstrap (name the pane, start the janitor, load the protocol) | | |
| Routing resolver and selection-policy schema | | |
| Harness quirk fixes (`env -u HERDR_PANE_ID`, bracketed waits, Codex mouse) | | |

## Drift and duplication found

- **Two lane tools:** bch-cloak `scripts/lane/lane.mjs` (637 lines) and herdr-brain `lanes/` (2,360 lines).
- **Three watchers:** `notify-watch.sh`, `contrib/settle-watch.mjs`, Brain `watch`.
- **Routing values copied outside `routing.json`**, which its own `authority` forbids: `settle.sh` hard-codes `codex gpt-6.1-sol high` (and the Opus fallback), and `dispatch.sh` takes MODEL and EFFORT from its caller.
- **Absolute paths everywhere:** `ROOT=/Users/rewt/development/bastian`; the herdr-brain paths in `apply-settle.sh`, `close-finished-agents.sh` and `launch-supervisor.mjs`; the `org` symlink.
- **The protocol and the practice differ:** `SETTLE.md` (authority split, parking, two-lane cap) is not what the live chat follows; the chat follows `WORK-PATTERN.md`, `OPEN-STATE.md` and memory.
- **Stale notes:** `monitoring-2026.09.12.1.md` names a `scripts/lane/dispatch-defaults.json` that no longer exists.
