---
run: R-266
outcome: done
summary: |
  Added awaited-item metadata and dispatch flags so verified promotion and item closure produce one short supervisor notification, optionally naming the plan step they unblock. Routine landings remain silent. Promotion receipts now distinguish interruption and completion notice IDs while preserving uncertain legacy command evidence; verified abandoned-run notices are journaled and dropped. Runless promotion completions now retain an explicit missing-binding diagnostic instead of crashing. Focused offline checks pass; implementation is committed and the requested lane check follows the report commit.
headline: The supervisor now hears when awaited work lands, and stale completion receipts no longer block closure.
blockers: []
proposals: []
learnings:
  - "The two crashing promotion receipts had no run or expectedHead binding: fleet-membership job 7e203ad6-dca3-429b-9059-ac2c7f29e750 and gate-profile job 58c5c2da-a048-469f-bc44-8bbdce18a0a3. Calling authority without a run returned only state, then reading item.closed crashed. Runless jobs cannot authorize item closure."
  - "Promotion producers already distinguish promote:JOB from promote:JOB:complete after interruption. Keep those action receipts separate; report intake and findings follow-ups remain deduplicated per immutable run."
  - "dispatch/test/dispatch.test.mjs needs the managed test/helpers/run.mjs runner to supply its live fixture group leader; direct node --test lacks HERDR_TEST_SUITE_PID."
artifacts:
  - "Implementation commit 08267af: Make autopilot landing notifications and completion receipts reliable"
  - "supervisor/autopilot.mjs"
  - "supervisor/test/autopilot.test.mjs"
  - "dispatch/dispatch.mjs and dispatch/test/dispatch.test.mjs"
  - "supervisor/README.md, supervisor/PROTOCOL.md and dispatch/README.md"
  - "node test/helpers/run.mjs supervisor/test/autopilot.test.mjs supervisor/test/status.test.mjs supervisor/test/delivery.test.mjs dispatch/test/dispatch.test.mjs: 148 passed, zero failures"
  - "Final focused regressions: 16 passed, zero failures; included the real offline awaited promotion cycle, legacy receipt guard, delayed report deduplication and abandoned inbox delivery"
  - "Final requested command after report commit: node lanes/lane.mjs check; its result is retained in .lane/gate.json"
decisions:
  - text: "Use item meta.notify=supervisor and optional meta.notify_step, with --awaited and --awaited-step dispatch flags."
    category: design
    why: "The existing record metadata supplies durable supervisor intent without new event types, stored status or promotion authority. Notification follows verified promotion and record closure through the existing inbox input gate."
  - text: "Keep report receipts per run, index promotion receipts by producer notice ID, and retain legacy uncertain command evidence."
    category: design
    why: "Completion after interruption must proceed independently, while uncertain side effects and duplicate findings follow-ups must not replay."
  - text: "Journal and consume fixed watcher/report notices silently only when abandonment and project/run binding are verified."
    category: design
    why: "Abandoned work should not wake the supervisor; missing, damaged, foreign or unknown evidence retains the existing delivery behavior."
questions: []
challenges:
  - "The recorded crashing jobs were direct runless promotions, not acknowledged run-bound supervisor requests. This change fixes the crash with an explicit diagnostic; it deliberately leaves those historical jobs for inspection rather than inferring an item from a lane name. Verified run-bound completions still close automatically."
---

Read ENG-185, ENG-206 including its abandoned-watcher note, ENG-223, the ask and
the R-266 record context. Inspected both historical crash receipts and their queue
results without mutating the live record or queue.

Mark awaited work with:

```sh
record set ENG-185 meta.notify=supervisor 'meta.notify_step=Cut RC-11'
# Or add these flags to a new dispatch:
--awaited --awaited-step 'Cut RC-11'
```

The resulting delivery is one line:
`[autopilot] ENG-185 landed; unblocks: Cut RC-11`.
The step is optional; `meta.notify=none` clears the request. Dispatch retries do
not re-arm a cleared request. Notification receipts deduplicate the landed run
across queue notices and delayed report notices; inbox receipts retain delivery
and retry ownership. Report intake, closure and promotion still use existing
guarded CLIs with argument arrays. No core dependencies or model calls were added.

Added regressions before implementing each requested behavior. The initial managed
regression pass reproduced nine failures, including both historical crash shapes,
interrupted/completed receipt reuse, abandoned notices, awaited notification and
dispatch metadata. A separate failing regression proved the key migration also
needed to preserve legacy uncertain commands. All now pass.

Verification includes actual offline intake, independent scripted review,
promotion queue integration, lane cleanup, record closure and exactly one awaited
supervisor prompt. Existing routine-cycle, authority, STOP/pause, corrupted-record,
delivery input-gate and status checks passed in the focused four-file run. Final
edge checks also prove no-step notification, notification-text recovery after
interruption, cross-notice deduplication and abandoned inbox consumption without
Herdr delivery. `git diff --check` passed.

The report is checked with `record check`, then committed. The requested fast-tier
`lane check` runs last on that clean committed head; its final result is reported
to the operator and retained by the lane gate. No baseline, promotion/release
suite, live acceptance harness, project housekeeping loop, push or merge was run.
