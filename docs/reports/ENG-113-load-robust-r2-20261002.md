---
{
  "run": "R-140",
  "outcome": "done",
  "summary": "Rebased the load-aware deadline implementation onto current main and reran the previously blocked offline checks after the supervisor stopped leaked fixtures. Full validation exposed and corrected a native PTY allowance mismatch, exact-clock watchdog regressions, and a fixed inbox shutdown wait. The fast tier, complete npm suite, affected module suites and lane suite now pass; no executable launch stall recurred. The historical PTY leak needs separate fixture lifetime and cancelled-gate coverage, proposed below.",
  "headline": "Load-aware cycle deadlines now pass all requested offline checks.",
  "blockers": [],
  "proposals": [
    {
      "role": "engineer",
      "title": "Bound PTY fixture leaves independently and verify cancelled promotion gates",
      "why": "Today's SIGHUP-ignoring PTY leaf survived its gate's cancellation. The current blocked PTY fixture leaf has no independent kernel deadline and escapes the suite group; its native session owner cannot clean after its own SIGKILL or a refused cleanup sweep. Add a leaf-level OS lifetime bound and offline regressions that cancel a promotion gate and terminate the native owner, including cancellation before receipts. Preserve kernel identity checks and refusal behavior. Existing green outer-runner cancellation cases do not prove this additional boundary."
    }
  ],
  "learnings": [
    "After the supervisor stopped five leaked fixtures, the executable launch non-response did not recur in this run's fast, full, focused or lane checks. This resolves the observed validation blocker without establishing the precise historical host cause.",
    "The JavaScript PTY helper passed a load-scaled bound while pty-owner.c rejected anything above 15000ms. The first complete core run had ten PTY failures plus one exact-clock watchdog assertion, with no launch stall. The native owner now accepts the same finite allowance, capped at Node's INT32_MAX timer bound; a simulated load-24 regression proves launch and exit status with a 90-second allowance.",
    "Deliberate one-second watchdog tests require --fixed-deadlines. The newly merged phased npm coordinator now forwards that option; normal file and suite overrides remain load-scaled.",
    "The inbox fixture teardown helper still had a fixed five-second owner wait. A full cycle rerun failed one teardown there; the owner lock had subsequently disappeared. The wait now scales with load, and its regression proves delayed shutdown plus retained ownership evidence when the deadline expires.",
    "The ps base remains two seconds with at most three timeout-only attempts and doubling allowances/backoff. At simulated load 24, lookup allowances are 12, 24 and 48 seconds, while synchronous-command and per-test limits are 90 and 360 seconds. All signal authorization still requires fresh matching start time and command; malformed, refused, exhausted and replacement-PID lookups remain non-authorizing.",
    "Current ordinary Node dispatch, discovery lifecycle and watcher fixtures inherit the retained suite group. Their cleanup is covered by the runner and fresh leader confirmation. No additional module-specific cleanup defect was reproduced in those paths. Existing detached discovery regressions already put native alarms on each detached Node generation.",
    "The PTY session is independent of the suite group. Its existing deadline, normal-exit, outer SIGTERM/SIGKILL, suite cancellation and shell-job regressions pass, but killing the native owner itself remains a distinct uncovered lifetime boundary."
  ],
  "artifacts": [
    "Commit: Adapt cycle response deadlines and process checks to machine load (bca4b1b after rebase), on lane/load-robust.",
    "Commit: Align native PTY and fixture shutdown deadlines under load (6fc0a75), on lane/load-robust.",
    "Rebase base: main cbd31c92d6039c28c863f5aff7a54f76e9f27eb9; main remained unchanged through the final pre-report checks.",
    "docs/reference/load-deadlines.md: allowance inventory, fixture ownership boundaries and historical PTY leak assessment.",
    "npm run test:fast: 140 passed, zero failures; /private/tmp/eng113-r140-fast.log.",
    "Focused load, startup, process safety, PTY, hang guard and phased-runner suites: 70 passed, zero failures; /private/tmp/eng113-r140-focused.log. The added inbox regression also passed its isolated check and the final complete suite.",
    "npm test: 814 passed, 11 existing host-specific skips, zero failures; /private/tmp/eng113-r140-npm-test-green.log. Copied-entry: 2 passed; core/modules: 677 passed and 11 skips; cycle: 135 passed.",
    "Affected watch, dispatch, housekeeping, promotion, settle and supervisor suites all reran within the complete npm core/cycle commands. The load-24 dispatch case passed with a real 11-second watcher configuration read and one work prompt; the real 15.2-second Git response and lookup refusal/replacement cases also passed.",
    "npm run test:lanes: 160 passed, zero failures or skips; /private/tmp/eng113-r140-lanes.log.",
    "Final read-only fixture audit: no live members in three captured suite groups, and no Node process invoking this lane's source; /private/tmp/eng113-r140-final-audit.json and /private/tmp/eng113-r140-final-processes.txt.",
    "Final handoff command: node lanes/lane.mjs check, after this report is checked and committed; its gate and log supply the report-inclusive final evidence."
  ],
  "decisions": [
    {
      "text": "Retain the measured-load ps base and timeout-only backoff together with load-aware command, test and product response allowances.",
      "category": "design",
      "why": "Increasing lookup time alone leaves the old 15-second command cap able to kill valid registrations and org commands. The joint policy gives reads and surrounding work time to respond while retaining finite bounds and every identity/refusal guard."
    },
    {
      "text": "Align the native PTY watchdog and inbox teardown response wait with the shared load allowance; use fixed timers only in deliberate watchdog regressions.",
      "category": "tooling",
      "why": "Broad validation exposed these remaining mismatches. Their corrected paths and negative ownership cases pass in the complete offline suite."
    },
    {
      "text": "Report the deadline work done and propose independent PTY fixture lifetime coverage as follow-on work.",
      "category": "design",
      "why": "Every requested offline check is green and the launch symptom no longer blocks validation. The cancelled-gate leaf is a separate containment boundary that an ordinary suite-group runner cannot alone guarantee."
    }
  ],
  "questions": [],
  "challenges": [
    "R-138's stack sample established a pre-initialization non-response, but did not identify its cause. All checks pass after the supervisor's fixture cleanup; no new launch-stall diagnosis or blocking proposal is needed for this lane.",
    "High-load response behavior is proved offline at simulated load 24 with real delayed processes. The historical gate cancellation's exact leak mechanism was not reproduced; the proposed follow-on distinguishes that missing proof from the passing ordinary cancellation cases.",
    "The explicit contrib/settle-watch.mjs compatibility boundary remains in force. Its bytes match main; the maintained supervisor equivalent has the adaptive allowances."
  ]
}
---

All affected module files were included in the complete npm commands; no suite was removed to obtain a pass. The final full run also retained main's newly merged release tests. The first baseline and the intermediate full run identified the PTY/watchdog mismatch and inbox teardown failure respectively; those failures were corrected before the green run cited above.

Today's ordinary dispatch, lifecycle and old watcher leaks warrant retaining the runner's refusal evidence and cleanup checks, but this run found no additional product cleanup change to make in those paths. The PTY leaf does require protection beyond suite-group cleanup: the independent native owner is its only current lifetime guarantee. The proposal requests an OS bound on the fixture leaf and proof through actual gate cancellation, without adopting historical receipt PIDs or broadening signal authority.

The code is committed; this report is checked and committed next, followed by lane check as the last operation. No live acceptance harness, model, live pane mutation, project-wide housekeeping schedule, promotion, push or release was run.
