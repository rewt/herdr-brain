# Development-root configuration implementation

Date: 2026-09-09
Lane: `lane/roots`

## Outcome

Implemented bounded root configuration without moving existing worktrees. `lane`
now loads the nearest eligible parent `.lane.json` and then the canonical repository
file, or exactly the file selected by `LANE_CONFIG`. Top-level repository values
replace parent values, while routes merge by name with whole-route replacement.

The new `worktree_root` key is a shared base resolved relative to its defining file;
new lane paths append the canonical repository basename. `LANE_WORKTREE_ROOT` keeps
its prior final-container meaning and caller-directory-relative behavior. A parent
file without the key derives `.worktrees/<repo-name>`, and absence of a parent keeps
the legacy home default.

`lane config` prints sorted `key<TAB>JSON-value<TAB>source` rows without running
configured commands or contacting Herdr. Configuration errors now name the selected
file and stop before lifecycle actions. Occupied ordinary directories and foreign
worktrees remain untouched, and all lifecycle operations continue to locate existing
lanes from git's worktree registry. The isolated board receives its resolved canonical
`main` and `registry` values through explicit child-process flags, without replacing
the public `LANE_CONFIG` environment contract or creating a temporary config file.

## Files and behavior

- `lane.mjs`: added discovery, validation, shallow/source-aware merging, root
  precedence, `lane config`, canonical board configuration, and existing-path reuse;
  Round 2 removed the board temp-file bridge and made unusual route keys TSV-safe.
- `board/args.mjs`, `board/cli.mjs`, and `board/app.mjs`: accept explicit resolved
  `--main` and `--registry` settings from the lane bridge while preserving the normal
  configuration environment for future descendant lane commands.
- `test/lane.test.mjs`: added offline temporary-repository coverage for every root
  source, both relative origins, parent boundaries, replacement rules, linked
  invocation, explicit bypass, invalid files, TSV attribution, board inheritance,
  occupied destinations, and unchanged registered locations; Round 2 discriminated
  the nearest-parent cutoff, the legacy explicit-config default, and TSV escaping.
- `board/test/board.test.mjs`: added an offline CLI regression for explicit main and
  registry flags overriding the entrypoint's local configuration.
- `.lane.json.example`, `README.md`, and `docs/REFERENCE.md`: documented the new key,
  command, discovery/merge rules, path matrix, environment compatibility, sources,
  strict failures, and recovery guidance.
- `openspec/specs/root-configuration/spec.md`: synced only the implemented delta into
  the current specification.

## Negative controls

- Untouched baseline: 49/49 tests passed in 5.155 seconds.
- Before product changes, the expanded 57-test suite passed 50 and failed seven new
  configuration/discoverability tests. The registered-path test was the preservation
  control; the combined occupied/foreign-path test failed on its new root behavior.
- A later focused board test failed because linked invocation used the linked default
  registry instead of the inherited canonical registry; it passed after the board
  handoff was corrected.
- In Round 2, the 51-test focused suite passed 49 and failed the two new behavior
  regressions: board entrypoints ignored explicit main/registry flags, and a route key
  containing controls split its TSV record. The nearest-parent and two explicit-config
  fallback assertions passed before code changes as coverage-only controls.
- In the first round, `LANE_TEST_NEGATIVE_CONTROL=1` made all 58 tests fail
  deliberately (zero passed) in 7.224 seconds. The Round 2 run likewise made all 60
  tests fail deliberately (zero passed) in 9.990 seconds.

## Verification and measurements

- Final `npm test`: 60/60 passed, zero skips, in 8.727 seconds.
- Herdr-unavailable `npm test`: 59 passed and one explicitly skipped with
  `herdr is absent; herdr-dependent tests are skipped`, in 12.924 seconds.
- Strict OpenSpec 1.6.0 validation: 12/12 items passed with telemetry disabled and
  concurrency one.
- `git diff --check`: clean.
- Added-line public-safety scan: no host-specific or private-source patterns found.
- Environment: Node.js 20.19.4, npm 10.8.2, git 2.54.0.
- Build/test commands were serialized. Process probes were clear before the normal
  and negative suites; three unrelated Vitest workers appeared before the unavailable
  suite, so verification waited for them to exit and rechecked before proceeding.

## Limits and approval

No live dispatch, real interactive board session, Linux host, Windows host, unreadable
regular-file permission model, or concurrent path-creation race was exercised. The
unreadable-file regression uses a selected directory for a portable read failure.
Git submodule checkouts remain unsupported because their common directory may resolve
inside the superproject's `.git/modules`, selecting the wrong configuration root and
repository name.
Broader canonical realpath identity, root labels/accounts, workspace-label changes,
and migration tooling remain outside this Phase 1a task. No independent review was
requested for Round 2; the independent review of `1ebcc02` returned READY with no
blocker, and its facilitator-owned record remains unchanged.

Roots-config requires no product-contract amendment. No further approval is needed
for this implemented delta; promotion and later archival remain operator actions.
