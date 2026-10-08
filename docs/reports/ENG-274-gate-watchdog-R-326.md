---
run: R-326
outcome: done
summary: |
  Resolved all three findings from the third gate watchdog review. Promotion envelopes cover the worst-case sequential bisection gates and preparation; release envelopes cover resolved preparation plus both permitted gate attempts. Owned-group cleanup now kills the group but retains the slot when the descendant snapshot fails.
  All 67 touched-file offline tests passed: 25 watchdog, 15 host-profile and 27 release cases. Implementation is committed in 07c7b5f. This report is checked and committed before the required final lane check, whose command is restricted to those three test files; its receipt supplies the final gate evidence.
headline: Gate watchdog envelopes cover batch bisection and release retries and retain slots on snapshot loss
blockers: []
proposals: []
learnings:
  - 'A promotion batch can visit 2 * jobs - 1 sequential groups during red bisection; its host envelope must cover each full gate allowance.'
  - 'Release preparation has a separate history key and one attempt; the release gate permits two attempts under load. The host envelope must resolve and sum those allowances.'
  - 'Snapshot failure leaves escaped descendants unknown even when the owned group is safely stopped. Retaining the slot requires recording that uncertainty after group cleanup.'
artifacts:
  - 'Implementation commit: 07c7b5f'
  - 'Branch: lane/gate-watchdog'
  - docs/reports/ENG-274-gate-watchdog-R-326.md
  - test-slot/test/watchdog.test.mjs
  - test-slot/test/gate-profile.test.mjs
  - release/test/release.test.mjs
  - /Users/rewt/development/rewt/.org/runs/R-326/report.md
  - '.lane/gate.json: receipt written by the final lane check after the report commit'
decisions:
  - text: Budget each outer host watchdog from sequential inner allowances, preparation and permitted retries.
    category: tooling
    why: An outer watchdog must allow the bounded inner commands to finish and record their exact outcomes before its lifecycle backstop fires.
  - text: Stop the owned group despite snapshot failure, then fail cleanup and retain the slot with the snapshot error.
    category: tooling
    why: Unreaped child ownership authorizes group signals, but missing descendant evidence cannot establish that escaped processes are gone.
questions: []
challenges: []
---

All findings in `docs/reviews/gate-watchdog/5bcf606-r1.md` are addressed:

1. Promotion uses `(2 * jobs - 1) * (inner wall limit + 600) + 60`
   seconds, with at least one group. The train gate has no wrapper retry.
   Each possible group receives its full gate limit and ten minutes for
   preparation; a final minute covers bookkeeping and cleanup. The new real
   three-lane regression puts the red lane first, traverses all five groups,
   confirms every inner gate has the healthy-history-derived 12000-second
   limit, and observes a 63060-second outer envelope. Both green lanes promote,
   the red lane stays excluded, the host finishes normally, and the scratch
   slot is released. This proves allowance arithmetic and real bisection
   behavior without waiting for hours of synthetic gate execution.
2. Every failed descendant snapshot calls `uncertain` with its error. An owned
   group still receives TERM, grace and KILL, then kernel liveness confirms it
   is gone. Cleanup throws the saved error rather than authorizing slot release.
   The injected total descendant-source failure now uses a real scratch slot,
   preserves the wrapper's own identity so it can acquire/register the slot,
   denies child start lookup and snapshots on Darwin and Linux, and asserts
   exit 124, snapshot cleanup error, stopped group, and retained holder bytes.
   Its child ignores TERM, exercising escalation to KILL. The holder's null
   group start confirms the injected identity failure actually occurred.
3. Release resolves prepare limits using the declared prepare argv and
   `release-prepare` tier, with the same canonical watchdog configuration as
   the inner preparation. Its envelope is prepare (zero when absent) plus
   two release gate wall allowances plus 600 seconds for snapshotting,
   recording, retention and cleanup. The candidate-substitution regression
   observes distinct history-derived prepare and gate limits of 16000 and
   14000 seconds, and an outer limit of 44600 seconds, exceeding the combined
   prepare and retried gate allowance of 44000 seconds.

Validation before the implementation commit:

- `node --test test-slot/test/watchdog.test.mjs`: 25 passed, no skips.
- `node --test test-slot/test/gate-profile.test.mjs release/test/release.test.mjs`:
  42 passed, no skips (15 host-profile and 27 release cases). This command ran
  through approved escalation for disposable local sockets, PTYs and native
  memory probes. Fixtures used scratch slots throughout.
- The changed source-failure case also passed a focused development check.
- `git diff --check` passed.

No baseline, broad promotion/release tier, live acceptance harness, model call,
or real host-slot acquisition was run. The required final command is
`node lanes/lane.mjs check --cmd 'node --test test-slot/test/watchdog.test.mjs test-slot/test/gate-profile.test.mjs release/test/release.test.mjs'`.
It uses the fast validation path, with its command restricted to touched files,
and runs after this report is checked and committed. This pre-check report does
not claim that final receipt already exists.
