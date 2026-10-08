---
run: R-339
outcome: done
summary: |
  Fixed all three requested corrections. A settings refusal after startup now sends one queue notice to the first pending request's saved supervisor recipient, naming the code, reason and pending IDs, and retains the delivery receipt without consuming or reordering pending requests.
  Settings Git reads now take a committed snapshot outside the queue lock with a load-aware two-second total allowance; timeouts map to PROMOTION_SETTINGS_GIT_FAILED. Tests also assert that invalid committed settings retain their code and pending IDs in queue.json and appear in --status. The earlier startup checkpoint fix is preserved.
  Both complete requested offline files passed: promote.test.mjs 24/24 and train.test.mjs 48/48, with zero failures or skips. Implementation is committed as d429d0b. This report is checked and committed next, followed by the final focused lane check.
headline: Promotion settings refusals now notify the supervisor without blocking enqueuers
blockers: []
proposals: []
learnings: []
artifacts:
  - 'Implementation commit: d429d0b'
  - 'Branch: lane/batch-cap'
  - promote/promote.mjs
  - promote/test/train.test.mjs
  - promote/README.md
  - 'Validation: node test/helpers/run.mjs promote/test/promote.test.mjs promote/test/train.test.mjs (72 passed, zero failed, zero skipped; 247.862 seconds; exit 0)'
  - /private/tmp/ENG-277-R-339-tests.tap
  - docs/reports/ENG-277-settings-fix2-R-339.md
  - /Users/rewt/development/rewt/.org/runs/R-339/report.md
  - '.lane/gate.json (receipt produced by the final focused lane check)'
decisions:
  - text: Deliver post-startup settings refusals through the existing supervisor notice path and apply a bounded settings snapshot inside the dequeue transaction.
    category: design
    why: Pending requests must remain ordered and recoverable while the supervisor receives the failure; slow Git reads must not hold the queue lock or acknowledge an unsaved batch.
questions: []
challenges: []
---

The correction stays within the three review findings. The gate-profile source
remains with the existing follow-up. No npm test, promotion or release tier,
live acceptance harness, project-wide housekeeping loop, or host test slot ran.
The two complete offline files ran through the fixture-policy runner under
approved command escalation, as required for their disposable filesystem watchers.

The worker reads settings before taking queue.lock and applies that snapshot
inside its dequeue transaction. If a request arrives after an empty snapshot,
the worker retries the snapshot instead of reading Git under the lock. Existing
and interrupted batches retain their captured membership, and successful startup
still follows persistence of the first batch or job checkpoint.

A post-startup refusal persists a queue notice ID and the pending request IDs,
uses the first pending request's saved delivery settings, and saves the notice
delivery receipt alongside the refusal. The worker deliberately exits with code
1 and releases its lock, leaving all pending requests untouched for retry.

Two new tests exercise an invalid setting committed by the first promoted batch
and a transient Git failure on the next batch. Each asserts one refusal notice
to the saved supervisor recipient, retained pending requests in order, one
successful startup acknowledgement, and no second gate. Three further tests
stall each settings Git read and assert its bounded timeout, failure code,
negative startup acknowledgement, retained pending IDs, released worker lock,
and a successful concurrent enqueue while Git is still waiting. The existing
invalid-cap test now checks queue refusal retention and --status for every value.
The original low-memory startup regression passed unchanged in the complete suite.

After checking and committing this report, the last operation is the focused
fast-tier lane check on the clean tree:

```sh
node lanes/lane.mjs check --cmd "node test/helpers/run.mjs --test-name-pattern='^(queued promotion waits|a (invalid|git-failed) settings refusal|a settings git|invalid committed max_batch)' promote/test/promote.test.mjs promote/test/train.test.mjs"
```
