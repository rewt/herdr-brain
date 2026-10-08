---
run: R-351
outcome: done
summary: |
  Rebased lane/memory-before-locks onto main ef21d58e, which includes the gate watchdog. Retained watchdog limits, history-based host envelope sizing and timeout outcomes alongside memory/STOP waits before resource acquisition and bounded held memory re-checks. The required promote tests exposed a resumed STOP regression; committed e21e2b16 restores the train's existing checkpoint reconciliation and STOP guards. Final memory/gate-profile coverage passes 30/30; all 128 promote cases have passing coverage across the full run and the isolated 24/24 rerun of its sole environment-related teardown failure. This report is checked and committed before the final fast lane check, whose result is retained in the lane gate receipt.
headline: Promotion memory waits now work with the gate watchdog and preserve stopped-batch recovery.
blockers: []
proposals: []
learnings:
  - A resumed train stopped before execution must use its existing reconciliation and STOP guards; treating its saved attempt as a fresh pre-train refusal leaves it interrupted indefinitely.
  - Clear ORG_DIR and HERDR_AGENT_NAME in the test process itself. Scrubbing fixture child environments alone does not isolate inboxPath's in-process record discovery during teardown.
artifacts:
  - "Branch lane/memory-before-locks, rebased onto ef21d58e"
  - "Rebased implementation 5dcb81e0: Wait for promotion memory before locks and bound held rechecks"
  - "Commit e21e2b16: Preserve STOP recovery after promotion memory prechecks"
  - "docs/reports/ENG-293-R-351-rebase.md"
  - "docs/reports/evidence/ENG-293-R351/checks.json and compressed TAP logs"
  - "/Users/rewt/development/rewt/.org/runs/R-351/report.md"
decisions:
  - text: Let a resumed unprofiled STOP reach the train's existing guarded recovery path, while memory-pressure refusals continue to preserve prior checkpoints.
    category: tooling
    why: STOP must complete ordinary refusals or reconcile already integrated work without replacing durable attempts; memory pressure must still relinquish held locks promptly.
questions: []
challenges: []
---

The rebase conflict was confined to imports in
`test-slot/test/gate-profile.test.mjs`; both watchdog and memory fixture imports
were retained. `promote/host-gate.mjs` merged cleanly. Its diff against main adds
only the memory checks and coded refusal metadata, preserving the watchdog's
declared limits, history key, full bisection envelope and timeout handling.

The first full promote run passed 127/128 cases and exposed the existing
`resuming prepared capture refuses stop input and drains the remaining lanes`
regression introduced by the earlier memory fix. No tests were changed. The
correction delegates saved STOP attempts to the train's existing guards and
reconciliation; fresh refusals and held memory-pressure handling remain intact.
The focused rerun passed eight cases, and the subsequent full run passed the
STOP recovery case and every other product assertion.

Final verification at e21e2b16:

- Memory and gate-profile tests: 30 passed, zero failed or skipped. Coverage
  includes external/slot/project lock release, coded refusal and re-enqueue,
  STOP, clearing pressure, inner limits, history-derived envelope sizing,
  three-lane bisection and host timeout outcomes.
- Full promote tests: 127 passed, one fixture teardown failed because inherited
  ORG_DIR made its in-process fallback inspect the real inbox path. The owner
  argv guard refused before signaling; the stale-worker test had no sender.
  Rerunning the complete affected file with ORG_DIR and HERDR_AGENT_NAME removed
  passed all 24 cases. All 128 requested promote cases therefore have passing
  coverage on the corrected code; the unsanitized invocation itself exited 1.
- Focused STOP/memory/receipt rerun: eight passed, 46 unselected cases skipped.
- `git diff --check`: passed.

Evidence retains both failures and their passing reruns, with commands and exit
codes in `checks.json`. Fixtures use scratch Git projects, fleet registries,
slots and external locks, fake native measurements and offline delivery adapters.
No host test slot, baseline, npm test, promotion/release tier, live acceptance
harness, promotion, push or project housekeeping loop was run.

After validating and committing this report, the final operation is
`env -u ORG_DIR -u HERDR_AGENT_NAME node lanes/lane.mjs check --tier fast`.
Its gate receipt and log carry the final report commit's validation result.
