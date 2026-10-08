---
run: R-343
outcome: done
summary: |
  Rebased the lane onto main and isolated gate history in test processes and their children through a disposable MONITOR_GATE_HISTORY_ROOT. Shared offline and slot fixture helpers install the override; exit guards fail on changes to the real repository history. Limit derivation now requires three usable samples and excludes implausibly short clocks, including the quarantined fixture records. Promotion and release floors leave twice the observed healthy maximum durations.
  All 306 focused tests passed plainly and inside an outer scratch slot. Both runs confirmed the real Git common-directory gate-watchdog directory remained absent; the outer slot released after one attempt. Implementation and reproducible evidence are committed in 2e623d5. This report is checked and committed before the required last lane check, which verifies the history guard and limit policy on the committed tree using scratch history.
headline: Gate fixtures no longer poison real watchdog history and healthy full gates retain ample time
blockers: []
proposals: []
learnings:
  - 'A scratch slot lock does not isolate gate history: merge-batch worktrees share the canonical Git common directory. Tests must set a scratch history root in the process calling product code and in its children.'
  - 'The direct promotion pressure tests require the existing memory-fixture preload; otherwise their fake memory file does not affect product children.'
artifacts:
  - 'Implementation commit: 2e623d5'
  - 'Branch: lane/gate-watchdog; rebased onto main d9566200'
  - test-slot/limits.mjs
  - test/helpers/gate-history.mjs
  - test-slot/README.md
  - docs/reports/evidence/ENG-274-R343/reproduce.mjs
  - docs/reports/evidence/ENG-274-R343/negative.mjs
  - docs/reports/evidence/ENG-274-R343/limits.json
  - docs/reports/evidence/ENG-274-R343/plain.log.gz
  - docs/reports/evidence/ENG-274-R343/outer.log.gz
  - docs/reports/evidence/ENG-274-R343/negative.log.gz
  - docs/reports/evidence/ENG-274-R343/sandbox.log.gz
  - docs/reports/evidence/ENG-274-R343/missing-preload.log.gz
  - docs/reports/ENG-274-gate-watchdog-R-343.md
  - /Users/rewt/development/rewt/.org/runs/R-343/report.md
  - '.lane/gate.json: receipt written by the last lane check after the report commit'
decisions:
  - text: Isolate history through a scratch root, with a separate namespace for each Git common-directory identity, and guard the actual repository directory.
    category: tooling
    why: Scratch worktrees and isolated slot paths still share canonical Git history; in-process callers and minimal child environments both need isolation.
  - text: Require three usable samples and apply tier-specific minimum sample durations of 180, 300 and 30 seconds to both wall and idle derivation.
    category: tooling
    why: The quarantined fixture clocks are subsecond, including seven-sample histories. A sample-count requirement alone would still admit them. Short genuine gates retain the default or an explicit project override.
  - text: Use tier-specific wall floors of 1200, 3600 and 600 seconds; retain the 4500-second default and explicit configuration precedence.
    category: tooling
    why: Full promotion commands can select bounded extras. These full-gate floors protect the observed 10-minute promotion and 30-minute full adapter even after narrower executions; the 75-minute default also leaves substantial room for a 39-minute bch-cloak gate.
questions: []
challenges: []
---

The quarantined directory was inspected read-only and was not restored. It has
125 JSON history files. Examples include seven release-adapter clocks with a
maximum of 0.719 seconds, seven acceptance clocks with a maximum of 0.043 seconds,
and seven bch-cloak command clocks with a maximum of 0.043 seconds. The old
formula resolves each of these to 600 seconds. Replaying all eight inspected
adapter/acceptance/bch-cloak keys through the corrected resolver gives the
4500-second default. See `limits.json` for sample counts and exact numbers.

`MONITOR_GATE_HISTORY_ROOT` redirects files to
`ROOT/SHA256(GIT_COMMON_DIR)/KEY.json`. The shared offline helper covers bounded
test files and the suite runner; the slot fixture helper covers direct slot,
watchdog and cancellation tests. The containment policy carries the override
into minimal child environments. Host and release envelopes resolve limits
using their supplied environment. Existing history-key fingerprints, bounded
retention and group-cleanup behavior remain intact.

The guard snapshots the actual common-directory history, including file bytes
and modification metadata, and fails the test process if it changes. A watchdog
regression runs a successful fixture against that actual common-directory
identity and proves the sample was written only in scratch. The negative
control exports the source into a separate disposable Git repository, disables
the override only in the product child, and proves that both the assertion and
exit guard reject the leaked history with `TEST_GATE_HISTORY_LEAK`. It never
writes the operator's repository history.

The sanity thresholds apply when deriving both wall and idle limits; short
successful records remain available as diagnostics in their isolated history.
Fewer than three eligible samples retain a 75-minute wall default and disable
automatic idle expiry. Explicit wall and idle settings still take precedence,
including the short settings used by timeout tests. Eligibility tests cover
zero, one and two sane samples, twenty short samples, a mixed history with two
sane samples, and three sane samples at each threshold.

Using the healthy durations supplied in the correction ask and the earlier
recorded bch-cloak clocks:

| Gate | Healthy duration | Empty-history limit | Trained limit | Trained wall floor |
| --- | --- | --- | --- | --- |
| herdr-brain promotion | 7–10 min | 75 min | 20 min | 20 min |
| herdr-brain release adapter | 20–30 min | 75 min | 60 min | 60 min |
| bch-cloak full gate in slot | up to 39 min | 75 min | 78 min | 10 min for its CLI label |

The default leaves 65, 45 and 36 minutes above the respective healthy maxima.
The trained limits are twice the maximum sample (subject to the tier floor).
These calculations are offline policy checks, not fresh executions of real
promotion or release gates. The existing prepare/preflight follow-up ENG-276
remains outside this correction.

Verification used only the focused offline files: all six test-slot files, all
eight promote files, all three release files, lane validation and release-suite
runner tests. The modified history assertions are lane-added cases absent from
main; existing main assertions were preserved. A selected-case probe in an
archived main checkout confirmed there was no matching release watchdog case.

- `node docs/reports/evidence/ENG-274-R343/reproduce.mjs plain`: 306 passed,
  zero failures or skips; 142.946 seconds. Real history remained absent.
- `node docs/reports/evidence/ENG-274-R343/reproduce.mjs outer`: 306 passed,
  zero failures or skips; 154.749 seconds. The outer scratch gate used both
  7200-second wait variables and the retry marker, supplied both holder tokens,
  exited zero after one attempt and released its slot. Real history remained absent.
- `node docs/reports/evidence/ENG-274-R343/negative.mjs`: the selected guard
  test failed as intended in the disposable repository; the control exited zero
  after verifying the failure and leak marker.
- `git diff --check` passed.

The successful runs used approved host execution for native watch, local socket,
PTY and seatbelt probes. The initial sandbox run had 34 failures, including
sandbox-denied filesystem watches reported as EMFILE, and one seatbelt skip.
The first host attempt passed 304 tests but failed two unchanged pressure tests
because the direct runner lacked the existing memory-fixture preload. Adding
that preload to the verification runner produced both successful runs above.
Both failed attempts are retained as evidence; no assertions were weakened.
No npm baseline/full suite, promotion or release tier, live acceptance harness,
or real host test slot was run or acquired.

After checking and committing this report, the last command is
`node docs/reports/evidence/ENG-274-R343/reproduce.mjs lane-check`.
It invokes `lane check` in the fast tier with the three focused history/policy
regressions, isolates the check wrapper's own history, writes `.lane/gate.json`
and confirms the real history is still absent. This report does not claim that
final receipt already exists.
