---
run: R-37
outcome: done
summary: |
  Herdr Monitor now uses watch/watch.mjs for its worker lifecycle watcher. The distinct session-launch work moved to supervisor/open-session.mjs, while contrib/settle-watch.mjs remains byte-for-byte compatible only for bch-cloak's canonical-checkout caller until its release-gated switch. Watcher delivery and fresh settle launch are now two explicit steps. Brain watch stays unchanged because it captures every stopped session into the operator queue rather than validating and delivering one recorded run. No running service, plist, activated release, bch-cloak file, or external record was changed. A release-gated, reversible bch-cloak cutover is documented below.
headline: Worker reports now have one watcher and a release-gated cutover plan
blockers: []
proposals: []
learnings:
  - "Before this change, this repository's only live settle-watch callers were supervisor/arm-watch.sh and supervisor/continue.sh; there was no launchd or console caller."
  - "bch-cloak's live dispatch bypasses its dormant arm-watch.sh and starts notify-watch.sh directly, so switching it requires changing dispatch.sh."
  - "Brain watch observes every named Herdr session entering done or blocked, captures its screen, and appends an operator-queue result; it neither reads an org run report nor prompts a supervisor."
  - "The Brain LaunchAgent runs brain/bin/brain.mjs from the activated current release, while the console reads and controls that queue through the Brain CLI."
  - "watch --spawn can now resolve the Herdr workspace from --cwd, so supervisor/arm-watch.sh still works when invoked outside a Herdr-managed pane."
artifacts:
  - "e392f9b Use one worker watcher"
  - "supervisor/open-session.mjs, supervisor/settle.sh, supervisor/arm-watch.sh and supervisor/continue.sh"
  - "watch/watch.mjs, watch/README.md and watch/test/watch.test.mjs"
  - "test/open-session.test.mjs and test/one-watcher.test.mjs"
  - "npm test: 285 passed, 0 failed, 1 explicit Herdr-only skip"
  - "sh supervisor/arm-watch.sh R-37 --dry-run: resolved R-37, its worker, report and supervisor target without mutation"
decisions:
  - decision: Retire settle-watch from Herdr Monitor's own flow while preserving its exact compatibility entrypoint for bch-cloak until cutover.
    why: Waiting for a worker and telling the supervisor is watch's job; account selection, session brakes, routing, prompts and ledgers are launch policy, but bch-cloak still hard-codes the old file in this canonical checkout and main must not switch that project.
  - decision: Make final report delivery and settle-session launch two explicit steps.
    why: watch/watch.mjs delivers the validated report to supervisor-herdr, whose protocol then invokes supervisor/settle.sh once; this preserves fresh-context settlement without a second watcher.
  - decision: Keep Brain watch unchanged.
    why: Its consumer is the operator and console, its input is every stopped Herdr session's screen, and its durable output is the private Brain queue; watch/watch.mjs instead follows one recorded run and delivers a validated report to a supervisor.
  - decision: Gate every bch-cloak change on release activation and a quiet point.
    why: Its dispatch currently calls notify-watch.sh directly, its copied supervisor launch wrapper names the compatibility path in this canonical checkout, and changing either while runs are active could leave a run with zero or two watchers.
questions: []
challenges:
  - premise: settle-watch should retire.
    verdict: partly
    evidence: Its worker-wait loop retired from this repository's own flow and its session-opening half remains as supervisor/open-session.mjs, but the original file and CLI must stay unchanged while bch-cloak hard-codes the canonical path.
  - premise: Brain watch duplicates watch/.
    verdict: wrong
    evidence: Brain captures done and blocked screens from all sessions into queue.jsonl for the console; it does not inspect report_path, run org check or send an org-report notice to a supervisor.
  - premise: bch-cloak can switch watcher without touching its dispatch.
    verdict: wrong
    evidence: kit/bch-cloak-20261001/supervisor/dispatch.sh directly starts .lane/supervisor/notify-watch.sh; arm-watch.sh is not on that live path.
  - premise: The old bch-cloak fresh-session files can be ignored during the watcher switch.
    verdict: wrong
    evidence: arm-watch.sh and continue.sh route through scripts/lane/launch-supervisor.mjs, whose absolute SETTLE_WATCH path names this checkout's contrib file rather than an activated release. The compatibility file must remain until those callers are repointed in the release-gated edit.
---

## What calls what today

| Mechanism | Callers before this change | Job that `watch/` does not do | Disposition |
|---|---|---|---|
| `contrib/settle-watch.mjs` | Before this change, this repository's `supervisor/arm-watch.sh` and `supervisor/continue.sh`; still today, bch-cloak's dormant `arm-watch.sh` and `continue.sh` through `scripts/lane/launch-supervisor.mjs`. No launchd or console caller. | Chooses a settle/executive route and account, enforces STOP and the daily session cap, serializes supervisor launches, opens and prompts a fresh model session, records the actor and ledger, and prunes old session tabs. | Removed from this repository's own flow, with the launch half moved to `supervisor/open-session.mjs`. The original file remains unchanged solely so moving main cannot break bch-cloak; it is removed last after the release-gated switch. |
| Brain `watch` | The brief identifies the loaded LaunchAgent command as `~/.local/share/herdr-monitor/current/brain/bin/brain.mjs watch`; exact live plist flags were not inspected. `brain service` and the console's service control start or stop it, and the console reads its queue. | Observes all named sessions, captures their final terminal screens and stranded input, optionally digests prose, and appends a durable operator queue. It is not tied to org runs or reports. | Kept unchanged. This is capture for the operator, not worker-report delivery to the supervisor. |
| `watch/watch.mjs` | `supervisor/arm-watch.sh` here; the live supervisor has already used it for real runs. | This is the canonical job: follow one recorded worker, validate its report, and deliver a compact notice to the supervisor. | Kept as the only worker lifecycle watcher. |

The active Brain service and plist were not read, stopped, unloaded or edited, so flags beyond the
brief's `brain.mjs watch` command are unverified. There is no Brain
code migration in this change: after the operator activates a release containing these commits,
the existing `current/brain/bin/brain.mjs watch` command keeps the same queue contract. Activation
changes the release symlink used on the service's next launch; undo is to reactivate the preceding
release. Neither direction requires editing the plist.

## Herdr Monitor supervisor flow

`supervisor/arm-watch.sh R-n` now starts `watch/watch.mjs`, targeting `supervisor-herdr`. A final
`[org-report]` makes the long-running supervisor run `supervisor/settle.sh R-n` once. That command
opens the fresh short-lived session through `supervisor/open-session.mjs`; non-final watcher
notices do not launch a model. `supervisor/continue.sh` uses the same launcher in executive mode.
`supervisor/SETTLE.md` records this division.

The launcher retains the former safety properties: STOP and daily launch brakes, a session-open
lock, canonical workspace lookup, explicit account environment, route selection, `ORG_ACTOR`,
ledger entries, login checks and finished-session pruning. It no longer owns a worker lock, waits
for a worker to become idle/done/blocked, monitors a report, or closes a worker tab.
Unlike the compatibility watcher, it refuses promptly when another settle or executive session is
working rather than occupying the long-running supervisor with an unbounded foreground wait.
`SETTLE.md` requires the supervisor to retain that report notice and retry after the named session
stops. It also refuses a settle launch after the run already has a recorded report.

## Reversible bch-cloak switch

This is a plan only. Nothing under bch-cloak or its record was changed.

### Files in scope

The paths below are the live counterparts of the copies in `kit/bch-cloak-20261001/`:

- `.lane/supervisor/dispatch.sh`: replace its direct detached `notify-watch.sh` launch with the
  updated `arm-watch.sh` wrapper. Dispatch must change; it is the live caller.
- `.lane/supervisor/arm-watch.sh`: narrow it from launching the old settle watcher to starting
  `~/.local/share/herdr-monitor/current/watch/watch.mjs` detached, with the bch-cloak org, checkout,
  `--to supervisor-opus`, `--idle-grace 900`, and the existing per-run log.
- `scripts/lane/launch-supervisor.mjs`: replace the absolute
  `herdr-brain/contrib/settle-watch.mjs` target with the activated release's
  `supervisor/open-session.mjs`; it remains only a routed model-session launcher.
- `.lane/supervisor/continue.sh`: its arguments remain valid, but verify it through the repointed
  launch wrapper; change only its comment if needed to name `open-session` rather than a watcher.
- `.lane/supervisor/SETTLE.md`: say that arm-watch delivers to the live supervisor and that fresh
  session launch is separate; remove claims that arming itself opens a settle session.
- `scripts/lane/routing.test.mjs`: update the launcher assertions to require the activated
  `open-session.mjs` and standalone `watch/watch.mjs` paths, and forbid the retired contrib path.
- `.lane/supervisor/notify-watch.sh`: remove every caller and mark it retired; retain its exact
  pre-cutover copy in the backup until the canary and rollback window finish, then archive or
  delete it at a later quiet point.
- `.lane/supervisor/tidy-tabs.sh`: replace its `notify-log.tsv` recovery tail with a merged tail of
  the per-run `watch-logs/R-n.log` files, where `watch/watch.mjs` writes every notice before
  delivery. Keep the instruction to settle any final report the supervisor did not see.
- `.lane/supervisor/WORK-PATTERN.md`: document the new notice prefixes and fields, the 900-second
  idle grace, the stable-name delivery contract, and that the janitor rather than the watcher now
  closes finished worker tabs.
- `.lane/supervisor/session-start.sh`: keep it as the authority that names the supervisor pane
  `supervisor-opus`; make its failure visible rather than silently accepting a missing delivery
  target, because the new watcher deliberately delivers by stable agent name rather than finding
  a tab label on every notice.

One Herdr Monitor path is also in scope: `contrib/settle-watch.mjs`. It is the absolute target
hard-coded by bch-cloak's `scripts/lane/launch-supervisor.mjs`, even though it lives in this
checkout rather than the activated release. Keep it byte-for-byte unchanged through every step
above. It is the last path removed, in a later Herdr Monitor commit, only after bch-cloak has been
repointed and its canary has passed.

No change to bch-cloak's lane dispatch, route selection, run creation, report format, settle desk,
review desk or promotion queue is part of this switch. The only dispatch edit is which watcher it
arms after recording the worker.

### Behavior parity and intentional ownership changes

| `notify-watch.sh` behavior | Cutover disposition |
|---|---|
| Appends every attempted notice to `notify-log.tsv`, allowing recovery when a supervisor dialog swallows a prompt. | `watch/watch.mjs` already writes each notice to its redirected `watch-logs/R-n.log` before prompting. Change `tidy-tabs.sh` to merge and tail those logs, then prove a delivered canary line appears in its recovery output. |
| Closes a finished worker tab after delivering an `outcome: done` report. | Do not put cleanup in the generic watcher. Update `WORK-PATTERN.md` to give this job to the existing janitor/`close-finished-agents.sh`; verify an outcome-done tab closes within one janitor cycle while blocked and needs-human tabs remain. |
| Waits 900 seconds through a worker's transient idle-without-report state. | Pass the new `--idle-grace 900` option from bch-cloak's `arm-watch.sh`. The watcher still wakes immediately for a report or resumed worker. |
| Finds the pane in the tab labelled `supervisor`, renames it and falls back to `supervisor-opus`. | Deliberately narrow to one stable delivery name. `session-start.sh` owns that name and `dispatch.sh` already refuses before starting a run when it is absent. Make rename failure visible and update `WORK-PATTERN.md`; verify both the preflight refusal and successful canary delivery after a supervisor restart. |
| Uses `[watch]` for non-final notices and includes `verdict=` in `[org-report]`. | Update `WORK-PATTERN.md`'s supervisor parsing to accept `[watch-blocked]`, `[watch-no-report]`, `[watch-invalid-report]`, `[watch-long-running]` and `[watch-unavailable]`. Final handling uses `outcome=`, `headline=`, `check=` and `report=`; it does not depend on the old unreliable verdict field. Exercise every notice fixture before cutover. |

### Order

1. Wait until bch-cloak has no active worker run and no `notify-watch.sh` process. Do not switch an
   already watched run.
2. Build and have the operator activate a Herdr Monitor release containing these commits. Confirm
   `current/watch/watch.mjs` and `current/supervisor/open-session.mjs` exist. Do not edit the
   LaunchAgent or restart Brain for this cutover.
3. Copy the ten bch-cloak files above to a dated backup directory outside `.lane/supervisor/`, record their
   checksums, and stop if the live copies differ unexpectedly from the inventory kit.
4. Repoint `scripts/lane/launch-supervisor.mjs`, then update `continue.sh`, `arm-watch.sh`,
   `SETTLE.md`, `WORK-PATTERN.md`, `session-start.sh`, `tidy-tabs.sh` and `routing.test.mjs`. Run
   the routing tests, the notice fixtures, the tidy recovery dry run and both supervisor wrappers.
5. Change `dispatch.sh` last so every new run uses the new arm wrapper. Leave `notify-watch.sh`
   present but with zero callers during the canary; do not run both watchers for one run.
6. Dispatch one ordinary canary. Only after all checks below pass is `notify-watch.sh` retired.
   Keep the backup through the agreed rollback window; archive or delete the unused script only at
   another quiet point.
7. Confirm bch-cloak has no reference to the canonical-checkout contrib path. Only then remove
   Herdr Monitor's `contrib/settle-watch.mjs` in a separate commit. This compatibility file is the
   last part of the old watcher removed; it must exist whenever main moves before that point.

### Checks

- Before the compatibility file is removed, `rg` over bch-cloak's `.lane/supervisor` and
  `scripts/lane` finds no live invocation of `notify-watch.sh` or the canonical-checkout
  `contrib/settle-watch.mjs`; historical comments or the isolated backup do not count as callers.
- The canary's `watch-logs/R-n.log` names `watch/watch.mjs`, the worker and report path, and there
  is exactly one watcher process for that run.
- `tidy-tabs.sh --dry-run` includes the canary's final notice from `watch-logs/R-n.log`, proving a
  prompt swallowed by an open dialog remains recoverable without `notify-log.tsv`.
- A blocked, missing or invalid report produces the matching `watch-*` notice and remains watched;
  it does not open a settle session.
- With `--idle-grace 900`, an observed-working canary that becomes idle without a report emits no
  no-report notice during the grace, and a report write or worker resume wakes it immediately.
- A stopped worker's valid final report passes `org check` and produces one `[org-report]` prompt
  in `supervisor-opus` with the run, outcome, headline, check and report path; the supervisor flow
  does not read a `verdict=` field.
- After restarting the supervisor, `session-start.sh` visibly establishes `supervisor-opus` and
  the dispatch preflight succeeds; with the target absent, dispatch refuses before `org start`.
- After an outcome-done delivery, the janitor closes the worker tab within one cycle. A blocked or
  needs-human worker tab remains available, confirming cleanup moved rather than disappeared.
- Brain independently adds the stopped session to the operator queue. That second observation is
  expected; it does not prompt the supervisor or validate the report.
- `continue.sh --dry-run`, the routing tests and the normal bch-cloak dispatch/settle path still
  work. No service, plist or record file changed as part of the switch.

### Rollback

Rollback only at a quiet point; never add `notify-watch.sh` beside an existing standalone watcher
for the same run. Restore the ten backed-up files and their executable modes, reactivate the
preceding Herdr Monitor release, rerun the routing tests and both wrapper dry runs, then dispatch
one canary and confirm its log says `notify-watch.sh`. If the failed canary's standalone watcher is
still alive, let it finish or stop that exact recorded process before restoring dispatch. The
backup contains the untracked live scripts, so rollback does not depend on bch-cloak Git history.
If rollback happens after the final compatibility cleanup, restore the exact
`contrib/settle-watch.mjs` blob before moving main or restoring bch-cloak's old launch wrapper.

## Verification

The required suite was run before the change and passed. After the final code change, `npm test`
reported 285 passing, zero failing and one explicit Herdr-only skip. Focused tests exercise the
separate watcher/launcher wiring, retained launcher brakes and actor attribution, Brain's distinct
queue role, report delivery behavior, and `--spawn` workspace resolution outside a Herdr pane.
`git diff --check` also passed.
