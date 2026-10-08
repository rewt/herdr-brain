---
run: R-327
outcome: done
summary: |
  Confirmed that inherited slot wait settings made the nested-holder refusal probe wait until spawnSync returned null. All test-slot fixtures now build child environments from a shared base that removes both current and legacy slot variables before scratch overrides; synchronous probes have explicit bounds. The implementation and reproducible evidence are committed in e30e441.
  All 105 test-slot cases passed both plainly and inside an outer scratch slot carrying the merge-batch wait and retry environment. The shared promotion fixture's 13 other cases also passed. This report is checked and committed before the required final lane check, whose fast-tier command runs the two requested files inside a scratch outer slot and writes the final gate receipt.
headline: Gate watchdog tests now pass inside a held scratch slot with the merge batch environment
blockers: []
proposals: []
learnings:
  - 'Removing inherited slot tokens is insufficient: both MONITOR_TEST_SLOT_WAIT_SECONDS and BCH_CLOAK_TEST_SLOT_WAIT_SECONDS must be scrubbed or a refusal probe can wait for hours.'
  - 'Shared promotion fixtures also need the scrubbed slot environment before applying their own scratch paths, including removal of MONITOR_TEST_SLOT_TIMEOUT_RETRIED so retry tests retain their own allowance.'
artifacts:
  - 'Implementation commit: e30e441'
  - 'Branch: lane/gate-watchdog'
  - test/helpers/test-slot-env.mjs
  - docs/reports/evidence/ENG-274-R327/reproduce.mjs
  - docs/reports/evidence/ENG-274-R327/nested-before.log.gz
  - docs/reports/evidence/ENG-274-R327/plain.log.gz
  - docs/reports/evidence/ENG-274-R327/outer.log.gz
  - docs/reports/evidence/ENG-274-R327/shared-fixture.log.gz
  - docs/reports/ENG-274-gate-watchdog-R-327.md
  - /Users/rewt/development/rewt/.org/runs/R-327/report.md
  - '.lane/gate.json: receipt written by the final lane check after the report commit'
decisions:
  - text: Scrub both slot-variable namespaces in every test-slot fixture before adding scratch or deliberate nested values.
    category: tooling
    why: Tests must own their slot, wait and retry context independently of the enclosing merge gate.
questions: []
challenges: []
---

The original nested-holder case failed unchanged inside a scratch outer gate:
`node test-slot/test-slot.mjs run outer --project-common <scratch>
--timeout-seconds 45 -- node --test --test-name-pattern='nested gates preserve'
test-slot/test/watchdog.test.mjs`. Its outer environment set both slot paths to
the scratch lock, both current and legacy wait settings to `7200`, and the
retry marker to `1`; the wrapper supplied both slot tokens to its command.
The probe returned `null`, expected `75`, after 15.186 seconds, matching the
batch failure. Its scratch environment removed the tokens and retry marker,
but retained the wait settings. It therefore waited for the still-live nested
command's scratch slot instead of refusing immediately. After isolation, the
same holder assertions pass without modification.

`testSlotEnvironment` removes every `MONITOR_TEST_SLOT_*` and
`BCH_CLOAK_TEST_SLOT_*` value without changing the source environment. Watchdog,
host-profile, cancellation conformance, kernel-source and host-slot tests use
it directly; train conformance uses it through the shared promotion fixture.
Each fixture then sets scratch paths or explicit test settings. Intentional
nested probes inherit only their own scratch holder's environment. Direct and
generated synchronous probes, including Git and shared fixture commands, now
have explicit bounds. No production code or expected holder behavior changed.

Focused verification:

- The lane already contained main `da07cc67`; no rebase was needed. Main has no
  watchdog test file. Before editing existing tests, an archived main checkout's
  unmodified host-slot file passed all 50 cases. Its host-profile file passed
  all 11 cases outside the sandbox. The other three main files passed their
  assertions; the seatbelt case skipped under the nested worker sandbox.
- `node --test test-slot/test/*.test.mjs`: 105 passed, no skips, 22.815 seconds.
- `node docs/reports/evidence/ENG-274-R327/reproduce.mjs
  test-slot/test/watchdog.test.mjs test-slot/test/test-slot.test.mjs
  test-slot/test/conformance.test.mjs test-slot/test/gate-profile.test.mjs
  test-slot/test/no-setuid.test.mjs test-slot/test/train-conformance.test.mjs`:
  105 passed, no skips, 26.310 seconds. The outer gate exited zero after one
  attempt and released its scratch slot. This replay carries both 7200-second
  wait variables, the retry marker and wrapper-generated tokens.
- `node --test promote/test/conformance.test.mjs
  promote/test/metrics-profile.test.mjs`: 13 passed, no skips.
- `git diff --check` passed.

Plain and outer profile verification used approved host execution for the
existing disposable local socket, PTY and seatbelt probes. An initial main
profile attempt inside the worker sandbox could not perform its socket/PTY
check; the host run passed. Every slot was scratch. No real host slot, broad
promotion/release tier, live acceptance harness or model was used.

The final command, after report validation and its commit, is
`node lanes/lane.mjs check --cmd 'node docs/reports/evidence/ENG-274-R327/reproduce.mjs'`.
The replay defaults to the two requested files (76 cases) and the lane uses its
fast validation path. This report does not claim that final receipt already
exists.
