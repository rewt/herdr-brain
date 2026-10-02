---
run: R-81
outcome: done
summary: |
  Added housekeeping to the modern console's Control page and a dedicated activity view, with schedule state, last live scan, actions, reasons, failures and preview labels. Pause and optional overrides review then save through a validating record housekeeping command into the canonical project's .housekeeping.json; stale edits, invalid values and redirected files are refused. Live cleanup now records kept-tab reasons. The lane is committed and rebased onto main, the complete offline suite passed with two test workers, and live-record and fixture print evidence is included below.
headline: The console now shows housekeeping activity and lets the operator pause it or change its overrides.
blockers: []
proposals:
  - role: engineer
    title: Bound watcher fixture cleanup after failed waits
    why: Default-concurrency baseline and post-change npm test runs stalled with fake R-18 and R-19 watcher children still alive. Those tests can fail a two-second wait before registering cleanup or reaching waitForExit. The isolated watcher suite and the complete suite with two workers pass, but every failed fixture should still terminate its children so an unattended gate always finishes.
learnings:
  - Housekeeping state is keyed by the SHA-256 of the real Git common directory under the record, so projects sharing a record must use separate activity sources.
  - Pausing through enabled=false takes effect at the next tick. Enabling changes permission to work but does not restart a stopped schedule; the project supervisor owns startup.
  - Older live scans log counts without per-tab keep reasons or cleanup scope. An already-running process needs a supervisor-managed restart onto the new module before it emits the added fields; existing logs are displayed without inventing reasons.
  - Restricted PID probes can return EPERM for a live schedule. Display unknown with the probe error while allowing validated config edits when the owner identity matches; read-only rendering outside that restriction verified the real running process.
artifacts:
  - "Commit: Surface housekeeping activity and validated overrides in the console"
  - "Commit: Report housekeeping console delivery and validation evidence"
  - lane/console-housekeeping
  - housekeeping/command.mjs
  - housekeeping/config.mjs
  - console/modern/housekeeping.mjs
  - console/test/housekeeping.test.mjs
  - housekeeping/README.md
  - console/modern/README.md
  - /tmp/eng75-evidence/complete-suite.log
  - /tmp/eng75-evidence/focused.log
  - /tmp/eng75-evidence/live-80x30.txt
  - /tmp/eng75-evidence/live-100x40.txt
  - /tmp/eng75-evidence/live-140x45.txt
  - /tmp/eng75-evidence/fixture-100x40.txt
  - /tmp/eng75-evidence/fixture-pause-review.txt
  - /tmp/eng75-evidence/fixture-override-review.txt
  - /tmp/eng75-evidence/fixture-receipt.json
  - .lane/gate.json
decisions:
  - text: Keep schedule startup with the project supervisor; console pause and override edits only change canonical tracked config through a validating CLI.
    category: design
    why: This follows the existing default-on module contract and allows portable projects to steer housekeeping without giving lane code authority to start live housekeeping.
  - text: Reuse the modern console review and argument-array CLI pattern for housekeeping and retain explicit unknown or stale source state.
    category: design
    why: It preserves existing console workflows, rejects conflicting edits and avoids treating a failed read or preview as successful live work.
  - text: Use two test workers for the complete offline validation and final lane gate.
    category: tooling
    why: Existing fake watcher timing fixtures leaked children under the concurrent baseline and post-change runs; their isolated suite and the complete reduced-concurrency suite pass.
questions: []
challenges:
  - Default-concurrency npm test did not finish during both baseline and post-change validation. Only this run's test groups were stopped; the isolated watcher suite passed 17/17 and the complete suite with two workers passed 472 with four explicit skips. No unrelated watcher implementation or tests were changed.
---

## Delivered behavior

`H` opens Housekeeping; Control links to the same page. It shows running, stopped, no record, stale lock or unknown process state, effective enabled/recovery/timing values, the last live scan, recent actions and failures, and configuration sources. Preview scans never replace the last live scan. Action reads are bounded to a 512 KiB tail and the newest 200 entries; omitted history and damaged complete entries are explicit. An unfinished append is ignored. A failed refresh retains labeled last-good data and prevents editing until recovery.

Pause opens a review of `enabled=false`. Edit overrides supports the four optional keys; blank fields remove that override and restore its default. Tab changes fields, Ctrl+U clears, Enter reviews then confirms, and Cancel/Esc discards. Editors own shortcut and mouse navigation. The console writes only through argument-array child processes invoking `record housekeeping set`. `--print` blocks that adapter even if keys confirm a save.

The dependency-free CLI also exposes `record housekeeping --json`, `record housekeeping pause`, `record housekeeping set --enabled=false --resume=false --tick-seconds=60 --cleanup-seconds=600`, and repeatable `--unset KEY`. Writes target the canonical Git checkout, preserve other overrides, validate before atomic replacement, lock competing writers, reject symlinks/hardlinks and reject stale `--expect` revisions. Reading an unconfigured project creates no record, config or schedule. The optional file is ready to add and commit in Git; tests demonstrate that tracked result. A custom-config or mismatched-runtime lock prevents treating the default file as that schedule's control.

The scheduler now logs keep reasons on live cleanup passes, cleanup/recovery scope on scans and a reason for successful recovery. Pane eligibility, runtime provenance, resume deduplication, lifecycle safety and the compatibility watcher remain intact. The console never starts or signals housekeeping and never changes a pane as part of this work.

## Validation

- Baseline `npm test` ran before edits, reached 452 reported cases and stalled; it was interrupted. Post-change ordinary `npm test` reached 458 reported cases and stalled. Read-only inspection of this run's process group identified fake R-18/R-19 watcher wait loops; only this run's verified test groups were terminated. The watcher suite passed in isolation: 17/17.
- After rebasing onto local main, the complete package test list ran with `node --test --test-concurrency=2 --test-timeout=180000`: **472 passed, 4 skipped, 0 failed**, 476 total, about 118 seconds. The skips explicitly require native sandbox opt-in (three) or console dependencies (one). The runner also had a 420-second outer bound.
- Focused housekeeping and new console coverage: **64/64 passed**. Earlier combined housekeeping/modern regression coverage passed **107/107**. The complete suite includes existing control-plane, console, core, dispatch, discovery, promotion and watcher regressions.
- The seven new bounded tests use their own actor and disposable Git projects. They cover actual CLI persistence, pause, resetting defaults, invalid values, stale reviews, cancellation, editor input ownership, no record creation, canonical-worktree targeting, shared-record project isolation, running/stale/malformed locks, linked files, competing writers, partial/bad logs, failed-source recovery, 80/100/140-column layouts and read-only confirmed print flows. Existing housekeeping fixtures also assert live keep reasons.
- `git diff --check` passed. The report is checked with `record check`, committed, then the final command is `lane check` with the same bounded, two-worker complete suite, binding `.lane/gate.json` to the clean report commit.

## Print evidence

These are actual `console/app.mjs --modern --print` renders. Herdr topology is replaced with an empty read-only fixture to isolate the control surface; zero session counts do not describe the live workspace. Record status and housekeeping sources for the live screen are real. A PID existence probe outside the filesystem sandbox verified the existing process, without starting, stopping or changing it. No live config or record events were written. Raw snapshots retain all rows at 80x30, 100x40 and 140x45; excerpts below omit blank tail rows.

Live record, 100x40:

```text
  herdr-brain ▾               ‹  Project / Housekeeping                                  r Refresh

  herdr-brain                                                                       H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 2   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: running · pid 52987
  Enabled · recovery on · tick 60s · cleanup 600s
  Last live scan: 2026-10-02T06:10:10.999Z · 46s ago
  Edit overrides ›
  Pause at next tick ›
  Enabling a stopped schedule requires the project supervisor to start it.

  Recent activity · newest first
  2026-10-02T06:10:10.999Z · scan ·
  0 close candidates · 0 kept · cleanup scope not recorded
  2026-10-02T06:09:10.677Z · scan ·
  0 close candidates · 0 kept · cleanup scope not recorded
```

Disposable project with closed, kept and resumed activity, 100x40:

```text
  Fresh project ▾             ‹  Project / Housekeeping                                  r Refresh

  Fresh project                                                                     H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: stopped
  Enabled · recovery on · tick 60s · cleanup 600s
  Last live scan: 2026-10-02T06:09:30.332Z · 0s ago
  Edit overrides ›
  Pause at next tick ›
  Enabling a stopped schedule requires the project supervisor to start it.

  Recent activity · newest first
  2026-10-02T06:09:30.332Z · scan ·
  Cleanup not due this tick.
  2026-10-02T06:09:30.332Z · resumed · R-5
  interrupted open run with only mouse-wheel escape text in the composer
  2026-10-02T06:09:30.332Z · keep · Review worker
  agent is working
  2026-10-02T06:09:30.332Z · closed · Finished engineer
  R-4 report recorded; clean lane promoted
  2026-10-02T06:09:30.332Z · scan ·
  1 close candidates · 1 kept
```

The same fixture was paused and edited using the actual modern session and its default CLI adapter. The review preceded persistence:

```text
  Review housekeeping change                                                                        
  enabled: false → false                                                                            
  resume: true → false                                                                              
  tick_seconds: 60 → 15                                                                             
  cleanup_seconds: 600 → 600                                                                        
  Pause takes effect at the next tick. Enabling permits work; the project supervisor starts a       
  stopped schedule.                                                                                 
  Enter  Save housekeeping                                                                          
  Cancel                                                                                            
  Writes project config: /private/tmp/eng75-evidence/project/.housekeeping.json                     
```

The final fixture receipt was `enabled=false`, `resume=false`, `tick_seconds=15`, `cleanup_seconds=600`, `process=stopped`. Its persisted overrides contain only enabled, resume and tick_seconds. This demonstrates that saving settings does not start a timer. The executable evidence setup and steering harness are under `/tmp/eng75-evidence`; the tracked tests reproduce the persistence checks.
