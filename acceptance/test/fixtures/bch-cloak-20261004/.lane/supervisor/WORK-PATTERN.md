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
- Promote only with `.lane/supervisor/promote.sh TOPIC`, which the supervisor runs by hand, one topic at a time (no daemon runs
  promotions since 2026-10-03). It promotes with the gate (the gate waits for the host test slot), then **closes the lane** and the
  finished agent tabs. It exits 75 at once if another promotion runs (a kernel lock over the whole script, plus a pgrep for this repo's
  `scripts/lane/lane.mjs promote`); run it again after that one reports, never in a retry loop. If a promotion fails, the lane stays
  open with the log in `/private/tmp/TOPIC-promote/`.
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
- **A finished worker closes itself.** When its watcher has queued the notification for an `outcome: done` report, it closes the
  worker's tab (the report file is the record; supervisor-events delivers the notification when the input box is empty). If the
  notification cannot be queued, the watcher exits 1 and closes nothing.
  A blocked or needs-human worker keeps its tab so the pane can be read.
- **No janitor (retired 2026-10-03).** Its 60-second tick polled herdr. Finished workers' tabs close when their report notification is queued
  (above). Run `close-finished-agents.sh` and `tidy-tabs.sh` by hand at each settle or shift end; they are one-shot.
- **Result:** a lane workspace shows only its first tab plus sessions that are running or waiting on the operator.
- **Session start:** the hook only renames the pane `supervisor-opus`; it starts no daemon (it restarted the janitor despite PAUSED on 10-03).

## Waiting for a quiet machine (revised 2026-09-30 22:30)

With about 10 lanes the host is never idle: REV-376 saw no empty window in 55 minutes, and R-901 waited for hours.
**Briefs must not ask a worker to wait for an empty host.**
- **Full gate:** engineers do not run it (see "One full gate per lane, at promotion"). It runs in `promote.sh`, takes the host test
  slot and queues for it. Never wait for an empty host with `pgrep` or a sleep loop (superseded 2026-10-03).
- **Targeted suites and mutation runs do not wait.** Run them with `--testTimeout=30000 --maxWorkers=4
  --minWorkers=1` and record the load average. A timeout under load is re-run alone once before it counts as a failure.
- **Simulation suites** take the host test slot. An agent that finds it held writes `/private/tmp/bch-cloak-waiters/R-n.slot` and
  ends its turn (see "Event-driven supervisor").

## Settle output

`apply-settle.sh REPORT SETTLE-RUN` applies a settle whose next action is `dispatch-review`:
- it runs the settle's org commands, normalising every placeholder spelling (`ITEM-NEW`, `NEW-ITEM-ID`,
  `ITEM-PROPOSAL`, `NEW-PROPOSAL-ID`);
- it ingests the settle;
- it dispatches the review on a review desk, on the other provider from the engineer.

Any other next action (a fix round, an escalation, a park) is a supervisor decision.

## Delivery target and the supervisor pane (operator 2026-09-28, late)

- Reports go to the agent named exactly **`supervisor-opus`** (no fallback since 2026-10-03; the old wFN/cwd fallback could hit
  another session). The SessionStart hook (`session-start.sh`) applies the name at session start; if it is missing, run
  `herdr agent rename <supervisor pane> supervisor-opus`. Undelivered messages wait in `.lane/supervisor/outbox/`.
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
- **Backstop:** `resume-interrupted.sh`, run by hand if a pre-09-29 session shows the interruption (the janitor that ran it every
  minute is retired). It sends `ctrl+e ctrl+u ctrl+u` and then a continue prompt.

## Gate Node version (2026-10-01)

The repo pins Node in `.nvmrc` (22.22.3). The default shell `PATH` gives nvm's 20.19.4, and Homebrew's `node` may be
26. Gates ran on all three in one night. `promote.sh` now forces the pinned version for the gate of record and
refuses if it is not installed. In briefs, have workers prefix gate runs with
`PATH=$HOME/.nvm/versions/node/v$(cat .nvmrc)/bin:$PATH`.

## Promotions (revised 2026-10-03)

The supervisor runs `promote.sh TOPIC` by hand, one at a time, critical path first; never chain promotions (they raced twice on 09-30)
and never wrap one in a retry loop. A daemon-run queue was dropped after review REV-NOPOLL (a busy promotion re-triggered itself 28
times in 1.5 s). `promote-queue.txt` is only the supervisor's own ordered list; nothing reads it.

## Once the host test slot is on main (ENG-776)

`pnpm validate:all-safe` takes the host test slot (`scripts/test-slot/test-slot.mjs`). A second full gate is
**refused with exit 75** unless `BCH_CLOAK_TEST_SLOT_WAIT_SECONDS` is set, in which case it **queues** for the slot.
`promote.sh` sets 7200 for the gate of record. An exit of 75 is a slot refusal, not a test failure. (The 10-01 brief text
asking engineers to run the full gate with a slot wait is superseded: engineers run no full gate, see "One full gate per lane,
at promotion".)

## Tooling release (2026-10-01)

`org` and `lane` on PATH run the installed Herdr Monitor release (`~/.local/share/herdr-monitor/current`, v0.1.2 at
install), not the herdr-brain development checkout, so merges there no longer change what this project runs.
`apply-settle.sh` and `close-finished-agents.sh` call `org` from PATH (backups `*.bak-20261001-path`), and
`scripts/lane/launch-supervisor.mjs` runs settle-watch from the release (commit 5851d520). A tooling change reaches this
project only through a new herdr-brain release.

## Operator questions (2026-10-01; decision on ORCH-39)

`.org/config.json` "approvals" sets a policy for each question category:
- **Auto-answered at once** with the question's `--recommend` answer (`answered_by auto`), without waiting: `prover`,
  `tooling`, `goals`.
- **Wait for the operator:** `security`, `funds-and-chain`, `publish`, `licensing`, `delete-data`, `priorities`,
  `design`, `other` (and the default).

Always file with `org ask "<question>" --parent ID --category C --recommend ANSWER --why TEXT`. A question without
`--category` is not covered by the policy. The operator can overrule an auto answer afterwards (`org answer --overrule`),
so act on an auto answer and record that it was auto. Funding, mainnet, publication and anything public still need the
operator: those categories never auto-answer.


## Event-driven supervisor (operator 2026-10-02 night; built and reduced 2026-10-03)

The operator ordered polling eliminated after the host degraded on 10-02 (herdr calls stacked to 22 min, `ps` hung, Bluetooth dropped;
trustd/syspolicyd wrote 8.6 GB of launch checks in 2 h). **Never add a loop that sleeps and re-checks**, in a script, a brief, or this
session, and never answer a capacity limit (exit 3, exit 75) with a retry loop.

`.lane/supervisor/supervisor-events.mjs` does two things only: it wakes agents that wait on the host test slot or on a file, and it
delivers notifications to the supervisor pane. It runs no promotions and no gates (gate requests from old briefs are answered with a
`skipped`/`refused` raw exit file). Its header lists exactly what launches a child process; in short:
- Every child is a herdr call. They run strictly one at a time: SIGTERM after 30 s, SIGKILL 5 s later. A call that survives SIGKILL
  (stuck in the kernel) holds the queue until it exits, so no further herdr call starts; that is logged. A stop by SIGINT/SIGTERM/SIGHUP
  or a crash kills the running call first; a SIGKILL of the daemon cannot.
- With no waiter files and no messages it launches nothing; the 5-minute sweep only re-arms watches and runs a pass, which wakes a
  waiter only if one is due and its event was missed (a holder that died without removing its lock).
- Each waiter file (a regular file) is claimed (renamed) and attempted once; a run with both a `.slot` and a `.file` is woken for one
  at a time. Before typing it asks herdr to wait up to 25 s for the agent to end its turn, then re-checks PAUSED; a wake held by PAUSED
  puts the file back for later. A failure (including a relative path in a `.file`) moves the file to `R-n.<kind>.failed` and queues
  one supervisor message naming where the file is; nothing retries it. (If that rename fails, the file stays as `R-n.<kind>.waking`;
  if the outbox write fails, it is only logged.)
- A gate request whose raw exit file cannot be written becomes `*.req.failed` (or stays in place, skipped, if that rename fails) and
  the supervisor is told once.
- A notification is delivered only while the input box reads empty; the read and the prompt run back to back (the operator can still
  type in that gap). A deferred delivery retries with backoff 30 s doubling to 10 min, at most 6 attempts, then parks until a new
  message arrives or `touch .lane/supervisor/outbox/RETRY` (checked against the directory whenever a pass finds no delivery or retry
  timer running, including at each sweep).
- Watches: one that errors is dropped and re-armed at the next sweep; so is one whose directory was removed or replaced.
- Restart: a wake that was in flight is reported as failed (whether its text was typed is unknown); the slot reservation is on disk
  (`watch-logs/supervisor-events.reservation`) and restored.
- Start (only once the operator lifts PAUSED): load `com.rewt.bch-cloak.supervisor-events.plist` with launchd (instructions in the
  file), or in a herdr pane `node .lane/supervisor/supervisor-events.mjs`; never both. One instance: it holds 127.0.0.1:47391, and a
  second instance exits 0. Log `watch-logs/supervisor-events.log`. While `PAUSED` exists it wakes no agent and answers no gate request;
  a wake already waiting on its agent is put back, not typed. Notifications are still delivered.
- Test: `zsh .lane/supervisor/se-test/run.sh` (temp dirs, stub herdr and org, never real panes; covers the daemon, notify-watch and the
  dispatch/promote locks; exits 1 on any failure). Run it after any change to these scripts. Not covered: real herdr timing, real
  input-box rendering, launchd itself.

**Waiting agents write a file, then end their turn** (no pane scraping):
- **Slot:** `echo R-n > /private/tmp/bch-cloak-waiters/R-n.slot`, last line `WAITING-FOR-SLOT`. Agents are woken with `SLOT-FREE`,
  oldest file first; the next only after the slot is taken again or 10 minutes after the wake.
- **File:** `echo /abs/raw-exit-path > /private/tmp/bch-cloak-waiters/R-n.file`, last line `WAITING-FOR-FILE: /abs/raw-exit-path`.
  Woken with `FILE-READY` when that path exists.
- The notify watcher sees the waiter file and raises no alert. **Never write the report file before the wait is over**: the watcher treats
  any valid report as final.
- A wake that failed leaves `R-n.slot.failed` / `R-n.file.failed` and a `[supervisor-events] could not wake` message: read the pane, then
  wake the agent by hand or delete the file and have the agent write a new waiter.

Brief paragraph to include: **Waiting:** start long probes detached (`nohup ... > log 2>&1; echo $? > <raw-exit file>`), then write
`<raw-exit path>` into `/private/tmp/bch-cloak-waiters/R-RUN.file` and end your turn with the line `WAITING-FOR-FILE: <raw-exit path>`; do not
poll or tail the log; you will be woken with FILE-READY. If the slot is held before you start, write `/private/tmp/bch-cloak-waiters/R-RUN.slot`
and end your turn with `WAITING-FOR-SLOT`. Do not write your report file until the wait is over and the work is done; a report written early is
treated as final. Do not call herdr.

## Notifications never type over the operator (operator 2026-10-02)

Messages to the supervisor are files in `.lane/supervisor/outbox/` (`notify-watch.sh` and supervisor-events write them). The daemon
delivers each one only while the Claude Code input box reads empty (a port of `box-empty.py`), with the bounded retries above, and logs
it to `inbox.log` and `notify-log.tsv`. Never call `herdr agent prompt` on the supervisor pane directly. `notify-watch.sh --to` is only a
label (dispatch.sh counts runs in flight by it). After starting watchers, check every open run has one (`ps … notify-watch` vs `org`
open runs): R-1095 ran 3 h with none on 10-02. Watchers' own herdr calls (one blocking `agent wait` each, plus `agent get`) are not
serialized with the daemon's; the session cap bounds how many there are.

## One full gate per lane, at promotion (operator 2026-10-02)

The operator chose this to shorten review cycles (each lane was paying for two full gates: the engineer's and the promotion's).
- **Engineers:** targeted suites plus the downstream suites the change reaches (briefs name them; simulator suites still take the host test slot
  through `test-slot.mjs`), then commit and report. No `validate:all-safe`, no gate-queue request. Brief text: "No full gate: it runs once at
  promotion. Run the targeted and downstream suites named here with raw exits."
- **Settle and review** never block on a missing full gate (settle protocol and the review-brief waiting rule say so).
- **Promotion** (`promote.sh`, by hand -> `lane promote`) runs the gate of record on the rebased tree. A red promotion gate goes back
  to the engineer as a fix round; the re-review covers only that delta.
- supervisor-events answers any leftover gate request at once: `skipped` while `.lane/supervisor/engineer-gates-off` exists, otherwise
  `refused` (it has no gate runner since 2026-10-03; restoring engineer gates would need a new, reviewed runner).

## Routine engineer reports skip settle (operator 2026-10-02)

`direct-review.sh R-n` sends a routine engineer report straight to a cross-model review; the reviewer does the settle desk's checks first (scope
against the brief, evidence checksums, reruns of every named suite and control) as Part 1 of the review. The script refuses non-routine reports
(outcome not done, blockers, failing org check, dirty lane, no commit ahead of main). Still use `settle.sh` when a report claims chain, proving,
funding or approval work, touches a frozen contract or pin, asks for a decision, or when its scope looks wrong. Generated briefs carry one report
path only (REV-437's settle-drafted brief named two on 10-02). Flow now: engineer -> direct review -> promote.sh by hand (the one full gate).
Fix rounds: `REVIEWED=<last reviewed sha> REVIEWED_BY=<REV-n> direct-review.sh R-n` makes the brief a delta review.

## Session limits restored (operator 2026-10-02 evening)

The operator restored the earlier limits after load (avg 30-45 with ~10 sessions) made the simulator suite fail run to run and cost review rounds:
- **At most 3 runs in flight** (engineer, research, review and settle all count), measured by live `notify-watch` processes. `dispatch.sh` and
  `direct-review.sh` refuse (exit 3) at the cap before creating anything; `FORCE_DISPATCH=1` overrides with a reason in OPEN-STATE. Running work
  drains; nothing is killed to get under the cap.
- **Reviews of finished work first** when a place frees, then the 4a-U critical path; never widen because a session is idle.
- **One test suite at a time per session**, `--maxWorkers=4 --minWorkers=1`, no synthetic load loops; if load exceeds 2x cores (36), stop test
  runners first. Only full gates and the simulator suite serialize on the slot.
- Frontier games and ENG-916 stay held (Codex reset).
Held queue (in order): ENG-923 (slot waits on sandboxed holders), ENG-799 (DC4, Astra, after ENG-798), ENG-897 (after ENG-869 + ENG-895 land),
ENG-800 slice B (after ENG-853 + ENG-911 land).

## What uses the host test slot (10-02 evening incident)

Only `pnpm validate:all-safe` and the full simulator suite (`pnpm validate:pool-multiparty-sim`, or its SysV files `p0-gate.test.ts` and
`sandbox-boundary.test.ts`) take the slot. Every other targeted suite runs directly, with no test-slot wrapper. A brief that says "tests that take
the slot go through test-slot.mjs" was read by agents as "wrap every test", and seven sessions queued behind one promotion gate. Briefs must name
the two slot users explicitly and say "run everything else first". A holder whose start time cannot be read (sandbox EPERM) is live: wait.
supervisor-events wakes slot waiters one at a time; the promotion gate queues on the slot like any other holder.
