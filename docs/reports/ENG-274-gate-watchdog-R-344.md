---
run: R-344
outcome: done
summary: |
  Resolved both independent review findings. Gate-history samples now retain an inherited test origin token, and the exit guard rejects only samples from its own process tree instead of comparing the entire shared directory. Legitimate concurrent gate writers and transient locks are harmless. The real-identity fixture regression checks its unique command fingerprint and scratch file.
  All 309 focused offline tests passed plainly and inside an outer scratch slot. The outer run used one attempt and released its scratch slot. Real watchdog history remained absent, and the quarantine was preserved. The implementation and evidence are committed in aa480a2. This report is checked and committed before the final lane check of the committed tree.
headline: Gate history guards now tolerate concurrent real gates while catching fixture leaks
blockers: []
proposals: []
learnings:
  - 'Shared Git history changes do not prove a test leak: other lanes, promotion and release gates legitimately write the same directory. Attribute samples with an inherited origin token and fail only the responsible test process tree.'
  - 'Nested test helpers must preserve their inherited origin token even when allocating a fresh history root; minimal fixture child environments must retain both fields.'
artifacts:
  - 'Implementation commit: aa480a2'
  - 'Branch: lane/gate-watchdog; local main d9566200, rebase already current'
  - test-slot/limits.mjs
  - test/helpers/gate-history.mjs
  - test/helpers/fixture-policy.mjs
  - test-slot/test/watchdog.test.mjs
  - test-slot/README.md
  - docs/reports/evidence/ENG-274-R344/reproduce.mjs
  - docs/reports/evidence/ENG-274-R344/plain.log.gz
  - docs/reports/evidence/ENG-274-R344/outer.log.gz
  - docs/reports/ENG-274-gate-watchdog-R-344.md
  - /Users/rewt/development/rewt/.org/runs/R-344/report.md
  - '.lane/gate.json: the required final lane check writes its receipt after the report commit'
decisions:
  - text: Attribute gate-history leaks with an inherited origin token retained in healthy samples and preserved across nested test helpers.
    category: tooling
    why: Whole-directory snapshots mistake legitimate concurrent real gates for test writes; ownership attribution catches leaked fixture samples without racing shared directory metadata or locks.
  - text: Assert that the fixture history file and fingerprint are absent from real history, and that its sample exists under scratch.
    category: tooling
    why: The fixture command includes its unique scratch path, so concurrent gates can record their own local history without affecting this assertion.
questions: []
challenges: []
---

The Major finding is resolved by `MONITOR_GATE_HISTORY_ORIGIN`, generated once
for a test process tree and inherited by product children. `recordHealthyGate`
adds the optional `origin` field to samples; older samples remain valid and
ordinary gates without a token retain their existing format. The shared fixture
policy carries both root and origin into minimal child environments. Reimporting
the isolation helper in a descendant creates a fresh scratch root and preserves
the inherited origin.

The exit guard reads only published command-history JSON files. It rejects a
sample bearing its own token with `TEST_GATE_HISTORY_LEAK`. Other origins
produce a non-failing diagnostic; locks, temp files and concurrent pruning do
not count as leaks. Three new regression cases run the actual helper under its
default Git identity in independent disposable repositories. While the guarded
process is live, another process publishes history with no origin, with a foreign
origin, or after a descendant deliberately drops the scratch root. The first
two exit zero, including with a transient history lock present. The descendant
preserves the parent token across helper initialization and causes both guards
to exit one. Deliberate leaks never touch the operator's repository.

The Minor finding is resolved by replacing whole-directory equality with checks
of the fixture's own key file and command fingerprint. The fixture uses the
actual shared Git identity and a command containing its unique scratch path;
its healthy sample must exist only under the scratch history root.

The supplied validation log had three passing policy/fixture cases and no
failures. All were re-executed alongside the new controls. The changed watchdog
file and helper are lane additions absent from main, so there is no corresponding
main test for the lesson's unmodified-main comparison. Existing main assertions
were preserved. Rebase onto local main was already current.

Verification:

- `node docs/reports/evidence/ENG-274-R344/reproduce.mjs plain`: 309 passed,
  no failures or skips; 146.494 seconds.
- `node docs/reports/evidence/ENG-274-R344/reproduce.mjs outer`: 309 passed,
  no failures or skips; 151.210 seconds. One gate attempt, no watchdog
  timeout, and the outer scratch slot released.
- Both executions covered every watchdog, test-slot, gate-profile, promote and
  release test file, plus lane validation and release-suite runner tests. The
  existing memory-fixture preload was retained. The outer run deliberately
  inherited both 7200-second wait variables and the retry marker.
- The real `<git common dir>/gate-watchdog` was absent before and after both
  runs. The quarantine still contained its 125 JSON files and was not restored.
- `git diff --check` passed. Host execution was approved for offline native
  watch/socket/PTY probes; no real host test slot was acquired.

The sample-count and sanity-floor defence remains in place: three usable samples
are required, with minimum durations of 180 seconds for promotion, 300 for release
and 30 for other tiers. The policy cases verify default selection for insufficient
or implausibly short samples. The full-gate numbers are inherited clocks from
the ask and earlier recorded evidence, checked through the resolver offline:

| Gate | Healthy maximum | Empty-history limit | Trained limit | Wall floor |
| --- | --- | --- | --- | --- |
| herdr-brain promotion | 10 min | 75 min | 20 min | 20 min |
| herdr-brain release adapter | 30 min | 75 min | 60 min | 60 min |
| bch-cloak full gate | 39 min | 75 min | 78 min | 10 min |

The default leaves 65, 45 and 36 minutes above these maxima; trained limits
leave twice the respective maximum. No fresh real promotion, release or
bch-cloak gate was timed. No baseline, `npm test`, promotion/release tier,
live acceptance harness or real host slot was run. The existing prepare/preflight
follow-up remains ENG-276.

After checking and committing this report, the last command is
`node docs/reports/evidence/ENG-274-R344/reproduce.mjs lane-check`. It invokes
`lane check` in the fast tier with the six fixture/origin/policy cases on the
committed tree, isolates the wrapper's own history and writes `.lane/gate.json`.
The runner reports real-history absence and rejects only samples attributable
to this verification tree; it does not require unrelated concurrent writers to
leave the entire directory unchanged. This report does not claim that final
receipt already exists.
