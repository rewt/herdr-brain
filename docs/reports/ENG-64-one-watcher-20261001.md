---
run: R-37
outcome: done
summary: |
  Herdr Monitor now has one worker lifecycle watcher: watch/watch.mjs. The former settle-watch was retired and its distinct session-launch work moved to supervisor/open-session.mjs; watcher delivery and fresh settle launch are now two explicit steps. Brain watch stays unchanged because it captures every stopped session into the operator queue rather than validating and delivering one recorded run. No running service, plist, activated release, bch-cloak file, or external record was changed. A release-gated, reversible bch-cloak cutover is documented below.
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
  - "70950ac Use one worker watcher"
  - "supervisor/open-session.mjs, supervisor/settle.sh, supervisor/arm-watch.sh and supervisor/continue.sh"
  - "watch/watch.mjs, watch/README.md and watch/test/watch.test.mjs"
  - "test/open-session.test.mjs and test/one-watcher.test.mjs"
  - "npm test: 285 passed, 0 failed, 1 explicit Herdr-only skip"
  - "sh supervisor/arm-watch.sh R-37 --dry-run: resolved R-37, its worker, report and supervisor target without mutation"
decisions:
  - decision: Retire settle-watch as a watcher and keep its distinct model-session launch behavior under supervisor.
    why: Waiting for a worker and telling the supervisor is watch's job; account selection, session brakes, routing, prompts and ledgers are launch policy and remain useful without observing worker lifecycle.
  - decision: Make final report delivery and settle-session launch two explicit steps.
    why: watch/watch.mjs delivers the validated report to supervisor-herdr, whose protocol then invokes supervisor/settle.sh once; this preserves fresh-context settlement without a second watcher.
  - decision: Keep Brain watch unchanged.
    why: Its consumer is the operator and console, its input is every stopped Herdr session's screen, and its durable output is the private Brain queue; watch/watch.mjs instead follows one recorded run and delivers a validated report to a supervisor.
  - decision: Gate every bch-cloak change on release activation and a quiet point.
    why: Its dispatch currently calls notify-watch.sh directly, its copied supervisor launch wrapper names the retired canonical path, and changing either while runs are active could leave a run with zero or two watchers.
questions: []
challenges:
  - premise: settle-watch should retire.
    verdict: partly
    evidence: Its worker-wait loop and contrib identity retired, but its session-opening half is distinct and remains as supervisor/open-session.mjs behind settle.sh and continue.sh.
  - premise: Brain watch duplicates watch/.
    verdict: wrong
    evidence: Brain captures done and blocked screens from all sessions into queue.jsonl for the console; it does not inspect report_path, run org check or send an org-report notice to a supervisor.
  - premise: bch-cloak can switch watcher without touching its dispatch.
    verdict: wrong
    evidence: kit/bch-cloak-20261001/supervisor/dispatch.sh directly starts .lane/supervisor/notify-watch.sh; arm-watch.sh is not on that live path.
  - premise: The old bch-cloak fresh-session files can be ignored during the watcher switch.
    verdict: wrong
    evidence: arm-watch.sh and continue.sh route through scripts/lane/launch-supervisor.mjs, whose absolute SETTLE_WATCH path names the retired contrib file. They are dormant but must be repointed in the same release-gated edit so an operator command does not break.
---

## What calls what today

| Mechanism | Callers before this change | Job that `watch/` does not do | Disposition |
|---|---|---|---|
| `contrib/settle-watch.mjs` | This repository's `supervisor/arm-watch.sh` and `supervisor/continue.sh`; bch-cloak's dormant `arm-watch.sh` and `continue.sh` through `scripts/lane/launch-supervisor.mjs`. No launchd or console caller. | Chooses a settle/executive route and account, enforces STOP and the daily session cap, serializes supervisor launches, opens and prompts a fresh model session, records the actor and ledger, and prunes old session tabs. | The worker-following loop and contrib file retired. The launch half moved to `supervisor/open-session.mjs`; `settle.sh` and `continue.sh` call it explicitly. `arm-watch.sh` now calls only `watch/watch.mjs`. |
| Brain `watch` | The loaded LaunchAgent runs `~/.local/share/herdr-monitor/current/brain/bin/brain.mjs watch --digest`; `brain service` and the console's service control start or stop it, and the console reads its queue. | Observes all named sessions, captures their final terminal screens and stranded input, optionally digests prose, and appends a durable operator queue. It is not tied to org runs or reports. | Kept unchanged. This is capture for the operator, not worker-report delivery to the supervisor. |
| `watch/watch.mjs` | `supervisor/arm-watch.sh` here; the live supervisor has already used it for real runs. | This is the canonical job: follow one recorded worker, validate its report, and deliver a compact notice to the supervisor. | Kept as the only worker lifecycle watcher. |

The active Brain service and plist were not read, stopped, unloaded or edited. There is no Brain
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

## Reversible bch-cloak switch

This is a plan only. Nothing under bch-cloak or its record was changed.

### Files in scope

The paths below are the live counterparts of the copies in `kit/bch-cloak-20261001/`:

- `.lane/supervisor/dispatch.sh`: replace its direct detached `notify-watch.sh` launch with the
  updated `arm-watch.sh` wrapper. Dispatch must change; it is the live caller.
- `.lane/supervisor/arm-watch.sh`: narrow it from launching the old settle watcher to starting
  `~/.local/share/herdr-monitor/current/watch/watch.mjs` detached, with the bch-cloak org, checkout,
  `--to supervisor-opus`, and the existing per-run log.
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

No change to bch-cloak's lane dispatch, route selection, run creation, report format, settle desk,
review desk or promotion queue is part of this switch. The only dispatch edit is which watcher it
arms after recording the worker.

### Order

1. Wait until bch-cloak has no active worker run and no `notify-watch.sh` process. Do not switch an
   already watched run.
2. Build and have the operator activate a Herdr Monitor release containing these commits. Confirm
   `current/watch/watch.mjs` and `current/supervisor/open-session.mjs` exist. Do not edit the
   LaunchAgent or restart Brain for this cutover.
3. Copy the seven files above to a dated backup directory outside `.lane/supervisor/`, record their
   checksums, and stop if the live copies differ unexpectedly from the inventory kit.
4. Repoint `scripts/lane/launch-supervisor.mjs`, then update `continue.sh`, `arm-watch.sh`,
   `SETTLE.md` and `routing.test.mjs`. Run the routing tests and dry-run both supervisor wrappers.
5. Change `dispatch.sh` last so every new run uses the new arm wrapper. Leave `notify-watch.sh`
   present but with zero callers during the canary; do not run both watchers for one run.
6. Dispatch one ordinary canary. Only after all checks below pass is `notify-watch.sh` retired.
   Keep the backup through the agreed rollback window; archive or delete the unused script only at
   another quiet point.

### Checks

- `rg` over `.lane/supervisor` and `scripts/lane` finds no live invocation of `notify-watch.sh` or
  `contrib/settle-watch.mjs`; historical comments or the isolated backup do not count as callers.
- The canary's `watch-logs/R-n.log` names `watch/watch.mjs`, the worker and report path, and there
  is exactly one watcher process for that run.
- A blocked, missing or invalid report produces the matching `watch-*` notice and remains watched;
  it does not open a settle session.
- A stopped worker's valid final report passes `org check` and produces one `[org-report]` prompt
  in `supervisor-opus` with the run, outcome, headline and report path.
- Brain independently adds the stopped session to the operator queue. That second observation is
  expected; it does not prompt the supervisor or validate the report.
- `continue.sh --dry-run`, the routing tests and the normal bch-cloak dispatch/settle path still
  work. No service, plist or record file changed as part of the switch.

### Rollback

Rollback only at a quiet point; never add `notify-watch.sh` beside an existing standalone watcher
for the same run. Restore the seven backed-up files and their executable modes, reactivate the
preceding Herdr Monitor release, rerun the routing tests and both wrapper dry runs, then dispatch
one canary and confirm its log says `notify-watch.sh`. If the failed canary's standalone watcher is
still alive, let it finish or stop that exact recorded process before restoring dispatch. The
backup contains the untracked live scripts, so rollback does not depend on bch-cloak Git history.

## Verification

The required suite was run before the change and passed. After the final code change, `npm test`
reported 285 passing, zero failing and one explicit Herdr-only skip. Focused tests exercise the
separate watcher/launcher wiring, retained launcher brakes and actor attribution, Brain's distinct
queue role, report delivery behavior, and `--spawn` workspace resolution outside a Herdr pane.
`git diff --check` also passed.
