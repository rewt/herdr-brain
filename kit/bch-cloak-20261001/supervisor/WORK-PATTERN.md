# Work pattern: lanes, desks and tabs (operator 2026-09-28)

Goal: no pile-up of lanes and tabs. At any time the open lanes are exactly:
- the engineering topic lanes still in flight;
- three settle desks and four review desks;
- lanes that an operator decision holds open.

## Fixed desks, never per-run lanes

| Desk | Used by | How |
|---|---|---|
| `settle-desk`, `settle-desk-2`, `settle-desk-3` (third added 2026-09-30) | settle agents | `settle.sh R-n KIND LANE` picks a free desk itself |
| `review-desk` to `review-desk-4` (third and fourth added 2026-09-30 for the Codex-heavy push) | every review | `apply-settle.sh` picks one with `review-desk.sh`. The reviewer's first command is `git checkout --detach <engineer sha>` and its last is `git checkout lane/<desk>` |

Reviewers never commit, so a review never needs a lane of its own. **Never dispatch a review to a new
`<topic>-review` lane.**

## One engineering lane per topic, closed by its promotion

- A topic lane is opened by its first engineer dispatch. Fix rounds and rebases reuse the same lane.
- Promote only with `.lane/supervisor/promote.sh TOPIC`. It waits until no real gate is running, promotes with the
  gate, then **closes the lane** and the finished agent tabs. If a promotion fails, the lane stays open with the log in
  `/private/tmp/TOPIC-promote/`.
- A topic parked by the operator stays open, and its reason is recorded in org and OPEN-STATE.
- **Lanes that never promote must be closed by hand** (operator 2026-09-30). `promote.sh` is the only thing that closes a lane
  automatically. So:
  - **Research and archive-only lanes** (reports in `archive/`, no commits of their own, `+0` in `lane status`): run
    `node scripts/lane/lane.mjs close <topic>` as soon as the report is ingested. The report is the record; the lane
    holds nothing.
  - **Lanes parked under the revision cap**, and **stale unmerged lanes** (e.g. a conflicting "ready to promote" lane
    nobody rebased): `lane close <topic>` archive-tags them (`archive/lane/<topic>`), so they can be resumed with
    `lane open <topic> archive/lane/<topic>`. Check first that `git tag -l archive/lane/<topic>` is empty (the tag
    collision trap).
  - **Live-run lanes** used only as an agent's cwd (the work happens in the main checkout): close when the stage is
    certified.
  - At every settle and shift, run `lane status`. Any lane that is not in flight, not a desk, and not operator-held is
    a leak: close it.

## Tabs: automatic, no manual housekeeping (operator 2026-09-28)

- **Watchers have no tabs.** `dispatch.sh` starts each notify watcher detached, logging to
  `.lane/supervisor/watch-logs/R-n.log`. Its message still arrives in the supervisor pane.
- **A finished worker closes itself.** When its watcher delivers an `outcome: done` report, it closes the worker's tab.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **The janitor** (`janitor.sh start`; check with `janitor.sh status`) runs `close-finished-agents.sh` and
  `tidy-tabs.sh` every 10 minutes. The log is `watch-logs/janitor.log`. It closes:
  - done or idle agents whose run is over, or whose report file already exists;
  - tabs with no live agent, confirmed a minute later, never a workspace's first tab;
  - notify and watch tabs of finished runs;
  - workspaces of closed lanes.
- **Result:** a lane workspace shows only its first tab plus sessions that are running or waiting on the operator.
- **Session start:** run `janitor.sh start`, together with the `supervisor-opus` rename.

## Waiting for a quiet machine (revised 2026-09-30 22:30)

With about 10 lanes the host is never idle: REV-376 saw no empty window in 55 minutes, and R-901 waited for hours.
**Briefs must not ask a worker to wait for an empty host.**
- **Full gate:** only one `pnpm validate:all-safe` at a time host-wide. Before starting one, wait for no *other* one,
  for at most 15 minutes; **then start your gate anyway** (alongside the others) and record that you did. Never exit or report blocked because the host stayed busy (R-928 did, 2026-10-01). Wait with `pgrep -f 'pnpm [v]alidate:all-safe'` (the
  letter in brackets: an unbracketed pattern matches the waiter's own command line and never clears, a deadlock on
  09-28). Check each matched PID's full command, because other sessions' prompt text can match.
- **Targeted suites and mutation runs do not wait.** Run them with `--testTimeout=30000 --maxWorkers=4
  --minWorkers=1` and record the load average. A timeout under load is re-run alone once before it counts as a failure.
- **Simulation suites** still take the host test slot (ENG-725, once it is on main).

## Settle output

`apply-settle.sh REPORT SETTLE-RUN` applies a settle whose next action is `dispatch-review`:
- it runs the settle's org commands, normalising every placeholder spelling (`ITEM-NEW`, `NEW-ITEM-ID`,
  `ITEM-PROPOSAL`, `NEW-PROPOSAL-ID`);
- it ingests the settle;
- it dispatches the review on a review desk, on the other provider from the engineer.

Any other next action (a fix round, an escalation, a park) is a supervisor decision.

## Delivery target and the supervisor pane (operator 2026-09-28, late)

- Reports go to the pane in `wFN`'s tab labelled **`supervisor`**, whatever its pane id. Each delivery also re-applies
  the name `supervisor-opus` to it, and the name is the fallback when no such tab exists. The SessionStart hook
  (`session-start.sh`) re-applies it at session start.
- **Never let a background process carry the supervisor's `HERDR_PANE_ID`.** Detached watchers once inherited it from
  `dispatch.sh`, and their self-close then closed the supervisor session on every delivered report. Watchers are now
  started with `env -u HERDR_PANE_ID`, and self-close only ever closes a tab labelled `notify R-n` or `watch R-n`.

## Mouse wheel over Codex panes (operator 2026-09-29)

- In its alternate screen, Codex turns on mouse tracking, which a capture shows as `?1000h/1002h/1003h/1006h`. herdr
  then forwards each wheel scroll to it as `ESC[<65;x;yM`. Codex reads the ESC as an interrupt and types the rest into
  its composer.
- **Fix at the source:** `~/.codex/config.toml` `[tui] alternate_screen = "never"`. The same capture shows no mouse
  mode at all, so herdr scrolls its own scrollback. The backup is `config.toml.bak-20260929-mouse`. It applies to
  sessions started after 09:03 on 2026-09-29.
- **Backstop:** the janitor's 60-second tick runs `resume-interrupted.sh`. For an idle lane agent whose composer
  holds such a sequence and whose screen shows the interruption, it sends `ctrl+e ctrl+u ctrl+u` and then a
  continue prompt. It acts once per agent state change, and each action is logged in `janitor.log`.

## Gate Node version (2026-10-01)

The repo pins Node in `.nvmrc` (22.22.3). The default shell `PATH` gives nvm's 20.19.4, and Homebrew's `node` may be
26. Gates ran on all three in one night. `promote.sh` now forces the pinned version for the gate of record and
refuses if it is not installed. In briefs, have workers prefix gate runs with
`PATH=$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH`.

## Promotion queue (2026-10-01)

Promotions go through **one** detached worker, `.lane/supervisor/promote-queue.sh`, never through ad hoc
`promote.sh` chains. Ad hoc chains raced twice on 09-30 in the gap between items. To promote a topic, append it to
`.lane/supervisor/promote-queue.txt`, keeping critical-path items first. The worker consumes a line when that
promotion starts, and logs to `watch-logs/promote-queue.log`. Check that it is alive with `pgrep -fl promote-queue.sh`.
Start it with `env -u HERDR_PANE_ID nohup .lane/supervisor/promote-queue.sh >/dev/null 2>&1 </dev/null &!`.

## Once the host test slot is on main (ENG-776)

`pnpm validate:all-safe` takes the host test slot (`scripts/test-slot/test-slot.mjs`). A second full gate is
**refused with exit 75** unless `BCH_CLOAK_TEST_SLOT_WAIT_SECONDS` is set, in which case it **queues** for the slot.
From then on, briefs say: run the full gate as `BCH_CLOAK_TEST_SLOT_WAIT_SECONDS=3600 pnpm validate:all-safe`, and
drop the pgrep 15-minute wait. `promote.sh` sets 7200. An exit of 75 is a slot refusal, not a test failure; re-run it
with the wait set.
