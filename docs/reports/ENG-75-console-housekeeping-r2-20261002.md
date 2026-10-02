---
run: R-87
outcome: done
summary: |
  Fixed both round-one findings with regression tests. Discovered Git projects without a record now inspect and edit housekeeping through the actual console CLI adapters, and close failures show the actual error alongside the planned reason in both console and text CLI views. Rebased onto main before changes, ran npm test before and after, committed the fixes, and captured fixed print renders at three widths plus the live-record view.
headline: Housekeeping controls now work without a record and closure failures show their actual errors.
blockers: []
proposals: []
learnings:
  - Child-process environment values stringify null; an absent project record must pass an empty ORG_DIR to clear inherited overrides and permit discovery.
  - A close-failed action retains both the planned eligibility reason and the actual command error; readers must display both fields independently.
artifacts:
  - "Commit: Fix no-record housekeeping controls and show closure failures"
  - "Commit: Report round-two housekeeping fixes and regression evidence"
  - lane/console-housekeeping
  - console/lib/cli.mjs
  - console/modern/frame.mjs
  - lib/render.mjs
  - console/test/housekeeping.test.mjs
  - /tmp/eng75-r87-evidence/regressions-before.log
  - /tmp/eng75-r87-evidence/housekeeping-after.log
  - /tmp/eng75-r87-evidence/npm-before.log
  - /tmp/eng75-r87-evidence/npm-after.log
  - /tmp/eng75-r87-evidence/no-record-defaults-100x40.txt
  - /tmp/eng75-r87-evidence/no-record-saved-100x40.txt
  - /tmp/eng75-r87-evidence/close-failed-100x40.txt
  - /tmp/eng75-r87-evidence/close-failed-cli.txt
  - /tmp/eng75-r87-evidence/no-record-receipt.json
  - /tmp/eng75-r87-evidence/live-100x40.txt
  - /tmp/eng75-r87-evidence/preexisting-review/855e54e-r1.md
  - .lane/gate.json
decisions:
  - text: Normalize absent record paths in the existing shared CLI environment helper.
    category: design
    why: Both housekeeping adapters use it; clearing the inherited override lets the validating CLI discover the selected project's record or return its no-record defaults.
  - text: Display command failures and planned reasons separately in both housekeeping readers.
    category: design
    why: The planned eligibility reason cannot explain a failed close; independent rendering preserves the failure and its context.
questions: []
challenges:
  - The lane initially contained an untracked round-one review receipt. It was preserved unchanged under /tmp/eng75-r87-evidence/preexisting-review before the clean-worktree gate; the supplied findings file was not copied into the repository.
---

## Findings resolved

The environment helper now passes `ORG_DIR: project.org ?? ''`. The regression opens a real disposable Git checkout through a discovered Herdr workspace with no configured projects, asserts its catalog record is null, and uses the default housekeeping CLI adapters to read defaults, pause, and save recovery=false after review. The result contains only the expected project overrides, with no record, schedule state directory or literal-null directory created.

The console and text CLI now render an error independently of the planned reason. The regression seeds a `close-failed` action containing both fields, checks both readers, verifies the console failure is highlighted, and exercises an actual `--print` child. Console layouts are checked at 80, 100 and 140 columns. Existing pause, override, cancellation, stale-review, read-only-print and lifecycle tests remain green.

## Validation

- Rebase onto main ran first and reported the lane up to date. The implementation commit is **Fix no-record housekeeping controls and show closure failures**.
- Before fixing production code, both new regression tests failed as expected: one received a child error for a nonexistent `project/null` path; the other could not find the actual closure error in the console render.
- Focused housekeeping console suite after fixes: **9 passed, 0 failed**. Both new tests have a 30-second test bound, subprocesses have explicit timeouts, and fixture subprocesses set their own `ORG_ACTOR`. Console writes retain the intentional human actor.
- Baseline `npm test`: **472 passed, 4 skipped, 0 failed**, 476 total, about 65 seconds. Post-change ordinary `npm test`: **474 passed, 4 skipped, 0 failed**, 478 total, about 42 seconds. Each run has an outer 240-second bound and its own run actor. No reduced-concurrency override was needed this round. Existing skips are three native-sandbox opt-ins and one missing-console-dependencies check.
- `git diff --check` passed. After this report is checked and committed, the final operation is `lane check` using ordinary `npm test`, with the same outer time bound; `.lane/gate.json` records its clean report-commit result.

## Fixed print views

These excerpts are actual `console/app.mjs --modern --print` output. Full snapshots for defaults, saved overrides and close failure are under `/tmp/eng75-r87-evidence` at 80x30, 100x40 and 140x45. The fixture repositories, optional configs and action log are disposable scratch data. An empty Herdr topology adapter keeps renders independent of live panes. `--print` never saves settings; the saved-settings receipt comes from the actual modern session and its default CLI adapter.

A Git project without a record, defaults (100x40):

```text
  fresh-project-final ▾       ‹  Project / Housekeeping                                  r Refresh

  fresh-project-final                                                               H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: no record
  Enabled · recovery on · tick 60s · cleanup 600s
  Last live scan: not recorded
  Edit overrides ›
  Pause at next tick ›
  Enabling a stopped schedule requires the project supervisor to start it.

  Recent activity · newest first
  No activity recorded.

  Configuration sources
  Config: /private/tmp/eng75-r87-evidence/fresh-project-final/.housekeeping.json · defaults
  State: no record
```

After reviewed pause and recovery override saves through the console (100x40):

```text
  fresh-project-final ▾       ‹  Project / Housekeeping                                  r Refresh

  fresh-project-final                                                               H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: no record
  Paused · recovery off · tick 60s · cleanup 600s
  Last live scan: not recorded
  Edit overrides ›
  Enabling a stopped schedule requires the project supervisor to start it.

  Recent activity · newest first
```

The receipt confirms `org=null`, `state=null`, `recordCreated=false`, and overrides `{enabled:false,resume:false}`. Tick and cleanup continue to inherit their defaults.

Closure failure with both fields (100x40):

```text
  close-failure-project-fin…  ‹  Project / Housekeeping                                  r Refresh

  close-failure-project-final                                                       H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: stopped
  Enabled · recovery on · tick 60s · cleanup 600s
  Last live scan: 2026-10-02T06:54:31.663Z · 0s ago
  Edit overrides ›
  Pause at next tick ›
  Enabling a stopped schedule requires the project supervisor to start it.

  Recent activity · newest first
  2026-10-02T06:54:31.664Z · close-failed · Finished worker
  Error: Herdr refused to close tab-failed
  Reason: R-9 report recorded; clean lane promoted
  2026-10-02T06:54:31.663Z · scan ·
  1 close candidates · 0 kept
```

The text CLI renders the same evidence:

```text
  Error: Herdr refused to close tab-failed
  Reason: R-9 report recorded; clean lane promoted
```

Live-record housekeeping view (100x40):

```text
  herdr-brain ▾               ‹  Project / Housekeeping                                  r Refresh

  herdr-brain                                                                       H Housekeeping

  Overview   Goals   Tasks   Activity   Waiting 3   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Housekeeping
  Schedule: running · pid 52987
  Enabled · recovery on · tick 60s · cleanup 600s
  Last live scan: 2026-10-02T06:54:29.506Z · 26s ago
  Edit overrides ›
  Pause at next tick ›
  Enabling a stopped schedule requires the project supervisor to start it.
```

The real record and module logs supply the live view; Herdr topology remains a fixture and makes no claim about the live session count. A read-only render outside the sandbox verified the existing PID after the sandboxed probe returned EPERM. No live config, record events, schedule, pane, release or external project was changed.
