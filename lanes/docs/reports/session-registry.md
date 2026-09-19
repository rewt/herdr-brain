# Session registry implementation report

Topic: `session-registry`

Measured implementation commit:
`25aeab386ce5714a73f3390be42dd678ccd281e4`

Status: READY for the final post-commit gate, then operator review and promotion.

## Delivered behavior

- Successful dispatch writes one immutable, UUID-named record under
  `<registry>.d/` after startup, cwd verification, and prompt delivery. Records carry
  canonical repository/root identity, actual Herdr identifiers, route, brief, bounded
  goal, report convention, and timestamps without copying prompt bodies.
- Dispatch preflights the canonical repository-local registry before any Herdr call:
  the registry and sidecar must be untracked, gitignored, symlink-safe, and writable.
  Prompt and persistence failures preserve the known outcome, identify live work, and
  never replay or close an agent after an ambiguous or delivered prompt.
- The dependency-free registry reader combines legacy arrays, per-session records,
  and atomic done markers. It assigns stable legacy IDs, retains healthy entries when
  individual files are malformed, and prevents concurrent record or marker updates
  from losing unrelated state.
- The board exposes localized registry errors, marks the selected session by ID, and
  resolves relative reports in the lane checkout before the canonical checkout.
- `lane close` marks every exact repository/topic session done only after the Git
  close succeeds. Refused/failed closes leave metadata unfinished; Git-only close
  creates no registry; post-close metadata failure reports that Git already closed.
- README, REFERENCE, command usage, the current `session-metadata` capability, and the
  change task now describe the implemented boundary. The operator-approved A2 text
  was appended verbatim to the Product contract in `AGENTS.md`; no other amendment
  was applied. Nothing under `docs/reviews/` changed.

## Regression evidence and measurements

- Baseline `npm test` passed 92/92 in 70.739 seconds after a clear process probe.
- The initial seven-group focused run selected one preservation case and six new
  behavior groups: the preservation case passed and all six feature groups failed
  before product changes. A fake-Herdr shell-escaping defect discovered in that run
  was corrected before implementation evidence was interpreted.
- After implementation, the focused feature groups passed. The first expanded full
  run passed 97/101 and exposed four fixture expectations, which were corrected
  without weakening production safeguards.
- The repository-wide deliberate negative-control run then failed all 101 selected
  controls with zero passes in 90.125 seconds. The later board-completion safety
  regression's focused deliberate control also failed as intended: zero passes, one
  failure, and 79 name-filtered skips in 0.122 seconds.
- Final `npm test` passed 102/102 with zero skips in 101.776 seconds. The concurrency
  case completed in 0.070 seconds while retaining a legacy entry, two independently
  written session records, and three simultaneous completion attempts including a
  repeated same-session mark.
- An earlier 101-test no-Herdr run passed 100 tests with one explicit unavailable-
  Herdr skip in 130.124 seconds. All fake-Herdr behavior remained offline and used
  system-temporary fixtures with cleanup.
- Strict OpenSpec validation passed 17/17. Staged `git diff --check`, complete added-
  text privacy scanning, and review of the full staged diff were clean.
- Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.

## Remaining limits

No live Herdr mutation, real concurrent dispatch against a daemon, alternate host,
filesystem race, Linux/Windows run, push, promotion, archive, or independent review
was performed. Permission and persistence failures use controlled offline filesystem
fixtures rather than an operating-system fault injector. The registry remains
gitignored display metadata and cannot authorize scheduling, retries, validation,
promotion, pushing, deletion, or any background coordination.

## Round 2 review corrections

The authoritative Round 1 review of `10103cd99582f1b9ff6e14c00a01bd334694c8a0`
reported two Moderate and five Minor findings. All seven are addressed in measured
correction commit `1c7129a3caaed5af1f6a573254ab8738e291c96e`:

- tracked-registry detection now reads the canonical checkout's index even when the
  command is invoked from a lane worktree;
- close warns about localized unrelated read errors while continuing healthy matching
  done markers, and an actual done-marker write failure remains a nonzero post-close
  metadata failure;
- registry containment runs before symlink inspection, symlink and unwritable errors
  name corrective configuration actions, and the post-delivery pass uses a throwing
  realpath helper so every failure reaches the live-agent partial-success report;
- inline ATX headings receive the same outside-fence extraction and syntax removal as
  file briefs, and the unused board-model import was removed.

The 102-test baseline passed in 95.625 seconds. Before product edits, the focused run
produced seven intended failures and one preservation pass with 76 filtered skips in
22.415 seconds. Afterward all eight selected tests passed in 20.965 seconds. Final
`npm test` passed 106/106 with no skips in 99.146 seconds; the deliberate-control run
failed all 106 with zero passes in 95.005 seconds; and the no-Herdr run passed 105 with
one explicit skip in 142.780 seconds. Strict OpenSpec validation passed 17/17.

No live Herdr mutation, alternate host, push, promotion, archive, or review-record
change was performed. The Round 1 public projection failure was outside this change;
the private record supplied by the facilitator was read in full and used as the
correction authority.

## Round 3 review corrections

The authoritative Round 2 review of `fcd2810f01232e71a2e5b5cbcc3e816b5a4a577b`
confirmed all seven Round 1 findings resolved and reported one Moderate and three
Minor findings. Correction commit `e5d3dcfdb1c90a0542ff1f25978b8f9ca8714180`
addresses all four:

- successful Git close now treats external, unignored, and tracked registry
  preflight refusals as actionable warnings with exit zero, while the existing
  done-marker obstruction regression retains nonzero write-failure behavior;
- inline goals select the first nonempty line outside fenced content, remove ATX
  syntax only when that line is a heading, retain prose before later headings, and
  fall back to the topic for fence-only input;
- one exported Herdr socket-path helper supplies both the board client default and
  dispatch record writer; README, REFERENCE, the design, delta, and current spec are
  synchronized to the corrected boundaries.

The branch was first rebased onto main at
`4e55e4c4277b5a8dbb2a3413316930d6bc4af7a5`; HANDOFF retained the session and
review-cli entries in commit-time order. The facilitator-owned Round 2 public record
was carried through unchanged as blob `ab07a6302c768133f8851e6b34508a5b2bb9438c`.
No file under `docs/reviews/` was edited.

After the rebase, baseline `npm test` passed 107/107 in 99.440 seconds. The focused
pre-product run failed all three new tests with 84 filtered skips in 3.288 seconds:
the inline goal selected a later heading, the shared helper was absent, and external
registry close exited nonzero. After implementation, those three plus the existing
fatal marker-write boundary passed with 83 filtered skips in 7.381 seconds.

Final `npm test` passed 109/109 with no skips in 102.306 seconds. All 109 deliberate
negative controls failed with zero passes in 98.812 seconds. With Herdr excluded from
`PATH`, 108 passed and the one live-Herdr guard skipped with its explicit reason in
105.630 seconds. Strict OpenSpec validation passed 17/17. Worktree and full-lane
`git diff --check`, delta/current-spec equality, and the added-line public-safety scan
were clean. Every build/test/validation run followed a clear process probe and ran
alone.

No live Herdr mutation, alternate host, filesystem fault injection, Linux/Windows
run, push, promotion, or archive was performed. A2 remains the only amendment and is
unchanged. The final clean-commit gate remains conversation-only evidence.
