---
run: R-160
outcome: done
summary: |
  Added a common foreground supervisor entry through native Claude and Codex SessionStart hooks for startup, resume, clear and compact. Entry prints the cold start, resumes enabled housekeeping, re-arms dead open-run watchers, and reports stale cycle locks without deleting them. Explicit canonical supervisor bindings and worker bypass guards exclude workers. All 32 focused offline acceptance tests pass; implementation is committed and ready for promotion validation.
headline: Native supervisor entry now recovers housekeeping and dead watchers safely
blockers: []
proposals: []
learnings:
  - "Codex CLI 0.160.0 supports SessionStart for startup, resume, clear and compact; hook definitions require native trust review through /hooks."
  - "Existing unmarked supervisor sessions need one relaunch through an explicit supervisor adapter; pane names and session metadata do not authorize entry."
  - "Direct worker, reviewer and legacy settle launchers already set MONITOR_ENTRY_BYPASS=1; the session hook honors it to prevent inherited supervisor bindings from triggering recovery."
artifacts:
  - "Implementation commit 4021445 on lane/supervisor-entry"
  - "supervisor/entry.mjs"
  - "supervisor/session-start.mjs"
  - "supervisor/session-hooks.mjs"
  - "supervisor/test/entry.test.mjs"
  - ".claude/settings.json and .codex/hooks.json"
  - "docs/reports/ENG-128-supervisor-entry-evidence/test-first.txt"
  - "docs/reports/ENG-128-supervisor-entry-evidence/entry-tests.log"
  - "node --test supervisor/test/entry.test.mjs — 32 passed, zero failed, zero skipped"
  - "git diff --check — passed"
decisions: []
questions: []
challenges: []
---

Implemented the brief in the existing supervisor, launch adapter and housekeeping modules, using dependency-free foreground glue. No model, new service, promotion, settlement, release, dispatch, or checkpoint is invoked by entry. The canonical housekeeping scheduler and existing per-run watch process remain the owners of background work.

Both native adapters supply the same hook and explicit role, canonical checkout, Git common-directory identity and record bindings. Worker adapters overwrite inherited bindings. This repository also wires the hook beside Claude's existing canary hook and in Codex's native project hook file. The command hook catches failures, prints their reasons and exits successfully. Recovery subprocesses share a 20-second deadline; the native hook timeout is 30 seconds.

Housekeeping appears in the read-only cold-start brief, including a stopped process or stale lock. Entry honors both enabled and resume. Its explicit `--start --resume` path serializes starts and validates the old lock's project, record, config and exact runtime before recovering a confirmed dead owner. Ordinary `--start` retains its stale-lock refusal. Promotion/release, promotion queue, supervisor receipt and project-scoped settle locks are inspected and retained.

Watcher recovery checks the folded open runs, then rereads the run immediately before starting watch so an intervening recorded report prevents re-arming. Watch's existing exclusive per-run lock prevents duplicates. Successful startup records the new watcher PID and log through the record CLI. Live or invalid PID evidence, foreign or missing checkouts and unknown repository bindings do not authorize a watcher. STOP or an incomplete record event permits reading and lock inspection only.

Acceptance tests were written and run before implementation: all 18 initial tests failed. The additional inherited-worker guard also had a recorded failing test before its fix. Final focused validation passed all 32 tests in 8.7 seconds. Tests cover repeated entry without a second record mutation or duplicate owner, worker and lane exclusion, all four sources in both native hook configurations, both real launch adapters with offline native stand-ins, reported and concurrently reporting runs, live lock owners, preserved stale locks, housekeeping dead-owner recovery and refusal boundaries, STOP, invalid config/PIDs, and independent recovery after command failures. Test-owned housekeeping processes ran only in temporary repositories with offline CLI stand-ins and were stopped before cleanup.

A read-only Codex `features list` invocation accepted the generated hook configuration. The first attempt also supplied `--strict-config`; Codex rejects that flag for `features`, so it was removed. No model or network call was made by this validation.

Reviewed the diff against the brief before committing. No baseline, full suite, promotion suite, lanes suite or live acceptance harness was run. As ordered, the final lane check runs after this report is validated and committed; its terminal result accompanies the final response.

Activation remains native: relaunch an existing unmarked supervisor once through `monitor-claude --role supervisor` or `monitor-codex --role supervisor`. Herdr restoration must retain that launcher/role environment. Review and trust Codex hooks through `/hooks`; no trust bypass was added. Older Codex builds lacking SessionStart, disabled or untrusted hooks, and cloud orchestration without local command hooks cannot run automatic entry. The documented manual fallback is `supervisor.mjs entry --repo PROJECT --org RECORD --role supervisor --to YOUR-SUPERVISOR`. Set MONITOR_SUPERVISOR_AGENT for a non-default notice recipient.

Codex support and limitations were verified against the [official hook documentation](https://learn.chatgpt.com/docs/hooks) on 2026-10-03. These activation requirements are documented in supervisor/README.md.
