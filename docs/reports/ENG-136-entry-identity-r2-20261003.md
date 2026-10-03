---
run: R-191
outcome: done
summary: |
  Fixed the three Moderates from the round-three entry identity review. Automatic
  adapters preserve supervisor recognition on interactive resume while retaining
  worker guards and headless bypass. Linux process identities now include a
  validated boot UUID and start tick, remaining strings through dispatch and
  entry recovery record writes. Regression tests were written and failed first;
  the focused files passed 93 tests with one environment skip, and the added
  legacy-owner safety regression passed separately. The final lane check runs
  after this checked report is committed; supervisor review follows directly.
headline: Supervisor resumes and Linux process recovery now preserve owner identity
blockers: []
proposals: []
learnings:
  - Linux boot-relative start ticks need a boot UUID for durable owner comparison and textual record metadata.
  - Live legacy Linux owners with only a start tick remain unknown until the PID is confirmed absent.
  - Interactive resume must preserve inherited worker guards as well as durable supervisor receipt recognition.
artifacts:
  - branch lane/entry-identity
  - commit a9006b5d553b6b35675d0072e7fe2be0169b3506
  - docs/reviews/entry-identity/f6d9041-r3.md
  - discovery/launch.mjs
  - discovery/adapters/claude.mjs
  - discovery/adapters/codex.mjs
  - supervisor/session-hooks.mjs
  - lib/processes.mjs
  - lib/process-owner.mjs
  - supervisor/test/entry.test.mjs
  - dispatch/test/dispatch.test.mjs
  - test/no-setuid-processes.test.mjs
  - /private/tmp/ENG-136-r2-red.tap
  - /private/tmp/ENG-136-r2-green.tap
  - /private/tmp/ENG-136-r2-legacy-red.tap
  - /private/tmp/ENG-136-r2-legacy-green.tap
  - .lane/gate.json produced by the final lane check
decisions: []
questions: []
challenges: []
---

The automatic adapters distinguish interactive `claude --resume`,
`claude --continue` and `codex resume` from utility/headless passthrough.
Resume preserves the environment, including explicit worker role and entry
bypass; it does not grant a supervisor role or recreate a receipt. Tests run
both adapters through a fake native executable and the real SessionStart hook,
with simulated TTY streams, testing durable receipts without launch variables,
inherited supervisor bindings, explicit worker/bypass guards, noninteractive
resume, and headless arguments combined with resume. Existing headless cases
also remain green.

The Linux source emits `boot-uuid:start-tick` for both identity-only and full
lookups. It validates `/proc/sys/kernel/random/boot_id`, keeps the existing
before/after stat race check, and reports missing, denied or malformed boot
identities as unavailable. No boot-read failure is mistaken for an absent PID.
This source format flows unchanged through watcher receipts, dispatch journals,
locks and both existing `record set` call sites; no core metadata coercion change
is needed. Offline Linux fixtures exercise actual record CLI round trips in
dispatch and entry recovery, matching births, changed ticks, and identical
PID/tick values across different boots. Legacy tick-only owners with present
PIDs require inspection rather than being displaced by the format upgrade.

Validation before the implementation commit:

```sh
node test/helpers/run.mjs supervisor/test/entry.test.mjs dispatch/test/dispatch.test.mjs test/no-setuid-processes.test.mjs
node --test --test-name-pattern='Linux durable owner|Linux legacy tick-only' test/no-setuid-processes.test.mjs
```

The three-file run passed 93 tests, failed zero and skipped one existing nested
seatbelt check because the host sandbox cannot nest. The subsequent targeted run
passed both boot/legacy-owner tests, with 12 tests excluded by its name filter.
The first three-file red run reproduced all six new failures before production
changes; its teardown also reported an unavailable native snapshot audit. The
green three-file run exited zero, including fixture cleanup. The legacy test
failed first with a missing expected exception. Syntax checks on changed modules
and `git diff --check` passed.

Linux behavior is covered through injected `/proc` fixtures on this macOS host;
no actual reboot or native model session was exercised. No model calls, hook
trust changes, full suite, promotion, push or live acceptance harness ran.

The report is checked with the canonical record CLI before its commit. The last
operation is `node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs
supervisor/test/entry.test.mjs dispatch/test/dispatch.test.mjs
test/no-setuid-processes.test.mjs'` against the final committed tree. Its result
is retained in `.lane/gate.json` and the lane validation receipt; it includes the
additional legacy regression for a final total of 95 tests.
