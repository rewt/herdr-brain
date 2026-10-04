---
run: R-241
outcome: done
summary: |
  Made the offline lesson fixtures wait for ordinary banner-exit sessions to finish naturally before the harness observes completion and tears them down. The stand-ins flush their screen before exiting, fixture polling uses loadTimeout, and installed-entry PTYs use the load-aware scenario allowance. All three requested batches of six concurrent suites passed: 18 suites, 234 checks, zero failures or skips. The gate still rejects banner exits and native exits with retained prompts while adapter cleanup is blocked. Implementation and stress evidence are committed; the final focused lane check follows this checked report commit.
headline: Banner exit tests now wait for completed sessions and pass under concurrent load
blockers: []
proposals: []
learnings:
  - "A native exit receipt precedes transport and adapter completion. Tests asserting the adapter's scripted exit code must wait for the PTY close event before harness teardown can signal that session."
  - "Installed-entry fixtures are compound scenarios; use the load-aware scenario child allowance and loadTimeout for their completion polling."
artifacts:
  - "Implementation and evidence commit: 7c2a712 (Wait for natural lesson fixture exits under load)"
  - "Branch: lane/banner-flake"
  - acceptance/test/lessons.test.mjs
  - docs/reports/ENG-183-banner-flake-evidence-20261004/stress.mjs
  - docs/reports/ENG-183-banner-flake-evidence-20261004/summary.json
  - "18 TAP logs: docs/reports/ENG-183-banner-flake-evidence-20261004/round-{1,2,3}-copy-{1,2,3,4,5,6}.tap"
  - "Stress command: node docs/reports/ENG-183-banner-flake-evidence-20261004/stress.mjs"
  - "Focused command: node test/helpers/run.mjs acceptance/test/lessons.test.mjs"
  - "Final lane check: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs acceptance/test/lessons.test.mjs'"
  - ".lane/gate.json records the final check against the report commit"
decisions: []
questions: []
challenges: []
---

Read the task brief, run brief, repository instructions and `record show ENG-183`,
including the note that both transports recurred under release-tier load.

The fixture previously released its native-receipt wait when `native.done.json`
and retained output existed. That receipt is written by `entry-native.mjs` on
the actual UI child's `exit` event. The transport, installed adapter and outer
`entry-session.mjs` still have to finish. The harness rejects the native exit and
immediately writes its stop marker in `finally`; the session polls that marker
and sends SIGTERM, followed by a bounded SIGKILL escalation. The banner tests
asserted the outer adapter completion code, so this teardown could race the
remaining natural exit. The fixture also had a fixed 12-second polling deadline
and used the generic 15-second child allowance for the compound installed-entry
scenario. The historical failure notes do not identify the particular signal;
the code exposes this ordering race independently of that missing trace.

Ordinary exit fixtures now await the tracked PTY child's close event before
returning from the native-entry wait. This proves session completion before
harness teardown and drains retained output without a chosen sleep. The child
remains bounded by `spawnScenarioChild`'s load-aware 35-second base allowance;
the polling deadline now uses `loadTimeout(12000)`. Stand-ins exit from the
stdout-write callback, and banner tests assert the scripted exit code and null
signal in both the native and adapter completion receipts.

The four deliberately blocked-cleanup cases bypass this natural-session wait.
They still prove that both installed transports reject native exit codes zero
and one while the adapter completion file is absent, even with a retained
interactive prompt. Production readiness checks and teardown behavior were not
changed. All gate-failure cases still assert FAIL and a non-ready release gate;
owned workspace closure and empty producer receipts remain checked.

Validation:

- Focused offline test: 13 passed, zero failed, zero skipped.
- `node docs/reports/ENG-183-banner-flake-evidence-20261004/stress.mjs` launches
  `node test/helpers/run.mjs acceptance/test/lessons.test.mjs` six times
  concurrently per round, then waits for all six before starting the next round.
  Three rounds completed: each had six zero exits and 78 passing checks.
  Total: 18 suites, 234 passed, zero failed, zero skipped, zero cancelled.
  This includes 72 banner-exit and 72 blocked-cleanup prompt-exit checks.
- `summary.json` records timestamps, host load, individual exit results and
  counts. All 18 raw TAP logs and the exact stress driver are committed.
- Reviewed the diff; `git diff --check` and the staged equivalent passed.

The successful macOS PTY/sandbox fixtures ran outside the enclosing workspace
sandbox. An initial sandboxed attempt was stopped after nested `sandbox-exec`
was refused with `sandbox_apply: Operation not permitted`. Tests used offline
stand-ins and scratch projects; no model, live harness, full project suite,
promotion suite, lanes suite or skip-live harness pass ran.

The implementation is ready for the normal independent harness review. After
`record check` and the report commit, the final operation is the focused lane
check listed above; its result and exact committed head belong to `.lane/gate.json`.
