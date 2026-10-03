---
run: R-139
outcome: done
summary: |
  Settle fixture teardown now stops its confirmed inbox owner and transport child
  after senders and watchers finish, then confirms shutdown before deleting the
  record. Unknown ownership or failed shutdown preserves the scratch directory.
  Standalone hang scenarios now have explicit aggregate and readiness bounds,
  with delayed-start regressions and useful early-exit diagnostics. The fast
  tier, standalone hang file, settle suite and shared delivery tests passed.
  The implementation and report are committed on the lane; the final fast lane
  check follows the report commit.
headline: Settle teardown stops its inbox processes and standalone hang tests pass
blockers: []
proposals: []
learnings:
  - Quiet delivery's owner retries pending notices after callers return; a busy composer can prevent natural owner exit indefinitely.
  - Nested hang scenarios include process startup, native fixture compilation and group teardown in their aggregate child lifetime.
  - Individual test files should use test/helpers/run.mjs so their daemon fixtures inherit the live test group and offline containment policy.
artifacts:
  - "Commit: Stop settle fixture inbox owners and bound standalone hang scenarios"
  - "Commit: Report settle teardown and standalone hang validation for R-139"
  - "Branch: lane/settle-teardown"
  - "settle/test/fixture.mjs; settle/test/teardown.test.mjs; test/helpers/inbox.mjs; test/test-hangs.test.mjs; settle/README.md; README.md"
  - "Baseline standalone hang file: 15 passed, 7 failed; /private/tmp/eng112-hangs-before.log"
  - "Post-change npm run test:fast: 140 passed, zero failures; /private/tmp/eng112-fast-after.log"
  - "Post-change node test/helpers/run.mjs test/test-hangs.test.mjs: 22 passed, zero failures, including injected startup delays; /private/tmp/eng112-hangs-final.log"
  - "Post-change node test/helpers/run.mjs settle/test/*.test.mjs: 83 passed, zero failures; /private/tmp/eng112-settle-final.log"
  - "Final inbox-helper verification, node test/helpers/run.mjs settle/test/teardown.test.mjs supervisor/test/delivery.test.mjs: 21 passed, zero failures; /private/tmp/eng112-delivery-final.log"
  - "record check docs/reports/ENG-112-settle-teardown-20261002.md"
  - "Final command: ORG_ACTOR=run-R-139 node lanes/lane.mjs check; .lane/gate.json binds the fast-tier result to the final report commit."
decisions:
  - text: Require confirmed shutdown of the fixture inbox owner and its transport children during teardown, retaining scratch evidence on any unconfirmed cleanup.
    category: design
    why: Delivery can remain pending indefinitely; natural-exit waits do not establish teardown safety. Exact argv, test-group membership and freshly checked birth tuples scope every signal.
  - text: Give nested hang scenarios a 35-second aggregate bound, 30-second receipt waits and three-second watchdog reproducers while retaining the ordinary 15-second command bound.
    category: prover
    why: Cold or delayed startup can exhaust the previous ten-second readiness and one-second watchdog windows before fixtures launch; injected delays now exercise those boundaries independently of suite warming.
questions: []
challenges:
  - "The restricted test attempt could not use ps for ownership checks. Authorized offline tests were rerun with process inspection enabled. Early baseline fast-tier runs also timed out in ordinary Git and Node startups; the subsequent fast tier passed all 140 cases."
---

The busy-owner regression witnesses the former five-second wait failing with
`fixture inbox owner did not exit`, then verifies that explicit fixture cleanup
removes the record and leaves no live owner. A separate transport sleeps for ten
seconds before attempting a late write; cleanup stops both it and its owner before
directory removal. A lock pointing at an unrelated live process is refused, that
process remains alive, and the record remains available for inspection.

Owner cleanup checks the exact launch argv and live test group, captures the birth
tuple, and freshly confirms every individual signal. It confirms the owner is
stopped before collecting transport children, then confirms their exit before
removing directories. A failed lookup attempts to resume the confirmed owner and preserves
the directory; the enclosing bounded runner retains group containment.

The standalone file injects an eleven-second detached-fixture startup delay,
exceeding the former ten-second receipt window, and a 1.25-second startup delay in
both blocked-loop watchdog cases, exceeding the former one-second suite deadline.
All 22 cases pass through the same runner used by the suite. Existing cancellation,
detached native deadlines, historical-PID refusal and unrelated-process checks
remain in place. These tests require neither models nor live Herdr panes.

Validation followed this item's fast-tier instructions. The final lane check runs
after the report commit. No live acceptance harness, promotion, push or publication
was performed.
