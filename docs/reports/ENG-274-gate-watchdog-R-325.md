---
run: R-325
outcome: done
summary: |
  Resolved all six findings from the second gate watchdog review. Descendant markers require exit 124; unreaped detached children authorize owned-group cleanup without a start lookup; planned train gates and both lifecycle envelopes share declared command history keys; history is bounded; queue timeout reasons distinguish singleton correction from batch re-enqueue.
  All three touched offline test files passed: 25 watchdog, 14 host-profile and 27 release cases. Implementation and evidence are committed in ddab52e. This report is checked and committed before the required final fast lane check; that check's receipt supplies the final gate evidence.
headline: Gate watchdog corrections stop owned hangs and preserve accurate timeout outcomes
blockers: []
proposals: []
learnings:
  - 'A completed merge train can exit zero after recording a lane timeout. Printed descendant markers must not convert that completed host lifecycle into a timeout.'
  - 'An unreaped detached child proves ownership of its process group even if a start identity lookup fails. Escaped descendants still require birth confirmation.'
  - 'Planned train gates need the declared base command fingerprint for timing history; release gates need the declared argv fingerprint before candidate substitutions.'
artifacts:
  - 'Implementation commit: ddab52e'
  - 'Branch: lane/gate-watchdog'
  - docs/reports/ENG-274-gate-watchdog-R-325.md
  - docs/reports/evidence/ENG-274-R325/
  - test-slot/test/watchdog.test.mjs
  - test-slot/test/gate-profile.test.mjs
  - release/test/release.test.mjs
  - /Users/rewt/development/rewt/.org/runs/R-325/report.md
  - '.lane/gate.json: final fast lane-check receipt, written by the final command'
decisions:
  - text: Use tier and declared command fingerprints as explicit timing history keys for planned train and release gates.
    category: tooling
    why: Batch file lists and candidate substitutions must not reset healthy timing measurements; the host envelopes must resolve the same inner allowance.
  - text: Keep at most 128 command history files per project and serialize recording with pruning.
    category: tooling
    why: Timing samples are replaceable advisory measurements; bounded retention prevents per-command history growth without racing concurrent writers.
questions: []
challenges: []
---

All findings in `docs/reviews/gate-watchdog/6b8b56e-r1.md` are addressed:

1. Observed descendant markers remain separate from the wrapper's own watchdog
   outcome. Only an actual command exit of 124 adopts a descendant marker.
   Regression cases print the marker and exit 0, 1 and 124.
2. While the detached leader is an unreaped child, cancellation signals its
   owned group with TERM, grace and KILL without requiring start identity.
   Cleanup confirms kernel group disappearance. Escaped children still need
   identity checks; an unknown escaped identity cannot prevent owned-group
   KILL, and retains the slot as a cleanup failure. A regression injects total
   identity-source failure into a hung no-slot gate and confirms it stops.
3. `validateTree` and `runGateSync` carry an explicit history key through the
   CLI. Train plans use the promotion tier and declared base shell command
   fingerprint. Two real train runs with different selected file lists share
   one history, retain its derived 12000-second wall allowance and append two
   healthy samples. Recording prunes old regular history files to 128 while
   preserving the current file and unrelated files.
4. Release envelope and inner release gate use the release tier and declared
   release argv key before candidate substitutions. Actual receipt evidence
   confirms a 14000-second derived inner allowance and an envelope at least
   twice that value. Promotion envelope evidence confirms the same relation
   for a 12000-second inner allowance.
5. Unbatched queue exits of 124 with timeout evidence now use the train's exact
   wall-clock or no-output reason and singleton correction wording. Both kinds
   have queue regression coverage.
6. An actual two-lane host envelope timeout produces `batch timed out;
   re-enqueue lanes individually` for both jobs, preserves main and releases
   its scratch slot.

The prior idle host-profile assertion depended on finding 1: it treated a
completed train's zero exit as a host timeout because of printed inner output.
It now checks a finished host receipt, the inner idle timeout, the singleton
correction reason and unchanged main separately. No baseline suite was run,
per the explicit lane instructions.

Final offline evidence is committed as gzip logs:

- `node --test test-slot/test/watchdog.test.mjs`: 25 passed.
- `node --test test-slot/test/gate-profile.test.mjs release/test/release.test.mjs`:
  41 passed (14 host-profile and 27 release cases), outside the sandbox for
  disposable local socket/PTY and native memory-probe fixtures.
- A final focused rerun after simplifying history-file lookup: 3 history cases
  passed, 22 intentionally skipped.

Initial sandbox host-profile checks failed because socket/PTY operations were
refused. The initial release file had a sandbox memory-advisory assertion
failure and a new instrumentation error. Development also corrected the new
preload hook's handling of shell spawn argument shapes and the owned-group
fixture's detached spawn. Final runs above passed without weakening sandbox
or lifecycle safety checks. Every gate fixture used a scratch slot; the host
slot, promotion/release tiers, live acceptance harness and model calls were
not used.

The remaining parent-walk limitation is unchanged: descendants double-forked
to init before the snapshot are outside the supported walk, as already
assigned to the reclaim backstop item.

Required closing order: implementation commit, report write, record check,
report commit, then `node lanes/lane.mjs check` with the default fast tier as
the final operation. This pre-check report does not claim that last receipt
already exists.
