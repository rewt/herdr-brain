---
run: R-225
outcome: done
summary: |
  Fixed the single Major finding from the rollback-canary review. The restored canary now asks the real scratch supervisor to render the two horizontal footer rules required by the snapshot consumer, waits for its rendering and idle receipt, and restores the shaded composer after consumer teardown. The copied consumer and real PTY delivery checks remain unchanged. Offline regressions using the actual scripted supervisor rendering prove exactly one delivered report with an empty box and deferred delivery with typed input; all 18 focused tests pass.
headline: The rollback canary now renders the footer its legacy consumer requires
blockers: []
proposals: []
learnings:
  - The snapshot consumer requires two horizontal footer rules and removes the legacy prompt glyph when checking for typed input; the shaded Codex composer has no such rules.
  - Composer compatibility must be tested against the actual scripted supervisor output; a separately authored pane-read footer hid the mismatch.
artifacts:
  - "Code and offline evidence commit: 1a785cb on lane/rollback-canary"
  - acceptance/run.mjs
  - acceptance/worker.mjs
  - acceptance/test/legacy-consumer.test.mjs
  - docs/reports/evidence/ENG-167/R-225-red.tap
  - docs/reports/evidence/ENG-167/R-225-final.tap
  - "node test/helpers/run.mjs acceptance/test/legacy-consumer.test.mjs acceptance/test/harness.test.mjs: 18 passed, zero failed, zero skipped"
decisions: []
questions: []
challenges: []
---

Resolved the one Major in `docs/reviews/rollback-canary/ec200cd-r1.md`.
The inherited validation log has 178 passing checks and no failures to repair.
The scope remains the scratch supervisor composer and its offline regression.

For the restored legacy canary only, the harness sends `acceptance-composer
legacy` to the existing scratch supervisor through its real Herdr prompt path.
The worker renders a ruled footer into its PTY and publishes an atomic composer
receipt after reporting idle. Only then does the harness start the existing
scratch-owned consumer. The finalizer stops the consumer and restores the shaded
composer, including on canary failures while the harness is still running.
Other cases and worker roles retain their original shaded rendering.

The snapshot consumer, its lifecycle helper, and the PTY receipt checks are
unchanged. Delivery still requires the actual supervisor input receipt, the
consumer sent log, a drained matching outbox message, and exactly one of each
receipt after consumer teardown. No change was made to `acceptance/cutover.mjs`.

Wrote the failing regression first: both selected cases timed out awaiting a
legacy footer from the actual worker. The fixed regression launches that same
worker, captures its ANSI output after the last clear-screen sequence, and
returns it from an offline Herdr pane-read adapter to the relocated snapshot's
actual `supervisor-events.mjs`. The snapshot's actual `notify-watch.sh` queues
the report. Successful adapter prompts are forwarded to the worker's stdin;
the test asserts exactly one prompt and one actual worker report receipt. Typed
operator text produces an input-box-busy log, zero prompts and receipts, and
retains the queued message. The empty case also checks restoration of the shaded
composer through the current production composer parser.

Offline checks ran through the repository test runner outside the inherited
sandbox so the macOS sandbox regression could apply its own policy. The final
consumer and harness tests passed 18/18, including the sandbox check and the
existing shaded-composer test. Syntax and diff whitespace checks passed. No live
harness or skip-live pass ran; release cases 19 and 20 remain deferred validation.

This report is checked before its own commit. The requested final operation is
`node lanes/lane.mjs check`; its result will be returned in the session output
because updating the report afterward would violate the requested ordering.
