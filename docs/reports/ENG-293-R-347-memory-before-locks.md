---
run: R-347
outcome: blocked
summary: |
  Implemented and committed the memory-before-locks change in f5017258. Profiled batches wait for memory and STOP before the external lock and host slot; unprofiled batches wait before the project promotion lock. Held re-checks have a five-second allowance and deliver PROMOTION_MEMORY_PRESSURE refusals without gates, bisection or Git changes, permitting re-enqueue after pressure clears. All 29 focused memory, receipt and gate-profile tests pass, and all four selected unprofiled memory/STOP cases pass. Rebased onto current main, but the required watchdog dependency has not landed; completion after its merge still requires a rebase and focused compatibility check. This report precedes its record check, report commit and final fast lane check.
headline: The memory lock fix is validated and awaits the watchdog merge.
blockers:
  - ENG-274 remains unmerged. Main is 0d71dabd, lane/gate-watchdog is 6a6abfd9, and the canonical promotion queue has no pending or current batch. The ask requires that dependency to land first and this lane to rebase onto it before finishing.
proposals: []
learnings:
  - Profiled promote-batch runs already hold the external kernel lock and host slot when the lane CLI starts; an untimed memory wait must belong to host-gate before acquisition rather than the lane CLI.
  - Gate-profile scratch-slot signal tests use direct node --test execution, as package.json test:slot specifies. The generic test/helpers/run.mjs fixture policy disables detachment and invalidates the slot wrapper's process-group signal forwarding, causing fixture shutdown timeouts; direct execution passes the same cases.
artifacts:
  - "Implementation commit f5017258"
  - "Branch lane/memory-before-locks"
  - "promote/memory-gate.mjs"
  - "lib/memory.mjs"
  - "lanes/lane.mjs"
  - "promote/host-gate.mjs"
  - "promote/promote.mjs"
  - "test-slot/test/gate-profile.test.mjs"
  - "promote/test/train.test.mjs"
  - "promote/test/memory-gate.test.mjs"
  - "test/memory.test.mjs"
  - "test/helpers/promotion-memory-fixture.mjs"
  - "docs/reference/memory-gate.md"
  - "docs/reports/ENG-293-R-347-memory-before-locks.md"
  - "/Users/rewt/development/rewt/.org/runs/R-347/report.md"
decisions:
  - text: Use an unlimited pre-acquisition wait and a fixed five-second allowance for each held memory re-check, returning a coded per-lane refusal on persistent pressure.
    category: tooling
    why: Memory pressure must not monopolize promotion resources; short transient pressure can clear without abandoning the queued batch.
questions: []
challenges:
  - The prerequisite watchdog merge is absent from main despite the ask saying it lands first. The implementation and tests are preserved in the lane; this run cannot promote that other lane or claim post-watchdog validation.
---

The host adapter now checks memory and canonical STOP before acquiring the
external fcntl lock or test slot. It re-checks with a bound after acquiring the
external lock and again after the slot is granted, before starting the lane CLI.
The lane CLI validates the declared host profile, skips the untimed wait for a
profiled batch, and performs a bounded check under the project promotion lock.
Unprofiled batches retain an untimed wait before that lock.

The shared helper maps a bounded wait to `PROMOTION_MEMORY_PRESSURE`. The
five-second wait uses a monotonic clock and one-second sampling; native probes
retain their existing two-second response allowances. STOP takes precedence,
including after a clearing sample. Fresh batch members receive ordinary coded
refusals and queue notices. No candidate preparation or validation runs, no red
evidence or bisection is recorded, and main and lane tips remain unchanged. A
receipt with any earlier attempt retains its recovery checkpoint rather than
overwriting possibly integrated work with a new refusal.

Validation used fake native measurements, scratch Git projects, scratch fcntl
locks and slots, isolated fleet data, and a fake Herdr delivery adapter. Local
socket/PTY access required approved command escalation. The requested cases
cover pressure at startup with no held resources; pressure after the external,
slot and project locks; timeout release and coded refusal; pressure clearing;
STOP; actual refusal delivery; and successful re-enqueue.

- `NODE_OPTIONS=--import=$PWD/test/helpers/memory-fixture.mjs node --test test-slot/test/gate-profile.test.mjs test/memory.test.mjs promote/test/memory-gate.test.mjs`: 29 passed, none skipped.
- `node test/helpers/run.mjs --file-timeout=120000 --suite-timeout=180000 --test-name-pattern='memory|STOP during' promote/test/train.test.mjs`: four selected cases passed, 47 unselected cases skipped.
- `git diff --check`: passed before the implementation commit.
- `git rebase main`: up to date at 0d71dabd; the watchdog prerequisite is absent.

Initial sandboxed host fixtures refused local sockets. A broader generic-runner
attempt also hit scratch-holder shutdown timeouts because its fixture policy
forces `detached=false`; the direct command above preserves the real slot
process groups and passes all cases. No production locks or host test slot were
acquired, and no baseline, promotion tier, release tier or live harness ran.

After the watchdog lands, rebase this lane onto main, resolve any host-adapter
overlap without weakening the watchdog envelope, and rerun these focused checks.
The final command for this run, after checking and committing this report, is
`node lanes/lane.mjs check --tier fast`; its outcome is retained in the lane gate
receipt. Then this run stops.
