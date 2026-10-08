---
run: R-337
outcome: done
summary: |
  Fixed the queue startup race: a new worker acknowledges readiness only after persisting its first batch or job checkpoint. The failing low-memory promotion test passes unchanged.
  Settings reads use defaults for an unborn canonical branch or a commit without .promote.json. Git failures and invalid committed batch settings produce coded refusals retained in queue status, preserve pending requests in FIFO order, and release the worker lock. Each new batch reads settings once from a pinned canonical commit; recovery reuses captured membership.
  Both complete requested offline files passed: promote.test.mjs 24/24 and train.test.mjs 43/43, with zero failures or skips. The implementation is committed as a1309a8; this checked report is committed next, followed by the final focused lane check.
headline: Queue workers now acknowledge saved batches and retain settings refusals
blockers: []
proposals: []
learnings:
  - The low-memory promotion fixture has a committed base and no .promote.json. Its null current batch came from acknowledging startup before settings reads and dequeue, rather than missing configuration causing a Git error.
  - This worker sandbox denies even a standalone fs.watch on /private/tmp with EMFILE. The same watcher succeeds outside the sandbox; run these offline watcher-dependent suites through approved command escalation without taking the host test slot.
artifacts:
  - 'Implementation commit: a1309a8'
  - 'Branch: lane/batch-cap'
  - promote/promote.mjs
  - promote/test/train.test.mjs
  - promote/README.md
  - 'Validation: node test/helpers/run.mjs promote/test/promote.test.mjs promote/test/train.test.mjs (67 passed, zero failed, zero skipped; 260.931 seconds; exit 0)'
  - /private/tmp/R-337-suites.tap
  - docs/reports/ENG-277-settings-fix-R-337.md
  - /Users/rewt/development/rewt/.org/runs/R-337/report.md
  - '.lane/gate.json (final focused lane check receipt)'
decisions:
  - text: Acknowledge detached startup after its durable queue checkpoint and retain settings refusals without consuming pending requests.
    category: design
    why: Callers must not observe a successful startup before batch membership exists, and a failed policy read must remain inspectable and retryable without silently applying defaults.
questions: []
challenges: []
---

Main was still da07cc67 at the start and after validation, and was already the
lane's base; no rebase was needed. The original promote/test/promote.test.mjs
was not edited. No baseline, npm test, promotion/release tier, live acceptance
harness, project-wide housekeeping loop, or host test slot ran. The offline
runner contains fixture workers and supplies their simulated memory readings
and isolated test-slot identities.

The failure log showed null.jobs immediately after launch. The worker previously
sent ready before its dequeue transaction; the added synchronous settings reads
widened that timing gap. Readiness now follows the transaction, so the caller
can inspect its saved batch before validation starts.

Missing configuration returns defaults only after a successful committed-tree
read, or after confirming HEAD names an absent branch ref. Other Git failures
use PROMOTION_SETTINGS_GIT_FAILED. Malformed committed JSON, a non-object
configuration, and invalid max_batch values use PROMOTION_SETTINGS_INVALID.
On dequeue refusal, queue.json retains outcome, code, reason, pending request
IDs and timestamp in its refusal field. Startup returns the refusal to the
enqueuer; the drain exits deliberately with code 1 and releases ownership.
A retry with readable, valid settings clears the refusal and drains the same
requests in order. Empty queues and captured/recovering batches do not reread
settings. The committed settings snapshot uses one commit hash for both tree
lookup and blob retrieval.

Five additional train tests cover an unborn canonical branch with untracked
invalid configuration, injected rev-parse/ls-tree/show failures with retained
status and successful FIFO retry, and one settings snapshot per new batch
with no extra read when the queue becomes empty. Existing invalid-cap tests,
batch cap/default tests, interruption recovery, bisection, lifecycle guards,
and planner-bound coverage all passed in the complete files.

The first complete attempt inside the sandbox encountered fs.watch EMFILE
errors. A standalone watcher reproduced the denial, and approved escalation
proved the same watcher works outside the sandbox. That attempt was stopped
through its verified runner's SIGINT cleanup; the complete rerun outside the
sandbox passed all 67 tests. The log is /private/tmp/R-337-suites.tap.

After checking and committing this report, the last operation is a fast-tier
lane check of the original regression and the settings tests on the clean tree:

```sh
node lanes/lane.mjs check --cmd "node test/helpers/run.mjs --test-name-pattern='^(queued promotion waits|an unborn canonical|a failed settings|settings are read|invalid committed max_batch)' promote/test/promote.test.mjs promote/test/train.test.mjs"
```
