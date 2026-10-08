---
run: R-336
outcome: done
summary: |
  Isolated question receipt failures from permission, inbox and stalled-notice
  routing, retaining the bounded journal-refused alert and returning errors in
  questions.errors. Unchanged record logs skip reads and folds; warm append-only
  scans read and fold only the new tail. Question sends run after routing in a
  parallel batch capped at eight. Unconfigured iMessage is quiet, and the setup
  command reports configured channels while still delivering the local alert.
  Targeted offline checks passed. A read-only measurement of the supplied real
  record took 60.224 ms cold and 8.507 ms unchanged, with zero log bytes read on
  the unchanged tick.
headline: Question alerts now stay cheap and cannot interrupt steward routing
blockers: []
proposals: []
learnings:
  - Durable log size, modification time and file identity can skip unchanged scans after restart; pending sanitized payloads let failed deliveries retry without refolding the record.
  - Append-only incremental folds need a warm in-memory state; after restart a changed log requires one full scan, and complete final events without a newline cannot seed a tail read.
artifacts:
  - Implementation commit 0ec46e7 on lane/question-alerts
  - brain/lib/steward-questions.mjs
  - brain/lib/steward.mjs
  - lib/state.mjs
  - brain/bin/brain.mjs
  - brain/README.md
  - brain/test/steward-questions.test.mjs
  - brain/test/steward.test.mjs
  - node --test brain/test/steward-questions.test.mjs brain/test/steward.test.mjs brain/test/permission-policy.test.mjs — 63 passed before final refinements
  - node --test brain/test/steward-questions.test.mjs brain/test/steward.test.mjs — 47 passed after receipt acknowledgement and routing-order refinements
  - node --test brain/test/steward-questions.test.mjs — 18 passed on the final implementation, including final-newline recovery and recipient removal
  - ORG_DIR=/Users/rewt/development/rewt/.org node /tmp/eng279-measure-question-tick.mjs — read-only real-record measurement with scratch fleet and steward state
  - Final lane check after the report commit uses node --test brain/test/steward-questions.test.mjs brain/test/steward.test.mjs brain/test/permission-policy.test.mjs; its gate receipt identifies the final commit
  - docs/reports/ENG-279-question-alerts-R-336.md
  - /Users/rewt/development/rewt/.org/runs/R-336/report.md
decisions: []
questions: []
challenges:
  - The supplied real record measured 2669212 bytes during this run, rather than the approximately 52 MB mentioned in the handoff. The timing evidence applies to the supplied ORG_DIR and this measured size.
---

Question scans and deliveries now run after existing permission, blocked-worker,
inbox-resume and stalled-notice routing. Corrupt, oversized, overflowing or
unsaveable questions.json receipts return a question error and use the existing
once-per-day journal-refused receipt. They do not reset question cursors or stop
unrelated routing. Tests prove a corrupt receipt still permits an inbox escalation,
a new worker route and owner resume, and that a refused save never starts a
question send without its durable intent.

Record observations persist size, mtime and device/inode identity beside the
sequence cursor. Unchanged observations read zero event bytes, even in a fresh
process. Warm append scans read from the previous byte boundary and extend the
existing derived fold through the same event application logic in lib/state.mjs.
The core remains dependency-free and does not store status, call models or branch
on providers. Replacements, missing cached folds and legacy receipts get a full
scan. Partial event tails preserve the prior cursor for recovery.

Question sends have a global eight-send cap per tick and run concurrently. All
intents commit before effects, each acknowledgement saves as soon as it arrives,
and all sends settle before releasing the steward lock, including on a receipt
save failure. Remaining questions stay pending for a later tick. A barrier test
proves eight simultaneous sends and later draining; another proves worker routing
and inbox resume finish before a slow question send begins. Existing channel
commands retain their ten-second deadline.

No recipient means no iMessage invocation, setup requirement, failed-channel
receipt or retry. The local notification remains enabled. Offline tests cover
several ticks, process restart, the setup command and removing a recipient after
an earlier iMessage failure. Confirmed notifications do not repeat.

The real-record measurement used Node v20.19.4, ORG_DIR set to the requested
record, a temporary fleet mapping and temporary Brain state. Rows and agents were
empty, alerts and resumes were fake, and enqueue/permission effects were forbidden.
Only scratch state was written. The real events.jsonl size, mtime and file identity
were unchanged afterward, and no alerts were attempted.

| Measured tick | Elapsed | Full scans | Skipped scans | Event bytes read |
| --- | ---: | ---: | ---: | ---: |
| Cold baseline | 60.224 ms | 1 | 0 | 2,669,212 |
| Unchanged tick | 8.507 ms | 0 | 1 | 0 |

Both scans reported zero errors, zero pending questions and zero baseline skips.
This is a single-host observation, not a timing guarantee for larger records.
Live macOS notification or Messages delivery was not exercised. No broad,
promotion or release test tier ran. The final lane check is the last operation,
after report validation and its commit.
