---
run: R-169
outcome: done
summary: |
  Release acceptance response deadlines now scale with measured load through lib/deadline.mjs. The runner, copied-command sandbox, report waits, native receipt waits, worker runtime, focus startup and cleanup drains have finite scaled allowances; deliberate watchdog timers and observation cadence are retained and justified in acceptance/DEADLINES.md.
  Offline cutover regressions pass at simulated load 24, including real scratch naming/tidy scripts, eleven-file rollback and contrib retirement/restoration. A real sandbox-exec child that ignores SIGTERM terminates at the scaled deadline; normal-load non-response remains FAIL and measured heavy-load non-response remains PENDING, never a passing gate.
  All acceptance offline files were exercised, followed by passing affected-file and boundary reruns after fixture corrections. Evidence is committed. No live release harness or completed skip-live gate was run; the missing-tool test invokes skip-live but stops in preflight. RC-3's recorded case load does not support the brief's contention diagnosis, so that discrepancy is proposed as separate follow-up work.
headline: Release gate deadlines now scale with measured load and hung children remain bounded
blockers: []
proposals:
  - role: engineer
    title: Diagnose copied dispatch stalls in the next release gate using the retained low-load evidence
    why: RC-3 case 19 recorded a one-minute peak of 2.11 on 18 CPUs, while copied dispatch timed out with empty stdout and stderr. ENG-113's capped divisor still produces factor one at that load, so scaling alone does not establish why those native calls stalled. Case 20 inherited case 19's failure. Inspect the retained evidence and the next release candidate's gate; do not repeat a live gate in this lane.
learnings:
  - Load 24 with at least four CPUs produces factor six under lib/deadline.mjs, so a 60000ms child base receives 360000ms.
  - Copied acceptance workers are flat scratch modules; they need lib/deadline.mjs copied beside them as deadline.mjs rather than a relative import escaping the scratch root.
  - A synchronous child ignoring SIGTERM can defeat a nominal timeout; the acceptance command wrapper defaults to SIGKILL, and the real sandbox regression checks that behavior.
  - RC-3 case 19 measured peak load 2.1103515625 and case 20 peak 1.02783203125; both were below the capped four-CPU divisor and were recorded as product failures.
artifacts:
  - "branch: lane/gate-timeouts"
  - "implementation and evidence commit: d293610"
  - "acceptance/DEADLINES.md"
  - "acceptance/test/deadlines.test.mjs"
  - "docs/evidence/ENG-134/rc3-timeouts.json"
  - "docs/evidence/ENG-134/acceptance-offline.log"
  - "docs/evidence/ENG-134/acceptance-fixes.log"
  - "docs/evidence/ENG-134/deadline-boundaries.log"
  - "node test/helpers/run.mjs acceptance/test/*.test.mjs"
  - "node test/helpers/run.mjs acceptance/test/deadlines.test.mjs acceptance/test/cutover.test.mjs acceptance/test/load-round2.test.mjs acceptance/test/security.test.mjs acceptance/test/verification.test.mjs"
  - "node test/helpers/run.mjs acceptance/test/deadlines.test.mjs acceptance/test/load.test.mjs"
  - "Final lane validation: node lanes/lane.mjs check, after this report is checked and committed; receipt at .lane/gate.json"
decisions:
  - text: Sample each operation once and use the shared load allowance without retries or a deadline that keeps extending.
    category: design
    why: Contention gets additional response time while genuine non-response stays finite and existing product/safety failure classifications retain precedence.
  - text: Retain fixed deliberate watchdog stimuli, idle-grace semantics and observation cadence.
    category: prover
    why: These construct the behavior under test or determine measurement fidelity; they are not responsiveness allowances.
questions: []
challenges:
  - "The brief attributes RC-3 cases 19 and 20 to contention, but the retained case evidence reports low one-minute load; a separate native stall remains unproven. docs/evidence/ENG-134/rc3-timeouts.json preserves the original failure details and load windows."
---

The ask and record context were read, including `record show ENG-134`, the
canonical `.git/release/RC-3.log`, and ENG-113's `lib/deadline.mjs`.

The runner now uses `loadAwareCommand` for every synchronous command, including
`runCopy`'s sandbox-exec path. It records the effective allowance in each command
receipt. Polling uses the operation's sampled factor, and scratch subprocesses
use the same native deadline implementation. Receipt polls were changed from
fixed attempt counts to elapsed scaled deadlines. Runtime expiry of a real
session now also escalates from TERM to KILL after its scaled grace.

The acceptance tests were written before implementation. The new offline
cutover tests use actual relocated inventory scripts and the shared command
wrapper. Their virtual 70-second contention response would fail under the old
60-second allowance; at load 24 the allowance is 360 seconds. Real copied naming
and tidy scripts run inside sandbox-exec against scratch stand-ins, and the
filesystem checks cover all eleven switch edits, exact bytes/modes on rollback,
late-log recovery, negative caller refusal and contrib restoration. These tests
prove the response-window and offline cutover behavior; they do not claim live
PTY dispatch, switched model sessions, or a newly green RC-3.

The first offline run completed with 123 passed and 5 failed. Fixture corrections
removed accidentally introduced imports from generated scripts and canonicalized
the cutover scratch path so the naming script's PWD premise matched. The affected
five files then passed 41/41 tests; the final deadline and existing load-boundary
files passed 15/15. The deliberate 100ms stalled-child watchdogs retain their
fixed timers. The real new hung sandbox-exec proof passes at both load 24
(300ms allowance) and normal load (50ms allowance), including a child that ignores
SIGTERM. The initial failed TAP log and passing reruns are retained together.

The test runner needs process ownership inspection, so offline runs used sandbox
escalation for its own `ps`/cleanup checks. No model, live Herdr mutation,
project-wide housekeeping, baseline, npm test, test:promotion or test:lanes was
run. The existing security preflight test names missing rg and exits before
candidate resolution; it does not execute a release gate. The final lane check
uses the configured fast tier, as required by the ask.

The complete diff was reviewed before committing the implementation. The report
is checked with the record CLI and committed separately; lane check is the final
action, with its validation receipt bound to that final commit.
