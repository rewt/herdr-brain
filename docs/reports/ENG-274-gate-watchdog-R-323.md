---
run: R-323
outcome: done
summary: |
  Added one process-group watchdog for gates inside and outside the host test slot, with explicit configuration, healthy per-project/tier timing history, optional output-silence limits, and TERM/grace/KILL cleanup of birth-confirmed escaped descendants. Wall and idle overruns exit 124, retain distinct timeout receipts, never spend the load retry, and isolate merge-train lanes for correction without merging or replaying that candidate.
  Implemented the supervisor addendum for non-slot validation and read bch-cloak's temporary stopgap without modifying it. Focused offline checks passed. The implementation is committed in 844ef9c; this checked report is committed before the final fast lane check, after which the run stops.
headline: Hung gates now stop their owned processes and return lanes for correction
blockers: []
proposals: []
learnings:
  - 'Detaching nested gates requires recording their groups in the holder: otherwise killing both wrappers could make the slot appear free while the nested command survives.'
  - 'A gate command clock must start after slot acquisition; validation receipt duration can also include waiting, so watchdog history uses the command execution receipt instead.'
artifacts:
  - 'Implementation commit: 844ef9c'
  - 'Branch: lane/gate-watchdog'
  - test-slot/limits.mjs
  - test-slot/watchdog.mjs
  - test-slot/test/watchdog.test.mjs
  - test-slot/README.md
  - docs/reports/ENG-274-gate-watchdog-R-323.md
  - /Users/rewt/development/rewt/.org/runs/R-323/report.md
  - '.lane/gate.json: final fast lane-check receipt'
decisions:
  - text: Use a 600-second wall floor and a 4500-second default, deriving twice the maximum of the last 20 healthy command durations per project and tier.
    category: tooling
    why: Ten minutes gives narrow gates room for cold builds and load variation, while 75 minutes conservatively bounds unmeasured full gates. The supplied 35m58s healthy maximum derives 71m56s, about 72 minutes.
  - text: Derive idle limits from three times the longest recorded healthy silence with a 300-second floor, keeping them off without history and allowing explicit zero to disable them.
    category: tooling
    why: Healthy output measurements supply evidence for silence bounds; enabling an idle default before measuring silent builds would cause false timeouts.
questions: []
challenges: []
---

The shared foreground wrapper observes both output streams and starts its
monotonic clock at command execution, after any slot wait. Configuration accepts
`validation.timeout_seconds` and `validation.idle_timeout_seconds` as numbers
or maps by tier, plus promotion-profile `gate.timeout_seconds` and
`gate.idle_timeout_seconds`. Command-line callers can specify the Git common
directory and tier explicitly. Healthy history is kept below the canonical Git
common directory, with serialized writes and a rolling 20-run window.

On an overrun, a kernel snapshot walks the command's descendants before
signalling. The group leader's initial birth prevents signalling a replacement
PID; escaped descendants are individually birth-confirmed before each signal.
The wrapper sends TERM, waits one second, sends KILL, and waits for the group
and captured descendants to disappear before releasing the slot. An unavailable
identity or failed cleanup leaves the lock intact and emits a cleanup diagnostic;
it does not authorize a broader signal. Nested detached groups are registered
in the holder so orphan liveness remains conservative after wrapper death.

Promotion and non-slot validation receipts include the timeout outcome, resolved
limits, command duration, longest silence and execution receipt. Direct promotion
exits 124 with the lane retained. A merge-train timeout records `timeout` and
`gate wall-clock limit exceeded; lane isolated for correction` for the timed-out
candidate, without bisection or replay. Ordinary test timeouts retain their
existing single load retry; watchdog overruns and their descendant markers cannot
use it. Release gates use a stable project/tier history rather than candidate IDs.
Promotion and release lifecycle envelopes allow twice the inner wall allowance,
at least 600 seconds, so preparation/bookkeeping can finish recording the inner
outcome; lifecycle idle checks remain disabled.

Focused validation (scratch repositories, slot paths and fleet configuration;
o models or live Herdr messages):

- `node --test test-slot/test/*.test.mjs`: 86 passed. These include host-profile,
  native identity, lock, nested retry and crash recovery regressions.
- After the final leader-birth guard, `node --test test-slot/test/watchdog.test.mjs
  test-slot/test/conformance.test.mjs`: 18 passed, including all 11 new watchdog
  cases and all seven existing cancellation/caller-watch cases.
- `node test/helpers/run.mjs lanes/test/validation.test.mjs`: all 17 passed.
- `node test/helpers/run.mjs promote/test/conformance.test.mjs`: all 12 passed
  after preserving the existing promotion adapter's caller-refusal boundary.
- Focused release tests matching `^(red gate|preparation env|a held host slot|
  tracked declarations|unconfigured release)`: five passed, 20 deliberately
  skipped. No release tier or live release candidate was run.
- `git diff --check` and syntax checks passed.

Initial sandbox attempts refused the host-profile fixtures' local socket/PTY
access and two filesystem-watch fixtures reported EMFILE. Approved offline
reruns outside that sandbox passed. Existing tests were not weakened or edited.
A transient conformance failure after generalizing the adapter was corrected by
retaining `runTestSlotSync` for promotion and `runGateSync` for non-slot tiers.

The new proofs cover a blocked grandchild in the gate group and in a separate
group, slot release and group disappearance, wall/idle limits, output refreshing
idle clocks, healthy gates, explicit/derived/default resolution, no replay under
load, no slot-wait time charged to the gate, distinct lane/queue outcomes with
scratch main unchanged, and non-slot fast validation leaving an occupied scratch
slot untouched while recording its own healthy history. Another regression proves
nested groups protect the slot after both wrappers die.

No project promotion, push, model call, host test-slot acquisition, housekeeping
loop, promotion tier, or release tier was performed. `contrib/settle-watch.mjs`
and bch-cloak were left unchanged. The final command is
`node lanes/lane.mjs check --cmd 'npm run test:fast'` after both commits and the
record report check; its local gate receipt is the final validation evidence.
