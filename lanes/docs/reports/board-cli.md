# Board CLI read interfaces

## Delivered behavior

- `lane board --once [--repo <path>]` now produces its plain snapshot directly
  through dependency-free services owned by `lane.mjs`.
- `lane board --json [--repo <path>]` emits one compact schema-v1 JSON document;
  `lane board --watch --json [--repo <path>]` emits foreground newline-delimited
  documents for the initial sample and observation events.
- `--repo` resolves from the caller, selects the canonical Git repository and its
  layered configuration, and works when the caller is outside a checkout. Duplicate,
  contradictory, unknown, extra, and missing arguments refuse before observation.
- Schema v1 exposes explicit scope/coverage/errors, canonical repository and root
  identity, stable session row IDs, structured Git/gate/report/message state, nullable
  unknowns, and raw host measurements. Gate mismatch and observation staleness remain
  independent; the historical output sample is labeled `pane-output`.
- Watch shutdown on SIGINT, SIGTERM, downstream pipe closure, fatal service error,
  pending snapshot, or pending reconnect permanently closes client requests,
  subscriptions, and timers. Observation sends only snapshot/subscription requests;
  it writes no registry state and performs no focus or lifecycle action.
- The existing Ink entrypoint is unchanged. Its imported board services and the
  dependency-free direct board entrypoint retain their existing behavior.

## Files

- `lane.mjs`: board argument parsing, canonical target selection, one-shot reads,
  JSON framing, foreground watch orchestration, signal and EPIPE cleanup, and usage.
- `board/board.mjs`: structured Git/gate/report/host data, observation error capture,
  timestamped pane output, and schema-v1 document projection.
- `test/lane.test.mjs`: five offline temporary-repository acceptance groups using a
  local fake protocol-20 socket server and an isolated tool copy without packages.
- `README.md` and `docs/REFERENCE.md`: commands, dependency boundary, schema,
  unknown/error semantics, and lifetime behavior.
- `openspec/specs/board-cli-interface/spec.md` and the completed change task: only
  this implemented read-interface delta was synchronized into current specs.

`board/app.mjs` remains byte-identical to its pre-change blob
`7de812842cc65bf0b7cc1b40a74902c2b76d8f08`. No file under `docs/reviews/` changed.

## Negative controls and verification

- Baseline `npm test`: 109/109 passed, zero skips, in 107.459 seconds after a clear
  machine-load probe.
- Before product changes, all five new focused groups failed: canonical `--repo` and
  JSON shape/read-only behavior, built-ins-only operation, duplicate/contradictory
  option handling, localized service errors, and watch framing/teardown. An initial
  sandboxed attempt could not create local sockets; the repeated offline run with
  local Unix-socket access reached product behavior and passed 0/5.
- Focused post-change run: 5/5 passed in 1.704 seconds. It exercised split and batched
  frames plus SIGINT/SIGTERM, pending snapshot, pending reconnect, and closed-consumer
  shutdown.
- Complete post-change `npm test`: 114/114 passed, zero skips, in 110.725 seconds.
  The retained client cases cover split/batched responses, timeout, Herdr error
  bodies, close-before-reply, and subscribe-after-permanent-close.
- Final pre-commit `npm test`: 114/114 passed, zero skips, in 108.233 seconds.
- `LANE_TEST_NEGATIVE_CONTROL=1 npm test`: all 114 controls failed with zero passes
  in 100.707 seconds.
- Strict OpenSpec validation passed 18/18 with telemetry disabled and concurrency one.
  `git diff --check`, the added-line public-safety scan, and the unchanged-UI check
  passed.
- Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. Every test or
  validation run followed a clear process probe and ran alone.

## Limits and approval

The new tests use an offline fake local Herdr server; no live board snapshot/event or
Herdr mutation, real TTY, Linux/Windows host, or observation interval longer than the
bounded teardown cases was exercised. This phase remains repository-scoped and
registered-session-only: machine discovery, semantic messages, actions, UI rewiring,
and asynchronous bounded multi-repository sampling remain later changes. No contract
amendment or further approval is needed for this read-only delta. Promotion,
archival, and any independent review remain operator actions; nothing was pushed or
published.

## Round 2 review corrections — 2026-09-09

The authoritative Round 1 review of `7bee6e8` returned PASS with three Minor
findings. This follow-up resolves all three without changing the schema or command
surface:

- `board/board.mjs` now resolves branch names through one helper and resolves each
  session's workspace, agent, runtime, Git, report, and branch context through one
  shared helper consumed by both the plain/UI and JSON projections.
- `lane.mjs` suppresses Git's raw stderr while probing the board `--repo` target, so
  an invalid path emits only `lane: not inside a git repository`.
- `test/lane.test.mjs` protects the shared-resolution structure, exact invalid-repo
  diagnostic, board usage lines, and README command-table row.

Baseline `npm test` passed 114/114 in 120.026 seconds. Before product edits, the
focused run passed the already-correct documentation assertion and failed the two
new product expectations; its deliberate-control companion failed all three selected
tests with zero passes. After implementation the focused run passed 3/3. Final-tree
`npm test` passed 115/115 in 112.191 seconds, and
`LANE_TEST_NEGATIVE_CONTROL=1 npm test` failed all
115 controls with zero passes in 102.931 seconds. Strict OpenSpec validation passed
18/18. `git diff --check`, the complete-diff public-safety review, and the unchanged
`board/app.mjs` blob check passed. Runs were serialized after clear load probes.

Verified with Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No live
Herdr behavior, alternate host, UI interaction, push, promotion, archive, contract
amendment, or `docs/reviews/` edit was performed. The original limits remain.

## Round 3 review corrections — 2026-09-09

The authoritative Round 2 review of `2020756` returned PASS with two Minor
findings. Both are resolved without changing the board schema, modes, or UI:

- The repository probe captures Git stderr. Ordinary non-repositories retain the
  exact one-line lane diagnostic, while a distinct cause such as a malformed
  gitfile is emitted after that diagnostic instead of being discarded.
- The shared-context regression no longer reads implementation source. It builds
  one synthetic session state and behaviorally compares normalized workspace,
  agent status/pane, runtime output/tripwire, Git/gate, report, and branch values
  from `joinBoardRows` and `boardSnapshotDocument`.

Baseline `npm test` passed 115/115 in 121.281 seconds. The first focused test run
identified an incomplete synthetic fixture; after adding its required host stats and
before product changes, the behavioral projection test passed while the malformed-
gitfile diagnostic failed as intended. The focused deliberate control failed both
selected tests with zero passes, and the post-change focused run passed 2/2. Complete
`npm test` passed 115/115 in 107.426 seconds; the full deliberate-control run failed
all 115 tests with zero passes in 102.851 seconds. Strict OpenSpec validation passed
18/18. Every test or validation run followed a clear executable-aware load probe.

Verified with Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. The
complete diff, public-safety scan, unchanged `board/app.mjs` check, and
`git diff --check` passed. No live Herdr behavior, alternate host, push, promotion,
archive, contract amendment, or `docs/reviews/` edit was performed. Existing limits
and approval boundaries remain unchanged.
