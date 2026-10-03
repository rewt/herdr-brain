---
run: R-147
outcome: done
summary: |
  Confirmed that retained Herdr subscription replay caused the release focus monitor's startup timeout.
  Startup now completes after quiet polling or the verified finite replay bound, even while the operator keeps navigating.
  Offline regressions still catch a transient harness-caused focus move immediately after readiness.
  Baseline npm test, the complete post-change retry, fast checks and acceptance offline tests passed; no acceptance harness pass was run.
headline: The release focus monitor can start while the operator keeps navigating.
blockers: []
proposals:
  - role: engineer
    title: Publish promotion test PID markers atomically
    why: The direct-gate promotion fixture waits for marker existence before reading its PID; a read during file creation produced PID zero and failed the first post-change npm test despite a passing isolated retry.
learnings:
  - "Two read-only subscriptions started 450 ms apart replayed the same 21-event prefix while global focus stayed unchanged; 25 consecutive events also matched the earlier release trace."
  - "Herdr 0.8.2 protocol 20 starts pane.focused subscriptions at cursor zero and retains at most 512 lifecycle events across all kinds."
  - "Candidate work starts only after focus-monitor readiness, so pre-readiness navigation can remain diagnostic without hiding a candidate focus move."
artifacts:
  - "Implementation commit: a480b13c53620d5d3fdbb753bdca07168eb1a55c"
  - acceptance/focus.mjs
  - acceptance/test/focus.test.mjs
  - acceptance/README.md
  - docs/reports/ENG-120-focus-startup-evidence-20261003/replay-probe.json
  - docs/reports/ENG-120-focus-startup-evidence-20261003/rc2-focus-trace.jsonl
  - "npm test baseline: passed; original post-change run: one fixture failure; complete retry: passed"
  - "npm run test:fast: 140 passed"
  - "npm run test:acceptance: 135 passed"
  - "Focused regressions: 17 passed"
  - docs/reports/ENG-120-focus-startup-evidence-20261003/test-after-accounting.json
  - ".lane/gate.json: final configured lane check runs after the report commit"
decisions:
  - text: Bound startup replay using the verified native retention limit and retain the quiet polling shortcut.
    category: tooling
    why: At most 512 matching receipts exhaust the initial retained history even with continuous live navigation; no candidate work runs before readiness and every subsequent event remains observed.
questions: []
challenges: []
---

The source was **Herdr's retained subscription replay**. The release trace contains
47 focus receipts at roughly 100 ms intervals before the five-second startup
failure. A read-only comparison on the same server started two subscriptions
450 ms apart: they received an identical 21-event prefix while global focus
remained `wHD:pR`. The first subscription's 25 events exactly matched release
trace entries 8–32. This establishes replay of historical navigation; a chatty
pane or the operator switching panes during those five seconds does not explain
the repeated historical sequence. The probe sent only ping, pane.current and
events.subscribe requests, and closed its own sockets.

The native [subscription implementation](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/api/subscriptions.rs)
starts its internal cursor at zero. The [event hub](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/api/event_hub.rs)
retains at most 512 events across all lifecycle kinds, and the
[polling loop](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/api/server.rs)
delivers one matching event per 100 ms cycle. Thus, after at least 512 focus
receipts, no initial retained focus event can remain, regardless of ongoing
operator navigation. The wire envelopes expose neither a timestamp nor a cursor;
the monitor uses this finite bound rather than guessing whether each startup
receipt is historical or live.

Startup retains all pre-readiness receipts as diagnostics and takes the global
baseline after either four quiet polling cycles or the replay bound. The busy
path checks the ping version and protocol before relying on that bound. An
unknown busy server remains an explicit harness limitation. The startup response
allowance is now 60 seconds, adjusted for machine load, with a larger parent IPC
allowance. At native cadence, a continuously busy stream may take roughly
51 seconds to exhaust the bound; short replay retains the quiet shortcut.
`startupDrain` records the reason, server identity and elapsed time.

The runner already waits for readiness before candidate work. After startup,
the monitor continues observing every focus event alongside global samples,
including transient owned or destination-correlated moves and cleanup. External
navigation continues to re-baseline normally. The monitor remains read-only and
never restores focus.

Validation passed (the initial post-change failure and all skips are accounted for below):

- `npm test` baseline passed. The complete post-change retry passed both core and cycle phases.
- `npm run test:fast`: 140 passed.
- `npm run test:acceptance`: 135 passed.
- Focused offline regressions: 17 passed, including continuous navigation beyond
  the former five-second deadline, an immediate transient harness move between
  unchanged samples, ongoing operator-only activity, and rejection of an unknown
  server's replay bound.
- `git diff --check`.


The original `.lane/test-after.log` exited **1**: the copied-entry phase passed
2 tests; core and modules passed 697, failed 1 and skipped 11. Because core failed,
the original command did not enter the cycle phase.

The sole failure was test **708**, “direct gate overlapping queued cleanup
prevents queue and direct close from deleting its lane,” in
`promote/test/promote.test.mjs:462`: `registerProcess` rejected
`invalid fixture pid: 0`. The fixture writes `String(process.pid)` with
`writeFileSync`; its reader waits only for `existsSync(ready)` before converting
the contents to a number. File existence can precede completion of that write,
and `Number('')` is zero. This is the inferred creation/read race, supported by
the positive-PID-only writer and failure location. No focus-monitor code is
imported by this test. The entire promotion file passed **22/22** when rerun alone.
The subsequent complete `npm test` retry passed both phases. A follow-on proposal
covers atomic marker publication; process ownership checks were not weakened.

Every skip in the original post-change log is listed here. These are explicit
applicability or optional-dependency skips, not passing assertions; the same
coverage limitations apply to the completed retry.

| Test | Coverage skipped | Reason |
| --- | --- | --- |
| 16 | Console app startup and initial configuration | Optional console dependencies are not installed. |
| 65 | MCP stdio integration | Optional MCP dependencies are not installed. |
| 575 | Real alternative sandbox write and network boundaries | `MONITOR_TEST_ALTERNATIVE` is not selected; requires an alternative provider outside a nested sandbox. |
| 576 | Real bounded Git filters through allocation, commit, check and promotion | `MONITOR_TEST_ALTERNATIVE` is not selected. |
| 577 | Real main-mode alternative guard, linked records and writable native runtime | `MONITOR_TEST_ALTERNATIVE` is not selected. |
| 581 | Native main-mode record and coordination write denials, default record | `MONITOR_TEST_SANDBOX` is not selected. |
| 582 | Native main-mode write denials, linked record and event log | `MONITOR_TEST_SANDBOX` is not selected. |
| 648 | Linux asynchronous Unix-socket and host-socket denials | Requires a Linux kernel with io_uring enabled; this host is macOS. |
| 655 | macOS nonempty-file copy and redirected temporary-root refusal | Actual macOS/native provider is not selected for host-only proof. |
| 656 | Codex nonempty-file copy and redirected temporary-root refusal | Actual macOS/native provider is not selected for host-only proof. |
| 672 | Real native sandbox lane validation, promotion, outside writes and Git metadata | `MONITOR_TEST_SANDBOX` is not selected as a native Codex executable. |

The saved `test-after-accounting.json` retains the exact failure diagnostic,
all eleven original test names and skip reasons, and retry results.

Restricted test attempts could not inspect fixture processes (`ps EPERM);
the checks passed with approved local fixture access. The live harness was never
run, and zero `--skip-live` passes were used. The saved replay probe was a separate
read-only investigation.

The implementation and evidence are committed first. This report is checked and
committed before the final configured `node lanes/lane.mjs check`, which records
the committed HEAD in `.lane/gate.json`. That final gate is the last operation;
no promotion or release is part of this run.
