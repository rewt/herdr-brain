---
run: R-135
outcome: done
summary: |
  Fixed the duplicate long-running notice after a busy-composer wait cap. An acknowledged durable inbox handoff now counts as notified for intermediate notices, and the long-running event retains its ID and original journaled payload across retries and watcher restarts. Documented the supervisor-accepted Claude boundary impersonation limit without changing parsing. The full offline suite passed; the final lane check follows the checked report commit.
headline: Long-running notices no longer duplicate while delivery waits.
blockers: []
proposals: []
learnings:
  - "A pending receipt with an acknowledged inbox owner is a successful intermediate-notice handoff; treating it as failure rearms the long-running timer."
  - "Elapsed minutes are payload, not event identity. Restarted watchers must adopt the existing long-running ID and original payload, including legacy message-hash IDs."
artifacts:
  - "Implementation commit subject: Count owned long-running notices as notified"
  - "Report commit subject: Report capped long-running notice fix for run R-135"
  - "Branch: lane/quiet-delivery; rebased first onto main, subject Record superseded no-compiler review finding for run R-130"
  - "watch/watch.mjs; watch/test/watch.test.mjs; watch/README.md; supervisor/README.md"
  - "Full offline validation: ORG_ACTOR=eng-106-r3-final-test npm test; 777 tests, 766 passed, 11 skipped, zero failures, 449.767 seconds; /private/tmp/eng-106-r3-final-test.log"
  - "Regression reproduction and focused pass: /private/tmp/eng-106-r3-regression-red.log; /private/tmp/eng-106-r3-regression-green.log"
  - "Baseline and unchanged promotion-case rerun: /private/tmp/eng-106-r3-baseline.log; /private/tmp/eng-106-r3-baseline-case.log"
  - "Final lane receipt: .lane/gate.json, generated after this report is checked and committed"
decisions:
  - text: Count intermediate delivery as notified after an acknowledged durable inbox handoff, retaining one long-running notice ID and its original payload across retries and restarts.
    category: design
    why: A busy composer and changing elapsed minute must not create another notice for the same event; the inbox owner remains responsible for later delivery.
  - text: Document the accepted Claude footer boundary impersonation limit without adding parsing machinery.
    category: design
    why: The supervisor explicitly accepted this limit shared with bch-cloak's reference and restricted this round to the duplicate-notice finding.
  - text: Validate the busy-through-cap case with captured ANSI input and a fixture clock, followed by the complete offline suite and a final committed-head lane check.
    category: prover
    why: The requested proof must cover elapsed-minute changes and watcher restarts without touching the operator's panes.
questions: []
challenges:
  - "The accepted Claude limit remains: a draft continuation beginning with four box-drawing horizontal rules can impersonate a footer boundary, and a later bare prompt glyph can make populated input appear empty. It is now documented in supervisor/README.md."
  - "The pre-change suite had one unrelated promotion-fixture teardown failure (ENOTEMPTY): 764 passed, 11 skipped, one failed. The unchanged case passed in isolation and in the complete post-change suite. No promotion code or test was changed."
---

The implementation is committed as **Count owned long-running notices as notified**. This report is committed as **Report capped long-running notice fix for run R-135**. Rebased onto main before testing or editing; main's subject was **Record superseded no-compiler review finding for run R-130**, and it had not moved when the implementation was committed.

Read the round-two findings in their supplied scratch location without copying the findings file into the repository. This round fixes only the Moderate and documents the accepted Major.

Intermediate notice bookkeeping now accepts either actual delivery or a queued receipt with an acknowledged owner PID. Final and gone-worker delivery still require acknowledgement. For the long-running event, a watcher caches the initial message and uses `watch:R-n:long-running`; a restarted watcher adopts the existing journal ID and message, including older hash-based IDs. A change in elapsed minutes therefore cannot create another logical notice or conflict with its original payload. The inbox worker retains responsibility for eventual delivery after the caller caps or exits.

The new offline integration test holds the captured Claude typed composer through a zero-second caller cap, advances a fixture clock from two to four minutes, and verifies one pending notice and no prompt. It restarts the watcher while delivery is pending and verifies the same ID and two-minute payload. Clearing the captured composer delivers exactly one prompt with that original text and visible notice ID. Advancing to six minutes produces no further notice. The test also checks that the owned handoff stops delivery-failure retries. Before the fix it reproduced two inbox entries for the same event; afterward it passed both in isolation and in `npm test`.

The module guide now documents the accepted boundary impersonation: a Claude draft row starting with four `─` characters can become a false footer boundary, and a remaining bare `❯` can be stripped as chrome. No composer parsing or new boundary machinery was added. The previously accepted screen-read-to-input race also remains documented. Delivery remains at-least-once; a genuinely lost acknowledgement can replay the same recognisable ID, whereas the busy-cap regression introduces no second logical notice.

Alignment with bch-cloak is preserved: journal first, the same Claude footer adapter, two empty ANSI reads three seconds apart, immediate final recheck, `herdr agent prompt`, `SUPERVISOR_INPUT_WAIT_SECONDS` default 7200, retained pending ownership and wait logging. Watch, promotion and settle/dispatch notices still share the existing delivery helper, and harness parsing remains outside the record core. No bch-cloak file, record-core implementation or legacy `contrib/settle-watch.mjs` path/flags changed.

All transport calls used offline fixture executables and captured ANSI screens, with caller Herdr context removed, a rejecting default executable and a non-live socket path. Tests used explicit actors and bounded subprocesses. Did not run the live acceptance harness: the operator and main's AGENTS.md reserve it for once per release candidate. Did not run `--skip-live` or acceptance-specific tests because `acceptance/` did not change; did not run `npm run test:lanes` because `lanes/` did not change. No project housekeeping schedule, real pane mutation, shared configuration change, push or release action was performed.

The pre-existing untracked review file was preserved byte-for-byte at `/private/tmp/eng-106-r135-preexisting-review-y3o_tzce/quiet-delivery/66175b2-r1.md`, allowing a clean final gate without committing unrelated review content.

After `record check` and the report commit, the last operation is this offline lane check. Its `.lane/gate.json` receipt binds the final committed head:

```sh
env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  ORG_ACTOR=eng-106-r3-lane-check HERDR_SOCKET_PATH=/tmp/eng-106-r3-no-server.sock \
  PATH="/tmp/eng-106-guard:$PATH" \
  node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs --suite-timeout=540000 --file-timeout=480000 watch/test/*.test.mjs supervisor/test/*.test.mjs'
```
