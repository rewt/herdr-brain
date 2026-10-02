---
run: R-132
outcome: done
summary: |
  Fixed the round-two review findings while preserving bch-cloak's input gate. Codex now checks the complete composer box, including prompt-like continuation rows. Pending notices have an acknowledged inbox worker that survives the caller's wait cap, and existing housekeeping ticks restart dead owners. Unacknowledged delivery retries automatically with the same visible notice ID and journaled text. The full offline suite passed; the implementation is committed, and the final lane check follows this checked report commit.
headline: Supervisor notices now survive wait limits and make retries recognisable.
blockers: []
proposals: []
learnings:
  - "Codex's captured composer has contiguous shaded rows, blank top and bottom padding, a bold first prompt glyph, and a model/cwd footer. Searching backward for the last bare glyph can discard a multiline draft."
  - "The caller's wait cap no longer retires delivery: an acknowledged finite worker owns the shared inbox until it empties. Every sender and the existing live housekeeping tick can restart a dead owner; dry-run ticks start no delivery."
  - "Every delivered notice ends with notice-id=ID. Lost replies and crashes replay that ID through the composer gate, allowing recognisable duplicates rather than indefinitely blocking FIFO."
  - "Promotion wait diagnostics must go to stderr because foreground drain stdout contains JSON receipts consumed by supervisor callers."
artifacts:
  - "Commit subject: Keep capped supervisor notices owned and replay identifiable delivery"
  - "Report commit subject: Report quiet delivery fixes for run R-132"
  - "Branch: lane/quiet-delivery; rebased before fixing onto main, subject Amend ENG-103/ENG-105 briefs: release gate per release, not per lane"
  - "supervisor/prompt-supervisor.mjs; supervisor/composer.mjs; supervisor/notice-lock.mjs; supervisor/test/delivery.test.mjs; supervisor/test/fixtures/"
  - "housekeeping/housekeeping.mjs and offline tick recovery tests; promotion JSON diagnostics and integration tests; watch cap/exit integration; settle fixture owner cleanup"
  - "Full offline validation: ORG_ACTOR=eng-106-r2-npm-test-final npm test -- --suite-timeout=540000 --file-timeout=480000; 757 tests, 746 passed, 11 skipped, zero failures, 408.148 seconds; /private/tmp/eng-106-r2-npm-test-final.log"
  - "Final lane receipt: .lane/gate.json, generated after this report is checked and committed"
decisions:
  - text: Preserve bch-cloak's journal-first delivery, ANSI footer parsing, two empty reads three seconds apart, ten-second busy-input polling, SUPERVISOR_INPUT_WAIT_SECONDS default 7200, and wait logging.
    category: design
    why: The operator requested compatible input gating and one path for watch, promotion and settle notices.
  - text: Persist attempt intent before an immediate final composer read, then invoke the prompt without an intervening journal write or agent lookup.
    category: design
    why: The supervisor accepted the inherent screen-read race and requested the shortest practical final check-to-input window.
  - text: Assign pending notices an acknowledged finite inbox worker, recover confirmed dead notice owners, and restart delivery from existing housekeeping ticks.
    category: design
    why: A lone final notice must retain a delivery owner after its original caller exits, without waiting for a new notice or manual drain.
  - text: Deliver at least once with a visible stable notice ID and journaled attempt text, replaying unacknowledged attempts through the same input gate.
    category: design
    why: The operator requested automatic recovery after crashes and lost replies, with duplicates identifiable by the supervisor.
  - text: Validate with bounded offline fixture transports and bind the committed report with a final clean-worktree lane check.
    category: prover
    why: The operator requires offline checks and a final lane receipt; transport fixtures must not mutate real panes.
questions: []
challenges:
  - "Screen reads cannot prevent typing or occupant replacement after the final snapshot. This residual race is inherent to bch-cloak's reference too and was explicitly accepted by the supervisor. Exactly-once delivery is not claimed: an effect followed by a lost acknowledgement can replay the same notice ID."
  - "The pre-change npm test command overlapped early edits and exceeded its 540-second bound, so it is not clean baseline proof. The first completed post-change run exposed six promotion JSON consumer failures from stdout wait diagnostics; these were fixed before the final complete passing run."
---

The implementation commit is **Keep capped supervisor notices owned and replay identifiable delivery**. The checked report is committed as **Report quiet delivery fixes for run R-132**. Main was rebased first, before the fixes; its subject was **Amend ENG-103/ENG-105 briefs: release gate per release, not per lane**.

Read the round-one findings in their supplied scratch location without copying them into the repository. The four findings are addressed as follows:

- The final screen read immediately precedes the prompt call. Status and occupant checks, attempt journaling and wait logging occur before that read. The remaining screen-to-input race is documented in the module guide and retained as the supervisor's accepted limitation; no atomic-input machinery was added.
- Codex uses the complete shaded composer box and its first verified prompt row. Every continuation row counts, including a bare `›` after earlier draft text. Captured ANSI variants cover empty, typed and placeholder input, multiline prompt-like continuations, missing padding and ambiguous unshaded layouts. Truncated or unknown chrome stays busy.
- An acknowledged worker owns each pending inbox before input is attempted. It keeps checking after the caller caps or exits, and exits when the inbox empties. Existing housekeeping ticks and later senders restart dead workers. Owner metadata is published with the lock atomically; dead notice locks recover without changing promotion's lock policy. Live or unidentified locks and torn journal data still return explicit errors and retain evidence for inspection.
- Prompts append `notice-id=ID`; sending, retry and acknowledgement events retain that same ID, and attempt/acknowledgement events include the complete delivered text. A crash or lost reply replays the oldest unacknowledged notice, preserving FIFO. Acknowledged notices and restarted watchers with the same stable ID are not replayed. The supervisor can recognise duplicates after uncertain external effects.

Aligned read-only against bch-cloak's `/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/prompt-supervisor.sh`, `box-empty.py`, `notify-watch.sh` and `promote-queue.sh`, including both `.bak-20261002-inputgate` caller diffs. The reference names and default input timing remain intact. Owned retry after the cap and at-least-once delivery extend the reference as directed in this fix round. Its plain-text inbox must remain separate from the product's JSONL journal. No bch-cloak file was modified.

Watch and promotion still use the single shared helper; settle and dispatch correction/completion notices inherit it through watch. Harness parsing remains in the supervisor adapter, outside the record core. No record event types, stored item status, model call or core harness branch was added. The legacy `contrib/settle-watch.mjs` path and flags remain unchanged.

Offline evidence includes an actual final watcher exiting at a zero-second cap while its lone notice later delivers without another watcher; capped promotion notices completing without another enqueue or repeated promotion; an existing housekeeping tick recovering pending intent while dry-run leaves it untouched; typing between the confirmation reads and on the immediate final read; the actual default three-second interval; and killed senders before and after the prompt effect, including stale journal/drain ownership. Lost replies produce the same visible notice ID twice and record a possible duplicate in the journal. Fixture teardown waits for delivery owners, and the full suite's process audit reported no surviving fixture.

The full suite passed after the promotion stdout regression and test assertion were corrected. All transport mutations used fixture executables and fake panes, with caller Herdr context removed and a rejecting default executable/socket. No live pane read or mutation was needed in this round.

Did not run `acceptance/run.mjs`, a live acceptance/candidate gate, or `--skip-live`: the operator and main's AGENTS.md reserve the live harness for once per release candidate, and this lane changes no `acceptance/` files. The existing offline supervisor case inside `npm test` remains a fake-transport test. Did not run `npm run test:lanes`: no `lanes/` source file changed. No project-wide housekeeping schedule was started from this lane, and no push, publication, release or shared configuration mutation was performed.

The pre-existing untracked public review was preserved byte-for-byte under `/private/tmp/eng-106-r132-preexisting-review-h69rac2o/quiet-delivery/`, allowing the final gate to require a clean worktree without committing unrelated review content.

After `record check` and the report commit, the last operation is the following lane check; its receipt binds that final commit in `.lane/gate.json`:

```sh
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  ORG_ACTOR=eng-106-r2-lane-check HERDR_SOCKET_PATH=/tmp/eng-106-r2-no-server.sock \
  PATH="/tmp/eng-106-guard:$PATH" \
  node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs --suite-timeout=540000 --file-timeout=480000 watch/test/*.test.mjs promote/test/*.test.mjs settle/test/*.test.mjs dispatch/test/*.test.mjs housekeeping/test/*.test.mjs supervisor/test/*.test.mjs'
```
