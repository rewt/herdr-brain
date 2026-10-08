---
run: R-330
outcome: done
summary: |
  Added model-free alerts for newly opened human questions across fleet records.
  Durable record cursors and per-question channel receipts prevent confirmed alerts
  from repeating on restart and retry failed channels within the existing caps.
  Default payloads contain metadata and blocking counts; operator-local question_text
  opt-in adds sanitized, truncated question and recommendation text. Baseline scans
  skip existing questions and report the count. All focused offline tests passed.
headline: New operator questions now reach the steward alert channels
blockers: []
proposals: []
learnings:
  - Confirmed question deliveries require receipts outside the routing journal's seven-day retired-event retention; record cursors preserve deduplication after answered receipts compact away.
  - Messages and macOS notification sends cannot atomically commit a local receipt; an interrupted accepted but unacknowledged send must remain uncertain.
artifacts:
  - Implementation commit 917c7b9bfec9556135b18ebfc5f6051b3b01ac40 on lane/question-alerts
  - brain/lib/steward-questions.mjs
  - brain/lib/steward-payload.mjs
  - brain/lib/steward.mjs
  - brain/bin/steward-imessage.mjs
  - brain/bin/brain.mjs
  - brain/README.md
  - brain/test/steward-questions.test.mjs
  - node --test brain/test/steward-questions.test.mjs brain/test/steward.test.mjs brain/test/permission-policy.test.mjs — 57 passed, 0 failed, 0 skipped
  - node --test brain/test/steward-questions.test.mjs — final receipt-validation and cleanup revision, 12 passed, 0 failed, 0 skipped
  - Final lane check after the report commit uses node --test brain/test/steward-questions.test.mjs brain/test/steward.test.mjs brain/test/permission-policy.test.mjs; its gate receipt names the final commit.
decisions: []
questions: []
challenges:
  - Absolute exactly-once delivery across an interrupted external send is unavailable with the existing macOS and Messages transports. Confirmed channels dedupe durably; unconfirmed sends retry after debounce and consume capped durable attempts, with a possible duplicate if the original send was accepted before its receipt was saved.
---

The steward reads fleet records through the existing event loader and fold. It
verifies the checkout/common-directory fleet mapping and keys observation by that
identity plus the canonical record path. It does not depend on session activity,
supervisor presence or terminal focus, and runs on the normal watch tick even when
Herdr is unavailable. Record events and the core CLI are unchanged.

The first successful scan establishes a per-record baseline. The fixture with two
pre-existing open questions and one answered question skipped **2**, emitted no
alerts, and retained the per-record skipped counts. Foreground results report
`questions.skipped`; the watcher logs it. Live deployment will establish and report
its own baseline; this lane did not start a watcher or send any live alert.

Question receipts live in the operator's Brain state at `steward/questions.json`,
under the existing steward lock. Atomic, fsynced updates commit discoveries with
the record cursor before effects, and save per-channel success, error, attempt
count and last-attempt time. A failed iMessage channel retries without repeating a
confirmed local notification. Each question gets its own cap and debounce so a new
question alerts immediately on discovery. Completed open-question receipts remain
durable; answered receipts compact away while the cursor preserves deduplication.
Corrupt or oversized receipts refuse effects through the existing journal-failure
alert path. Unreadable or stale fleet records keep their cursors for recovery.

Outbound defaults are `project`, `question` (HUM id), `kind`, `category`,
`blocked_items` (direct unresolved dependent items) and `blocked_runs` (their open
runs). Only operator-local `steward.json` with `"question_text": true` adds `text`
and `recommendation`. They are collapsed to one line, stripped of Unicode control
and format characters and limited to 240 and 80 characters respectively. The
Messages adapter accepts only the explicit session/question schemas and literal
argv transport; project configuration cannot enable question text.

Offline coverage includes two projects with overlapping HUM ids, process restart,
privacy defaults, opted-in truncation, baseline skipping, successful-channel retry
dedupe, failure caps, interrupted intents, dry runs, disabled mode, answered/auto
questions, reopening, stale/unreadable records and corrupt receipt refusal. The
only initial test failure was an unsupported fixture `reopen --why` flag; the
fixture was corrected and the focused rerun passed.

No dependencies were added. Validation used scratch fleet mappings and records,
fake channels, and offline fixtures. No promotion or release suites were run.
