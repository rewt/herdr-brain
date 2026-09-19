# HANDOFF

Living log for agents maintaining this repository. Newest entry last.

## 2026-09-06 — initial public release

- Published https://github.com/rewt/herdr-lanes as an MIT-licensed, dependency-free
  Node.js CLI with `.lane.json` configuration.
- Added offline lifecycle coverage for open, status, promote, close, rebase-check,
  prepare, usage exits, EPIPE handling, and the optional Herdr cwd guard.
- Before the CLI fixes, the normal suite passed 13/15: no-command usage exited 0 and
  `status | head` raised EPIPE. Both now exit correctly. Existing behavior assertions
  were exercised with the suite's deliberate negative-control mode.
- Verified with Node.js 20.19.4 and git 2.54.0: 15/15 tests passed with Herdr present;
  with Herdr absent, 14 passed and the Herdr-dependent test skipped.
- Commits: `cbe3a29` (tests and CLI fixes), `bf19edb` (release handoff).

## 2026-09-06 — agent-first operational documentation

- Replaced the README narrative with installation, target-repository configuration,
  Herdr bootstrap, end-to-end lane operation, command syntax, status interpretation,
  promotion checks, recovery actions, and development verification.
- Reworked `AGENTS.md` into portable repository instructions with a file map, product
  invariants, offline-test rules, a repeatable work procedure, and a handoff format.
  Added `CLAUDE.md` instruction discovery and `docs/BRIEF_TEMPLATE.md` for dispatch.
- Generalized `.lane.json.example`, `package.json`, and the `lane.mjs` description.
  Removed the obsolete origin document and stale next-session prompt, and condensed
  earlier handoff notes to public maintenance facts.
- No runtime behavior changed. `npm test` passed 15/15 with Herdr 0.8.2 available;
  with Herdr removed from PATH, 14 passed and one Herdr-dependent test skipped.
- Checked the documented Herdr commands against Herdr 0.8.2 CLI help and the official
  agent setup guide. A current-tree text scan found no former domain or source-context
  references; the copyright holder remains in `LICENSE`.
- Did not run a live end-to-end dispatch, test a non-Node target repository, test on
  Windows, or rewrite existing git history.

## 2026-09-06 — concise workspace and concurrency workflow

- Condensed the README from 296 to 210 lines and made it a linear setup and operating
  guide: install, configure, start the canonical Herdr workspace, open and dispatch a
  lane, run implementation lanes concurrently, promote serially, then close or resume.
- Made the operator/agent boundary explicit: operators manage lanes from the canonical
  checkout; agents work and commit only inside their lane worktrees.
- Documented status fields, overlap handling, per-worktree preparation, the effect of
  one promotion on other lanes, and the exact seven-step promotion gate.
- Added the required user workflow to `AGENTS.md` so future documentation changes keep
  workspace setup, concurrency, and promotion discoverable.
- No runtime behavior changed. Baseline `npm test` passed 15/15 before the edit.
- Did not run live workspace creation or dispatch during this documentation-only slice.

## 2026-09-06 — quick-start landing page

- Reduced the README from 210 to 100 lines. Its opening workflow now shows exactly how
  to install the script, copy configuration into a target repository, provide agent
  instructions, start Herdr, dispatch two concurrent lanes, inspect them, and promote
  and close one lane.
- Kept the public explanation focused on lane use: agents implement concurrently in
  isolated worktrees; the operator promotes lanes one at a time into local main.
- Moved configuration fields, dispatch safeguards, status definitions, failure
  recovery, archive behavior, and unattended promotion to `docs/REFERENCE.md`.
- Updated `AGENTS.md` so future documentation work preserves a short, command-led
  README and keeps technical detail in the reference.
- No runtime behavior changed. Baseline and final `npm test` runs passed 15/15.
- Did not run live workspace creation or dispatch during this documentation-only slice.

## 2026-09-07 — named dispatch routes

- Added `.lane.json` `routes` with per-route `kind`, `model`, `env`, `args`, and
  descriptive `use` fields. `lane dispatch --route` resolves global defaults, the
  named route, and command-line overrides in that order; environment entries append,
  while explicit `--arg` entries replace configured arguments.
- Added `lane routes`, deterministic route-name ordering, resolved route output, and
  early unknown-route errors that report the configured names without calling Herdr.
- Added offline coverage for resolved route kind/model/arguments/`use`, the empty-route
  error, and rejection of an unknown route before the Herdr availability check.
- Before implementation, the expanded suite passed 15/17: `routes` fell through to
  usage and unknown-route dispatch reached the Herdr guard. The addendum's focused
  negative control then failed because route output omitted `use`.
- Documented configuration and precedence, added repository-neutral example routes,
  and recorded model-routing guidance from the official OpenAI and Anthropic pages
  fetched on 2026-09-07. The README quick start now selects a named route.
- Verified with Node.js 20.19.4 and git 2.54.0: normal `npm test` passed 17/17;
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` failed all 17 deliberate controls, including
  both new route controls. `git diff --check` passed.
- Did not run a live route dispatch against Herdr or validate vendor/model availability
  for a particular operator account; the behavior suite remained offline as required.

## 2026-09-07 — post-review route documentation corrections

- Corrected the OpenAI guidance to match the cited models page: Low, Medium
  (default), High, Extra High, Max, and Ultra. Removed `gpt-5.4-mini` from the
  current-routing table and documented its 2026-08-31 Codex retirement for ChatGPT
  sign-in plus the recommended `gpt-5.6-luna` replacement.
- Clarified that command-line `--arg` replaces `dispatch.args` when no route is
  selected and aligned the `routes` usage description with the other commands.
- Extended the offline unknown-route test to cover the exact `(none configured)`
  message and confirm that this path also stops before the Herdr availability check.
- Baseline and final `npm test` runs passed 17/17. The focused unknown-route test
  passed after adding the assertion, showing that this was missing coverage rather
  than a runtime defect. `LANE_TEST_NEGATIVE_CONTROL=1 npm test` failed all 17
  deliberate controls, including the expanded unknown-route control.
- Verified with Node.js 20.19.4 and git 2.54.0; `git diff --check` passed. No live
  Herdr dispatch or account-specific model availability check was performed.

## 2026-09-08 — live lane board

- Added `lane board` as a spawned Ink 5/React child package and dependency-free
  `lane board --once` output. The board joins a repository session registry with
  Herdr agent/pane state, lane ahead/dirty state, report verdict and mtime, deadline,
  output tripwires, last output, and lightweight host metrics.
- Added a protocol-20 Unix-socket client with caller request IDs, one-shot snapshots,
  long-lived agent/output subscriptions, and capped exponential reconnect backoff.
  A live read-only probe verified one request per connection and the ID-less event
  envelopes that follow the `subscription_started` response.
- Added offline tests against an injected in-memory fake socket server plus board model,
  plain rendering, registry update, and CLI coverage. The deliberate pre-implementation
  run failed because both board modules were absent and `board --once` was unknown.
- Documented setup, the optional `.lane.json` `registry` key, registry fields,
  interactive keys, protocol behavior, and limits. The task brief remains excluded
  because it contains host- and account-specific text unsuitable for public tracking.
- Baseline `npm test` passed 17/17 with Node.js 20.19.4 and git 2.54.0. Final
  `npm test` passed 26/26, including the board package tests; `git diff --check`
  passed. Live checks exercised protocol-20 snapshot/subscription handshakes,
  plain output, and Ink startup/quit. No live status-change event was induced, no
  non-macOS host was tested, and no push was performed.

## 2026-09-08 — lane board post-review corrections

- Gitignored `.lane/` and documented that every configured registry path must be
  gitignored, with promotion coverage proving a present registry does not dirty the
  canonical checkout. Lane dirtiness now prefers the target repository's worktree for
  the lane branch and only trusts workspace checkout metadata when repository root and
  branch both match.
- Made Herdr client shutdown permanent, rejected pending requests on close, prevented
  subscriptions after close, and guarded late React refreshes after unmount. Added
  fake-server coverage for split and batched frames, timeouts, error bodies,
  close-before-reply, and subscribe-after-close.
- Replaced JSX/`tsx` with a plain Node.js 20 `React.createElement` entrypoint, added a
  concise non-TTY failure pointing to `--once`, removed the undocumented
  `LANE_BOARD_REPO`, validated missing `--repo` values, and standardized board install
  instructions on `npm --prefix board ci`.
- Corrected worker sampling to use `ps -Ao command=` and executable basenames, showed
  report mtimes without a stray verdict separator, clarified malformed-registry
  errors, named a missing registry under `--once`, generalized the ignored brief
  pattern, and documented that tripwire and last-output values are live-only.
- Baseline `npm test` passed 26/26. Before implementation, the expanded suite passed
  29/37 with eight expected failures covering the main regressions; the malformed
  registry and missing-registry hint controls were also observed failing in focused
  runs before their fixes. Final `npm test` passed 39/39, and
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` failed all 39 deliberate controls, including
  all 18 board-package tests. `git diff --check` passed.
- `npm --prefix board ci` installed 41 packages in under one second with two direct
  dependencies. Removing `tsx` reduced the lockfile from 1,059 to 569 lines and the
  installed package footprint from the reviewed 33 MB to 22 MB. Removed the three
  empty temporary client directories identified by the review.
- Verified with Node.js 20.19.4, npm 10.8.2, and git 2.54.0. No live interactive key
  sequence, live Herdr event, Linux host, or Unicode display-width behavior was tested.
  Async git/process sampling and display-width-aware truncation remain deferred as the
  two non-trivial review nits. No push was performed.

## 2026-09-08 — lane board round-two review corrections

- Removed the unreachable workspace checkout fallback because protocol 20 does not
  provide a worktree branch; git dirtiness now comes only from the target repository's
  worktree registered to the lane branch. Updated the test fixture and implementation
  report to use only protocol fields Herdr sends.
- Counted worker scripts launched by common interpreters using the basename of the
  script argument, and gave the interactive footer the same missing-registry message
  as `--once`. Added negative-controlled tests for both behaviors.
- Added `board/` to the repository map and documented the isolated Ink/React entrypoint
  exception while retaining the built-ins-only rules for `lane.mjs` and tests.
- Baseline `npm test` passed 39/39. Before implementation, the two focused behavior
  tests failed as expected. Final `npm test` passed 41/41, all 41 deliberate negative
  controls failed, and `git diff --check` passed.
- No real-TTY interaction, live Herdr event, or Linux host was tested. No push was
  performed.

## 2026-09-08 — commit-bound validation gates

- Added `lane check [--cmd <validate command>]`, using promotion's existing
  `.lane.json`/`npm test` default and `LANE_VALIDATE` override. It refuses a dirty
  current worktree, atomically records full HEAD, branch, verbatim command, exit,
  UTC timestamps, and numeric duration in `.lane/gate.json`, prints one `GATE` line,
  and returns the validator's exit code.
- Added a board `GATE` column sourced from each registered lane worktree. Matching
  records show the exit and seven-character head, mismatched heads show `STALE`, and
  missing or unusable records show `-`; only Ink colors matching zero/non-zero exits
  green/red.
- Before implementation, all three focused CLI checks and all four focused board
  expectations failed. Final `npm test` passed 44/44;
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed all 44 controls (0
  passed), and `git diff --check` passed. Verified with Node.js 20.19.4, npm 10.8.2,
  and git 2.54.0. The clean-tree gate line is recorded in the implementation report.
- No live Herdr event, real-TTY Ink color sequence, Linux host, or Windows host was
  tested. No push was performed.

## 2026-09-08 — lane check round-two review corrections

- Made `check` run configured preparation before validation, matching `promote`, and
  preserved signal termination as a named `signal` plus shell-compatible
  `exit_code`. Added coverage for both behaviors and for detached HEAD, unknown
  options, missing/empty `--cmd`, and the board's absent `-` state.
- Derived the wide board breakpoint from its columns, passed the exact GATE cell
  offset to Ink coloring, and aligned the multiline `check` usage entry.
- Generalized the `.lane/` gitignore requirement beyond board setup and documented
  that handoff requires re-running `lane check` after the final commit until the
  board shows `exit=0` against current HEAD.
- Before implementation, focused tests failed for prepare parity, signal/null signal
  recording, usage alignment, and board layout. Existing refusal and absent-state
  behavior passed normally, then failed under their deliberate negative controls.
- Baseline `npm test` passed 44/44. Final `npm test` passed 49/49, and
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` deliberately failed all 49 controls (0
  passed), and `git diff --check` passed. Verified with Node.js 20.19.4, npm 10.8.2,
  and git 2.54.0; the post-commit GATE is reported after the final commit. No live
  Herdr event, real-TTY Ink color sequence, Linux host, or Windows host was tested.
  No push was performed.

## 2026-09-08 — roots, live board, and idea-dispatch specification

- Added a minimal OpenSpec configuration/workflow, a current lane-safety spec, and
  nine proposed product changes spanning root configuration/identity, automatic
  session metadata, a CLI board interface, machine discovery, message previews,
  terminal UX, idea dispatch, and a composer. Each change has one complete
  engineer-route lane brief; an optional two-hour mouse research brief is separate.
- Added docs/SPEC-20260908.md with framework comparison, phase acceptance, route/
  effort/dependency table, four decision recommendations, exact proposed contract
  amendments, rollout checklist, and remaining evidence gaps. Linked the workflow
  from README. No product code, tests, package files, or AGENTS.md contract changed.
- Folded in the drafted roots brief and prior board/check reviews. Preserved the
  existing environment-root meaning, proposed canonical config/identity handling,
  collision-safe display records, honest partial failures, and CLI-only UI actions.
  Kept operator configuration and raw private source briefs/reviews out of git.
- Baseline HEAD equaled main at c9d829c. One direct npm test passed 49/49, zero
  failures/skips, in 5.290 s. Runtime/test/package files remain identical to main.
  No product behavior changed, so no product failing test or negative-control suite
  was added/run. The required post-final-commit lane check uses the unchanged npm
  test validator; its exact current-HEAD GATE is reported outside tracked files.
- OpenSpec 1.6.0 strict validation passed all 10 items (nine changes and one current
  spec), with concurrency 1. An initial spec-less research change failed validation;
  inspection showed the installed tool lacks upstream skip_specs support. The final
  research brief is outside product changes, without a fabricated capability.
- Document links, requirement/scenario structure, unchecked task count, and
  public-source text were audited; git diff --check passed. This lane's own
  validation commands were serialized. Verified Node.js 20.19.4, npm 10.8.2, git 2.54.0 and
  read-only Herdr protocol-20 schema/help. No additional framework/package install.
- No implementation agent was dispatched and no live focus, TTY/editor/mouse
  interaction, root rollout, minimum-version host, Linux, or Windows behavior was
  exercised. All implementation and proposed contract approvals remain future work.
  No push performed.

## 2026-09-08 — specification verification load correction

- The first post-commit lane check at 46eceb6 passed 49/49 in 6.601 s, but the
  orchestration mistakenly ran it after a nonzero load probe identified an active
  build elsewhere on the machine. This violated the requested one-build/test rule;
  the passing result does not establish machine-exclusive verification.
- Updated the specification report and this handoff to record that limitation.
  No runtime or test files changed. git diff --check passed.
- Commit this correction, wait until the build/test process probe is clear, then
  run the ordinary lane check once against the final commit and report its exact
  GATE in the conversation. Do not stop or control the other session's processes.

## 2026-09-08 — specification round-two review corrections

- Updated the OpenSpec guide, report and briefs: roots-config needs no amendment;
  A1 describes its placement retroactively in roots-identity. Kept A1-A4 text only
  in the guide. Split board-cli into read interfaces (2b-i) and board-actions
  (2b-ii), with discovery/UX split boundaries and corrected dependency edges.
- Standardized roots-identity/mouse reports, required CLI usage and README-table
  coverage, and bounded workspace labels to 64 code points with safe truncation.
  Added docs/REVIEW-*.md to .gitignore; the pre-edit check did not match, the
  post-edit check matched, and public docs/reviews/ records remain unignored.
- Strict OpenSpec validation passed 11/11 with telemetry disabled and concurrency
  1 after a clear load probe. Links, task counts, public-text review and
  git diff --check passed. No product code, tests, package files or AGENTS.md changed.
- Reused the unchanged e0cb38c baseline: 49/49 tests. Run lane check once after
  this final commit and a fresh clear load probe; report its GATE outside git.
  No live feature, TTY/mouse, rollout or minimum-version checks were performed.

## 2026-09-09 — development-root configuration

- Added nearest-parent plus canonical-repository `.lane.json` layering, with bounded
  home/root discovery, strict selected-file validation, shallow top-level replacement,
  route-name merging, canonical linked-worktree resolution, and exact `LANE_CONFIG`
  bypass. Existing registry/seams/prepare path meanings remain unchanged.
- Added `worktree_root` as a defining-file-relative shared base with repository-name
  placement. Preserved caller-relative `LANE_WORKTREE_ROOT` as the final repository
  container, parent-derived `.worktrees` and legacy home defaults, and git-registered
  paths for every already-open lane operation. Occupied ordinary/foreign paths remain
  untouched and do not create a lane branch.
- Added deterministic source-attributed `lane config` TSV output and documented its
  syntax in CLI usage and the README table. The isolated board now receives resolved
  canonical main/registry settings without exposing route environment values.
- Baseline `npm test` passed 49/49. Before implementation, the expanded suite passed
  50/57 with seven intended failures; the focused inherited-board control also failed
  before its correction. Final `npm test` passed 58/58 in 8.105 seconds. With Herdr
  absent, 57 passed and the one Herdr-dependent test skipped explicitly; all 58
  deliberate negative controls failed.
- Strict OpenSpec validation passed 12/12, `git diff --check` was clean, and an
  added-line scan found no host/private source text. Verified with Node.js 20.19.4,
  npm 10.8.2, git 2.54.0, and OpenSpec 1.6.0. Commands were serialized; the final
  suite ran after a clear build/test process probe.
- No live dispatch, real interactive board, Linux/Windows host, regular-file
  permission denial, or path-creation race was tested. Broader realpath identity,
  root labels/accounts, workspace-label changes, and migrations remain out of scope.
  No contract amendment or additional approval is needed for roots-config; no push,
  promotion, archive, or independent review was performed.

## 2026-09-09 — foreground review and built-in configuration proposals

- Added review-cli and default-config OpenSpec changes, each with one complete
  engineer-route brief. Updated the report table, rollout checklist and guide;
  stated that interactive UI is Ink in the terminal with no browser UI planned.
- Review uses explicit rounds and PASS/NEEDS-WORK/FAIL, full-SHA/schema checks,
  witnessed test claims, private-only reviewer output, unchanged HEAD/clean-tree
  enforcement and CLI-authored sanitized public evidence. No automatic fix loop.
- Specified eight overridable built-in routes, engineer-equivalent shipped dispatch,
  built-in source attribution and repository/installed template lookup. Proposed
  exact A5 only in the guide; default-config requires approval after review-cli.
  Review-cli follows roots-config promotion to serialize lane.mjs edits.
- Strict OpenSpec validation passed 13/13 after a clear load probe, telemetry off
  and concurrency 1. Links/anchors, single-task structure, public-text review and
  git diff --check passed. Product code/tests/packages/AGENTS.md remain unchanged;
  no product negative-control run was warranted. Reused the clean 55cd44c 49/49 gate
  baseline; reserve one lane check for the final commit after a fresh clear probe.
- CLI help and official Codex docs informed effort syntax; installed-client max
  support, live reviews, agent/account availability and sanitization implementation
  remain unverified future work. No source brief was copied and no push performed.

## 2026-09-09 — development-root configuration review corrections

- Replaced the board's temporary `LANE_CONFIG` file with explicit resolved `--main`
  and `--registry` flags consumed by both isolated board entrypoints. Linked-worktree
  board runs still target the canonical checkout and inherited registry, while future
  descendant lane commands retain layered configuration resolution; no signal-cleanup
  path remains necessary because no temporary config is created.
- Strengthened offline coverage for the nearest-parent cutoff and explicit
  `LANE_CONFIG` without `worktree_root`. Added an explicit board-option regression and
  escaped control characters in `lane config` route keys so TSV rows stay three-field
  and single-line.
- Documented the canonical board retarget, trusted parent shell-command boundary,
  route-key escaping, and unsupported Git-submodule identity. Corrected the report's
  preservation-control wording and recorded the READY review of `1ebcc02`; the
  facilitator-owned review record was not modified.
- Before Round 2 code changes, the focused 51-test suite passed 49 and failed exactly
  the board-option and TSV-key regressions. The nearest-parent and explicit-config
  assertions already passed and serve as coverage-only controls.
- Final `npm test` passed 60/60 in 8.727 seconds. All 60 deliberate negative controls
  failed in 9.990 seconds. With Herdr removed from `PATH`, 59 passed and the single
  live-Herdr guard skipped with its explicit reason in 12.924 seconds. Strict OpenSpec
  validation passed 12/12 with telemetry disabled and concurrency one.
- Verified with Node.js 20.19.4, npm 10.8.2, git 2.54.0, and OpenSpec 1.6.0. Tests were
  serialized; the unavailable run waited for three unrelated Vitest workers to exit.
  No live dispatch, interactive TTY board, submodule checkout, Linux/Windows host,
  permission-denial model, or path-creation race was exercised. No new approval is
  needed; promotion and archival remain operator actions, and nothing was pushed.

## 2026-09-09 — specification third-review corrections

- Rebased lane/spec onto promoted roots-config main at 5da8868, preserving both
  handoff histories in commit-time order and the facilitator's d0c4e53-r3 review
  record byte-for-byte. It remains historical evidence for its original SHA.
- Updated review-cli/default-config proposals, designs, deltas, briefs, guide and
  report: named independent split boundaries; deterministic sanitization/refusals;
  system-temp-only reviewer fixtures; exact exit-2 errors and publication recovery;
  route prerequisites, map maintenance, A3/A5 wording and review-effort ratification.
  Added MODIFIED root-configuration blocks for built-in precedence/provenance.
- Strict OpenSpec validation passed 14/14 after a clear load probe, telemetry off
  and concurrency 1. Links/anchors, task/split structure, retained current scenarios,
  public-text inspection and git diff --check passed. Product code, tests, packages
  and AGENTS.md match main; no product negative control was warranted for prose.
- Reused promoted main's 60/60 baseline; reserve one lane check for the final commit
  after a fresh clear load probe and report its GATE outside git. Sanitizer/defaults
  implementation, live review/Herdr, client support and minimum-version hosts remain
  unverified. No push or product implementation.

## 2026-09-09 — repository-safe roots identity

- Made the real absolute Git common directory authoritative for repository ownership,
  resolved the canonical non-linked checkout (including a primary checkout with a
  separately stored Git directory), and verified every created or registered lane's
  identity and branch before use. Existing verified legacy paths remain in place.
- Added pre/post realpath guards for selected bases and lane destinations. Open now
  refuses symlink escapes, canonical/registered/foreign checkout descendants, and
  shared-base foreign occupants before mutation, with no temporary fallback or
  automatic cleanup/adoption.
- Verified Herdr `repo_key`, `repo_root`, `checkout_path`, and linked status before
  using opaque parent/lane workspace IDs. Linked invocation targets the canonical
  repository workspace; stale foreign metadata is not used for dispatch or close.
  Added 64-code-point grapheme-safe root/repository/topic labels with collision
  digests and 32-character identity-aware randomized agent names.
- Appended operator-approved Amendment A1 verbatim to the `AGENTS.md` Product contract;
  no other amendment was applied. Documented the behavior and synced only the
  repository-identity delta into the current OpenSpec capability.
- Baseline `npm test` passed 60/60. Before implementation, the expanded suite passed
  59/67 with eight intended failures covering the new acceptance fixtures. Final
  `npm test` passed 67/67 in 13.483 seconds; all 67 deliberate negative controls
  failed in 15.889 seconds. With Herdr absent, 66 passed and the single live guard
  skipped with its explicit reason in 13.675 seconds.
- Strict OpenSpec validation passed 13/13 with telemetry disabled and concurrency one;
  `git diff --check` and the public added-line scan passed. Long Unicode fixtures
  produced distinct 62-code-point labels under the 64-point limit, and exercised
  agent names were 32 characters. Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0,
  OpenSpec 1.6.0, and installed Herdr protocol fields.
- Tests/validation were serialized after clear process probes; the no-Herdr run waited
  for another lane's Cargo test. No live Herdr mutation, real-TTY rendering, forced
  digest collision, path race, bare repository, linked separate-Git-dir invocation,
  Linux, or Windows was exercised. No additional approval is needed; review,
  promotion, and archival remain operator actions, and nothing was pushed or written
  under `docs/reviews/`.

## 2026-09-09 — repository-safe roots identity review corrections

- Rebased onto main at `ada3157`, retained both HANDOFF histories in chronological
  order, and carried the facilitator-owned review record through unchanged. Amendment
  A1 remains verbatim in the Product contract; no other amendment was applied.
- Made canonical-checkout absence non-fatal for bare-plus-linked `config` and `status`
  reads while guarding mutations; distinguished missing registered worktrees with
  `git worktree prune` guidance; and reported one Git-only close note for mismatched
  Herdr metadata.
- Consulted live agent names before start, reused one Herdr workspace listing until a
  mutation needs refresh, removed the no-op worktree-list quoting flags and redundant
  stem slice, restored verbatim spec sync, and documented the legacy-home refusal.
- Five focused tests failed before the Round 2 product changes and passed afterward.
  The Round 1 evidence is corrected to nine changed expectations, not eight. Final
  `npm test` passed 69/69 in 13.684 seconds; all 69 deliberate controls failed in
  13.441 seconds; and the no-Herdr run passed 68 with one explicit skip in 13.500
  seconds. Strict OpenSpec validation passed 15/15; `git diff --check` and the
  public-safety scan were clean.
- Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, OpenSpec 1.6.0, and Herdr 0.8.2.
  No live Herdr mutation, forced digest/name collision, real TTY, linked separate-Git-
  directory invocation, Linux, or Windows run was performed. Promotion and archival
  remain operator actions; nothing was pushed or changed under `docs/reviews/`.

## 2026-09-09 — repository-safe roots identity promotion-test correction

- Reproduced the promotion failure by injecting `user.name=Leaked` through Git's
  environment-level configuration: 68/69 tests passed and the repository-identity
  fixture alone failed because the injected name overrode its local test identity.
- Kept the correction test-only. Fixture Git and lane children now remove inherited
  `GIT_CONFIG_*`, author, committer, and `EMAIL` variables, then use an empty
  system-temp global config with system configuration disabled. Audited the new
  identity, HOME-boundary, bare/linked, separate-Git-dir, and direct-Git fixtures.
- The identical injected-config run then passed 69/69 in 13.277 seconds. Ordinary
  `npm test` passed 69/69 in 18.821 seconds, and all 69 deliberate negative controls
  failed with zero passes in 21.115 seconds. Tests waited for clear process probes;
  no product code or review record changed, and nothing was pushed.

## 2026-09-09 — Herdr workspace snapshot refresh

- Refetched the authoritative Herdr workspace list before accepting worktree metadata,
  preventing `open` after a Git fallback and `dispatch` from comparing a newly visible
  workspace against a stale pre-create snapshot.
- Added offline fake-Herdr coverage for a failed create that still registers workspace
  metadata and for metadata becoming visible between dispatch listings. Both focused
  tests first failed with the stale-metadata refusal and include deliberate negative
  controls.
- Baseline `npm test` passed 69/69. Final `npm test` passed 71/71 after a clear load
  probe, and `git diff --check` passed. No live Herdr mutation was performed, no
  review feature work is included in this correction, and nothing was pushed.

## 2026-09-09 — foreground review R-i private evidence

- Added one foreground `lane review` dispatch with explicit source/round, captured
  full HEAD/base/gate context, route and deadline handling, private-path safeguards,
  strict `lane-review/v1` validation, unchanged-lane enforcement, and exact PASS,
  NEEDS-WORK, FAIL, or refusal outcomes. R-i creates no public record.
- Added the packaged plain-ASCII review-only template and documented its mandatory
  private write, zero-or-finite command budget, witnessed test claims, system-temp
  fixtures, forbidden lane/public/commit actions, and canonical verdict vocabulary.
  Usage, README, REFERENCE, shared guide, repository map, implementation report and
  current R-i OpenSpec requirements are synchronized. The combined task is unchecked.
- Five focused groups failed before implementation. Final `npm test` passed 77/77 in
  23.952 seconds; all 77 deliberate controls failed with zero passes in 25.125
  seconds; strict OpenSpec validation passed 16/16. Each run followed a clear load
  probe and ran alone.
- No real reviewer/live Herdr mutation, alternate host, filesystem race, semantic
  evidence verification, sanitizer, public projection, or publication boundary was
  exercised. Public review evidence remains a manual operator artifact until R-ii.
  Nothing was pushed, promoted, archived, or written under `docs/reviews/`.

## 2026-09-09 — foreground review R-ii public projection

- Added deterministic sanitization and bounded public projection after private schema
  validation and the unchanged-lane check. Repository/POSIX/drive/UNC/file-URL paths,
  OS user/home/host aliases and declared private tokens use fixed placeholders with
  exact counts, longest-first precedence, protected locations and idempotent rescans.
- Enforced plain-ASCII payloads and fail-closed ambiguity, markup, encoding, residual,
  reserved-placeholder, line/size and schema checks. Analysis/private identifiers are
  omitted. The CLI creates the public record exclusively, leaves it untracked, and
  rechecks HEAD/branch plus the exact single new file before any verdict.
- Five focused R-ii groups failed before implementation; final-audit relative-path
  preservation and repository-prefix controls also failed before their matcher fixes.
  Final `npm test` passed 81/81 in 35.956 seconds; all 81 deliberate controls failed
  with zero passes in
  35.876 seconds; strict OpenSpec validation passed 16/16. Tests and validation ran
  alone after clear load probes with Node.js v20.19.4, npm 10.8.2, Git 2.54.0, and
  OpenSpec 1.6.0. R-i's post-commit gate passed 77/77 at `76cb545`.
- README, REFERENCE, shared protocol, current OpenSpec and the implementation report
  now describe the complete boundary, including late-publication/same-round recovery.
  The combined change task is complete. No live reviewer/Herdr mutation, alternate
  host, semantic secret proof, push, promotion, archive, or `docs/reviews/` change was
  performed.

## 2026-09-09 — foreground review round-two corrections

- Fixed compact section extraction, applied all public payload restrictions to finding
  locations, delayed literal source insertion until metadata validation, narrowed the
  unwitnessed test-claim guard, and added reviewer agent/tab identifiers to timeout and
  interruption recovery messages. REFERENCE now describes the shipped public boundary
  and the finding-location policy.
- Seven focused expectations failed before the changes and passed afterward, each with
  a deliberate control. Final `npm test` passed 85/85 in 42.164 seconds; all 85
  deliberate controls failed with zero passes in 42.452 seconds; strict OpenSpec
  validation passed 16/16. Runs were serialized after clear process probes using
  Node.js v20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or change
  under `docs/reviews/` was performed. The post-commit lane check remains the final
  untracked verification step.

## 2026-09-09 — foreground review round-three corrections

- Trimmed trailing blank-line runs at review section boundaries, added a specific
  Findings-spacing refusal for internal blank lines, and changed finding idempotence
  checks to use the captured description and fix fields so relative locations with
  spaces publish correctly.
- Three focused expectations failed before implementation and passed afterward, each
  with a deliberate control. Final `npm test` passed 88/88 in 52.668 seconds; all 88
  deliberate controls failed with zero passes in 49.173 seconds; strict OpenSpec
  validation passed 16/16. Every run followed a clear process probe and ran alone.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or change
  under `docs/reviews/` was performed. The post-commit lane check remains the final
  conversation-only verification.

## 2026-09-09 — foreground review round-four corrections

- Unified private-record and section newline normalization across completion and
  validation, including last-non-empty-line marker detection. A 39-run boundary
  matrix covers zero, one, and two blank lines throughout the record; the separately
  tested refusal for blank lines between Findings entries is now documented.
- Contained unexpected top-level review failures with exit 2, empty stdout, and one
  path-free diagnostic; a vanished post-dispatch worktree regression verifies that
  late private evidence is retained without leaking Git's raw error.
- Three of four focused expectations failed before implementation; the fourth
  confirmed the retained Findings-spacing rule. Final `npm test` passed 90/90 in
  71.879 seconds; all 90 deliberate controls failed with zero passes in 74.921
  seconds; strict OpenSpec validation passed 16/16. Runs were serialized after clear
  load probes.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or
  `docs/reviews/` change was performed. The post-commit lane check remains the final
  conversation-only verification.

## 2026-09-09 — foreground review round-five corrections

- Made completion detection strictly more permissive than validation by trimming
  trailing whitespace before the marker comparison. Accepted boundary fixtures all
  traverse the probe, while whitespace-only, tab-only, and CRLF malformed endings
  now fail fast with schema diagnostics instead of timing out.
- Expanded unexpected-error recovery wording to require inspection of potentially
  retained private and public evidence, with an injected post-publication failure
  proving exit 2, empty stdout, path-free output, and public-record retention.
- Documented consecutive entries for Findings, Non-claims, and Unverified and synced
  the completion invariant into the review design and both specs. Final `npm test`
  passed 92/92 in 70.787 seconds; all 92 deliberate controls failed with zero passes
  in 70.762 seconds; strict OpenSpec validation passed 16/16.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or
  `docs/reviews/` change was performed. The post-commit lane check remains the final
  conversation-only verification.

## 2026-09-09 — concurrent session registry and close completion

- Added immutable per-session dispatch records and atomic done markers alongside
  legacy registry arrays. Dispatch records only after verified startup/cwd/prompt,
  refuses unsafe registry paths before Herdr, reports partial persistence honestly,
  and never replays delivered work. The board merges both formats, exposes localized
  errors, marks by session ID, and resolves lane reports before canonical fallback.
- Successful Git close now marks all exact repository/topic sessions done; dirty or
  failed archive paths leave them open, no-registry close remains Git-only, and a
  post-close write failure says the lane is already closed. README, REFERENCE, usage,
  current OpenSpec, task state, and `docs/reports/session-registry.md` are synchronized
  at implementation commit `25aeab386ce5714a73f3390be42dd678ccd281e4`.
- Appended the operator-approved A2 text verbatim to the Product contract in
  `AGENTS.md`; no other amendment was applied. No file under `docs/reviews/` changed.
- Baseline `npm test` passed 92/92. Six new focused feature groups failed before
  product changes while one preservation control passed; a fake-Herdr escaping defect
  was corrected before interpreting that evidence. The 101-test deliberate-control
  run failed all tests in 90.125 seconds, and the later focused board-safety control
  failed its one selected test with 79 filtered skips in 0.122 seconds.
- Final `npm test` passed 102/102 with zero skips in 101.776 seconds. The concurrency
  case retained one legacy entry, two concurrent records, and all three simultaneous
  completion attempts in 0.070 seconds. The earlier no-Herdr matrix passed 100/101
  with one explicit skip in 130.124 seconds. Strict OpenSpec validation passed 17/17;
  staged diff checks and the public-text scan were clean.
- Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No live Herdr
  mutation, daemon-backed concurrent dispatch, alternate host, filesystem race,
  Linux/Windows run, push, promotion, archive, or independent review was performed.

## 2026-09-09 — review command-string and round-five follow-up

- Exempted Re-executed command and witness-command strings from only the prose markup
  and encoded-text checks. Their remaining machine syntax is serialized inside the
  public JSON fence after the unchanged ASCII, reserved-placeholder, path, alias,
  residual and idempotence checks; all prose fields retain the stricter refusal.
- Added a CRLF-specific private-record diagnostic and documented LF-only records plus
  verbatim command rendering in the template and REFERENCE. Updated the review design
  to name Findings, Non-claims, and Unverified as consecutive-line lists and synced the
  command/prose boundary into the change and current specs.
- Added a negative-controlled production regression covering angle brackets,
  redirection, backticks, brackets, emphasis-like syntax, a dollar variable and
  encoded-looking text in both command fields, while the same finding prose refuses.
  Reserved-placeholder and non-ASCII command controls remain refusals. The 39-case
  boundary matrix now uses an explicit two-second timeout.
- Before implementation, focused controls reproduced the command refusal and missing
  CRLF diagnostic, and the documentation control caught the Findings-only design text.
  Baseline `npm test` passed 92/92 in 73.462 seconds. Final `npm test` passed 93/93 in
  81.835 seconds; all 93 deliberate negative controls failed with zero passes in
  73.878 seconds; strict OpenSpec validation passed 16/16; `git diff --check` passed.
- Verified with Node.js v20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. Runs were
  serialized after clear process probes. No live reviewer/Herdr mutation, alternate
  host, push, promotion, archive, or `docs/reviews/` change was performed. The final
  post-commit lane check remains conversation-only evidence.

## 2026-09-09 — session registry Round 2 review corrections

- Addressed both Moderate and all five Minor findings from the authoritative private
  review of `10103cd`: canonical-index tracked checks, warning-only unrelated close
  read errors, fatal done-marker write preservation, containment-before-symlink
  ordering, actionable path guidance, throwing post-delivery resolution, inline ATX
  goals, and the unused board import. Measured correction commit is
  `1c7129a3caaed5af1f6a573254ab8738e291c96e`.
- Seven focused expectations failed before product edits while one preservation case
  passed; all eight passed afterward. Final `npm test` passed 106/106 in 99.146
  seconds, all 106 deliberate controls failed in 95.005 seconds, the no-Herdr run
  passed 105 with one explicit skip in 142.780 seconds, and strict OpenSpec validation
  passed 17/17. Every run followed a clear machine-load probe and ran alone.
- Updated README, REFERENCE, and the implementation report addendum. No live Herdr
  mutation, alternate host, push, promotion, archive, or `docs/reviews/` change was
  performed; the final clean-commit gate remains conversation-only evidence.

## 2026-09-09 — session registry Round 3 review corrections

- Rebased onto main at `4e55e4c`, kept both HANDOFF histories in commit-time order,
  and preserved the facilitator-owned Round 2 record as unchanged blob `ab07a630`.
- Fixed all four Round 2 findings at `e5d3dcf`: close policy refusals now warn after
  successful Git close while marker writes remain fatal; inline goals use the first
  unfenced content line with conditional ATX stripping; one exported socket helper
  supplies both the record writer and board client. Public docs and specs match.
- Three focused tests failed before product edits; afterward those tests plus the
  retained fatal-write boundary passed. Final `npm test` passed 109/109 in 102.306
  seconds; all 109 deliberate controls failed in 98.812 seconds; without Herdr, 108
  passed and one skipped explicitly in 105.630 seconds; strict OpenSpec passed 17/17;
  full-lane diff and public-safety checks were clean.
- A2 remains the sole unchanged amendment. No live Herdr mutation, alternate host,
  push, promotion, archive, or `docs/reviews/` edit was performed. The final clean-
  commit gate remains conversation-only evidence.

## 2026-09-09 — board CLI read interfaces

- Added dependency-free `lane board --json` snapshots and foreground
  `--watch --json`, plus canonical `--repo` targeting for every board mode. The CLI
  owns parsing, configuration resolution, service orchestration, JSON framing, and
  permanent signal/EPIPE cleanup; the existing Ink application is byte-unchanged.
- Added schema-v1 scope, coverage, repositories, rows, host and localized errors with
  stable session IDs, explicit nullable Git/gate/report/message fields, pane-output
  labeling, and separate observation/gate staleness. Reads issue no focus or lifecycle
  action and write no session metadata.
- Five focused groups failed before implementation and passed afterward in 1.704
  seconds. Baseline `npm test` passed 109/109 in 107.459 seconds. The complete updated
  suite passed 114/114 with zero skips in 110.725 seconds, and the final pre-commit
  run passed 114/114 in 108.233 seconds; all 114 deliberate controls failed with zero
  passes in 100.707 seconds. Retained split/batched, timeout,
  error-body and permanent-client-close regressions remain green.
- Strict OpenSpec validation passed 18/18. CLI usage, README, REFERENCE, the current
  capability, completed task and `docs/reports/board-cli.md` are synchronized;
  `git diff --check`, public-safety scanning, and the unchanged `board/app.mjs` blob
  check passed. Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- Runs were serialized after clear process probes. Offline fake sockets were used;
  no live board snapshot/event or Herdr mutation, real TTY, alternate host, machine
  discovery, semantic-message source, action/UI rewire, push, promotion, archive,
  independent review, or `docs/reviews/` change was performed. No contract amendment
  or additional approval is needed; the final clean-commit gate remains
  conversation-only evidence.

## 2026-09-09 — board CLI Round 2 review corrections

- Resolved all three Minor findings from the authoritative PASS review of `7bee6e8`:
  plain/UI and JSON rows now share session context and branch resolution, invalid
  board `--repo` paths suppress Git's raw fatal line, and tests pin the board usage
  text plus README command row. The schema and interactive UI remain unchanged.
- Two focused product expectations failed before implementation; the documentation
  assertion already passed, while the focused deliberate control failed all three
  selected tests. Afterward 3/3 focused tests passed. Final `npm test` passed 115/115;
  all 115 deliberate controls failed with zero passes; strict OpenSpec passed 18/18.
- Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0 were exercised after
  clear serialized load probes. The full diff and unchanged-UI checks were clean.
  No live Herdr behavior, push, promotion, archive, contract amendment, or
  `docs/reviews/` edit was performed; the clean-commit gate remains conversation-only.

## 2026-09-09 — board CLI Round 3 review corrections

- Resolved both Minor findings from the authoritative PASS review of `2020756`:
  repository probing now preserves distinct Git failure causes after the lane
  diagnostic, and the shared-context regression now compares plain and JSON output
  behavior instead of inspecting source text. Ordinary non-repositories remain the
  same concise one-line error; the board schema and UI are unchanged.
- After correcting an incomplete synthetic fixture, the pre-product focused run
  passed the projection equivalence check and failed the malformed-gitfile check;
  both focused controls failed deliberately and both passed after implementation.
  Final `npm test` passed 115/115, all 115 deliberate controls failed with zero
  passes, and strict OpenSpec passed 18/18.
- Runs were serialized after clear load probes. Full-diff, public-safety, unchanged-
  UI, and whitespace checks were clean. No live Herdr behavior, push, promotion,
  archive, contract amendment, or `docs/reviews/` edit was performed; the final
  clean-commit gate remains conversation-only evidence.

## 2026-09-09 — review prose escaping follow-up

- Replaced public prose markup refusal with post-sanitization backslash escaping for
  backticks, asterisks, underscores, square brackets, and angle brackets. Raw payloads
  are sanitized and rescanned before display escaping; generated placeholders remain
  exact, commands remain verbatim in JSON, and finding descriptions containing a
  declared private identifier still refuse.
- Changed the private-only section guard from whole-record substring matching to exact
  heading-line matching, so commands may quote `## Analysis` and
  `## Private identifiers`. Updated the template Role and Required output sections,
  REFERENCE, review change artifacts, current spec, and the implementation report. No
  contract amendment was applied.
- Baseline `npm test` passed 109/109. Before implementation, all three focused
  regressions failed with the production behaviors: prose refusal, incorrect declared-
  identifier publication, and a false private-section leak. Each retained case has a
  deliberate negative control; the corrected six-test focus passed.
- Final `npm test` passed 112/112 in 106.166 seconds, and all 112 deliberate negative
  controls failed with zero passes in 101.011 seconds. Strict OpenSpec validation
  passed 17/17. Runs were serialized after clear process probes with Node.js v20.19.4,
  npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or change
  under `docs/reviews/` was performed. The final post-commit lane check remains
  conversation-only evidence.

## 2026-09-10 — review projection Round 2 corrections

- Made underscores alias boundaries, decoded percent octets and numeric character
  references in a scratch residual rescan, escaped literal backslashes and a generated
  placeholder's adjacent opening parenthesis, and documented the stricter finding
  file-and-line markup/encoding policy. Commands remain verbatim.
- Added negative-controlled coverage for declared and automatic aliases wrapped in
  underscores, two encoded-alias forms, literal backslashes, placeholder link syntax,
  and every finding in a public-safe production-derived PASS fixture.
- The supplied raw PASS record projected successfully through the branch, archived
  main, and the byte-identical installed main entrypoint. No field matched the only
  main check that emits the reported diagnostic, so the historical refusal has no
  reproducible culprit in the record bytes now present; this limitation is explicit in
  the implementation report.
- Baseline `npm test` passed 112/112. Four focused tests failed before product edits;
  the corrected five-test focus passed and all five deliberate controls failed. The
  first full run found one lone `%2F` decoder compatibility edge at 113/114; final
  `npm test` passed 114/114 in 126.783 seconds, all 114 deliberate controls failed in
  120.088 seconds, strict OpenSpec passed 17/17, and `git diff --check` passed.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive, or
  `docs/reviews/` edit was performed. The final clean-commit gate remains
  conversation-only evidence.

## 2026-09-10 — board actions and CLI-client UI

- Added verified `lane board focus <row-id>` and `done <row-id>` actions. Focus
  refreshes the recorded server and refuses missing, replacement, stale, or foreign
  occupants before one non-retried Herdr call; done verifies canonical registered
  metadata and writes only the atomic display completion marker.
- Rewired the unchanged table/navigation onto one foreground CLI observation process
  and one CLI child per explicit action. Split/batched JSON, malformed frames, child
  errors, one-call action routing, and permanent quit during reconnect/refresh are
  covered without direct UI Git, target-file, registry, or Herdr socket imports.
- Applied the operator-approved A3 replacement verbatim to the Product contract in
  `AGENTS.md`; no other amendment was applied. README, REFERENCE, CLI usage, current
  OpenSpec, completed task, and `docs/reports/board-actions.md` are synchronized.
- Baseline `npm test` passed 115/115. Five focused product groups failed before
  implementation; the socket-backed focus case initially hit sandbox `listen EPERM`
  and passed outside that restriction. The affected set later passed 7/7. Before the
  upstream sync the full suite passed 121/121 and all 121 deliberate controls failed.
- Rebased cleanly onto advanced main `a7b0ac7`, retaining its HANDOFF entries first.
  The rebased suite passed 126/126 with zero skips in 113.226 seconds; the seven
  affected deliberate controls all failed in 1.433 seconds; strict OpenSpec passed
  19/19. Runs were serialized after clear probes. Verified Node.js v20.19.4, npm
  10.8.2, Git 2.54.0, Herdr 0.8.2, and OpenSpec 1.6.0.
- No real-TTY UI or live-Herdr mutation was available; both are explicit skips. No
  alternate host, push, promotion, archive, independent review, or `docs/reviews/`
  edit was performed. The final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — board actions Round 2 corrections

- Resolved the Round 1 NEEDS-WORK Moderate and all six Minors: synchronous
  SIGINT/SIGTERM/SIGHUP child teardown with terminal reset and signal re-raise;
  plain/UI lane and pane parity; dynamic-import/child-process boundary guards; parsed
  Herdr focus results with useful failure detail; live-only message documentation;
  `tab_id` parity coverage; and removal of dead board main/registry argument fields.
- Five of six focused groups failed before fixes while the new `tab_id` preservation
  check passed; afterward 6/6 passed. Baseline was 126/126; the corrected suite passed
  127/127 in 111.953 seconds, all 127 deliberate controls failed in 106.290 seconds,
  strict OpenSpec passed 19/19, and whitespace checks passed after clear serialized
  load probes.
- No live action, installed real-TTY UI, alternate host, push, promotion, archive,
  or `docs/reviews/` change was performed. The facilitator-owned Round 1 record is
  unchanged; the final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — hermetic Git test environment

- Isolated shared fixture Git and lane invocations from operator state with temporary
  `HOME` and `XDG_CONFIG_HOME` directories, an isolated global config containing the
  test identity, disabled system config, and removal of inherited Git config-count,
  author, committer, and email variables. Deliberate fixture-home overrides remain
  supported without admitting the operator's home or XDG configuration.
- Added a permanent fake-operator global excludes fixture containing `.lane/` and its
  own deliberate negative control. README and REFERENCE now state that production
  ignored-path policy may be satisfied by repository `.gitignore` rules or the
  operator's global excludes file, while the suite is hermetic to global and system
  Git configuration. No product, board, or OpenSpec specification text changed.
- Baseline `npm test` passed 123/127 in 111.480 seconds and failed exactly the four
  reported registry/review policy tests. With the fixture added before helper changes,
  the focused run failed those same four selected tests with 102 filtered skips; after
  isolation, the fixture plus four regressions passed 5/5. A first full run exposed
  three overwritten fixture-home expectations at 125/128; preserving already-
  hermetic test homes corrected all three in a focused 4/4 run.
- Final `npm test` passed 128/128 with zero skips in 108.182 seconds. The full
  `LANE_TEST_NEGATIVE_CONTROL=1 npm test` run failed all 128 deliberate controls with
  zero passes in 102.720 seconds. `git diff --check` passed. Strict OpenSpec validation
  was not run because no specification text changed.
- Verified Node.js v20.19.4, npm 10.8.2, and Git 2.54.0. Every test run followed a
  clear executable-aware load probe and ran alone. Minimum-version and alternate-host
  behavior remain unverified; no live Herdr mutation, push, promotion, archive, or
  `docs/reviews/` change was performed.

## 2026-09-10 — console UX review and keyboard wireframe

- Added `docs/design/CONSOLE-UX.md` with a region-by-region review, explicit state
  and attention semantics, 80/100/140-column and 24/40-row budgets, keyboard focus
  ownership, empty/error recovery, and concrete replacement paragraphs for the
  board-ux and idea-composer designs. OpenSpec files remain unchanged.
- Revised the supplied single-file `docs/design/lane-console.html`: grouped
  sessions, a stable evidence pane, a compact scope rail at wide sizes, textual
  status/gates, no-color preview, keyboard pickers, multiline task and editable
  topic, explicit launch review, and illustrative partial outcomes. Recommend
  retaining drafts at identity roots while refusing launch until an existing
  repository is selected; no implicit default/scratch repository or facilitator.
- Preserved all eight original session records and every route tuple exactly.
  Replaced personal root/host and other-repository labels with public sample
  aliases; canonical-path examples are synthetic. The fixture has two repositories,
  one non-git bucket and four unique attention rows. Absent model/effort, full-SHA,
  deadline and completion evidence stays explicitly unavailable or unverified.
- Read the original HTML and reference screenshot. No browser was available through
  the browser runtime. Node.js v20.19.4 accepted the revised JavaScript syntax;
  a source-data comparison confirmed preservation and counts. Static HTML IDs and
  local documentation links were checked. The only external asset reference is
  the optional Google Fonts stylesheet. Full-diff/public-text and whitespace
  checks passed with Git 2.54.0.
- Initial load probes found other test-related processes. No npm test, build,
  package install, OpenSpec validation or lane check was run for this authorized
  documentation-only task; lightweight source parsing/comparison followed a later
  clear process probe. No production behavior changed, so no product failing test
  or negative control was applicable. `lane.mjs`, `board/`, `test/`, package files,
  AGENTS.md and all OpenSpec artifacts remain unchanged.
- Browser rendering/input, real terminal sizing/Unicode, editor restoration,
  session focus/discovery, message extraction and launch/partial-result CLI
  schemas remain unverified. The prototype executes no commands and adds no
  sessions. No push, promotion, archive or live Herdr mutation was performed.

## 2026-09-10 — console UX review applied to proposed OpenSpec changes

- Applied the operator-approved replacement text to board UX and idea composer
  designs; synchronized responsive 140x40/100x24/80x24 budgets, stable filtering,
  attention/no-color/evidence/Escape acceptance, composer launch/draft/partial
  outcomes, and updated board-frame/details briefs without completing any task.
- Recorded the identity-root bootstrap refusal in idea-cli design/spec and added its
  dispatch-brief acceptance. There is no implicit default, scratch repository,
  git init, or facilitator start; a future visible default needs a separate proposal
  and still submits explicit `--repo`.
- Schema audit outcome: board-cli already specifies brief excerpt and canonical
  repository/destination-base reads, but needs bounded full-gate metadata; discovery
  needs a public-safe duplicate-label suffix; idea-cli needs recognized effort
  projection and structured lane-new success/partial identities. UI artifacts do
  not assume or invent those fields.
- Changed `docs/SPEC-20260908.md`, board-ux proposal/design/tasks/delta, composer
  design/tasks/delta, idea-cli design/tasks/delta, and the bounded board-cli and
  board-discovery design/delta owners. 3a-i may start before board-messages promotes
  only with honest unavailable message evidence; full UX/composer prerequisites stay
  unchanged.
- Baseline `npm test` passed before documentation edits. After its test process
  cleared, serialized `OPENSPEC_TELEMETRY=0 openspec validate --all --strict
  --no-interactive --concurrency 1` passed 19/19; `git diff --check` and a changed-
  text host-path/user-name scan were clean. No product code, board code, package,
  current OpenSpec capability, or product test changed.

## 2026-09-10 — review CLI precise paths and record settle

- Removed the whitespace-spanning slash ambiguity heuristic. Public review
  sanitization now relies on the concrete contiguous absolute-path matcher, preserving
  a JavaScript regex literal with flags, slash-delimited prose, and an HTTPS-like token
  while still replacing a real external absolute path and refusing a declared alias
  in finding prose.
- Added a two-continuous-second settle check after the private completion marker.
  Size or modification-time changes restart the interval; the CLI re-reads guarded
  bytes immediately before validation and projects only that final read. REFERENCE,
  shared OpenSpec guidance, design, delta, and current spec are synchronized.
- Before product changes, the two focused tests failed as intended: slash prose was
  refused with `projected payload contains an ambiguous absolute path`, and a
  twice-writing fake reviewer returned the first PASS instead of the final NEEDS-WORK.
  Both carry deliberate negative controls and passed after implementation.
- Baseline `npm test` passed 127/127 in 110.784 seconds. Final `npm test` passed
  129/129 in 309.921 seconds; all 129 deliberate controls failed with zero passes in
  295.665 seconds. Strict OpenSpec validation passed 19/19, and `git diff --check`
  passed. Runs were serialized after clear process probes.
- Verified with Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. Main did
  not move from `3367cd5`, so no rebase was required. No live reviewer/Herdr mutation,
  alternate host, same-size/same-mtime adversarial rewrite, push, promotion, archive,
  Unix-socket `listen EPERM`, board-code edit, or `docs/reviews/` change occurred. The
  final post-commit `lane check` remains conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 2 corrections

- Round 2 replaced the closing-delimiter boundary exclusion with temporary
  regex-literal and command-substitution token skipping. Round 4 supersedes that
  historical approach; the current sanitizer has no syntax exemption.
- Added a narrow refusal for a concrete absolute-path match followed by a space and a
  next whitespace token containing a slash or backslash. Raised the explicit review
  timeout minimum to three seconds and corrected the design's settle-before-validation
  wording. REFERENCE and both OpenSpec requirements are synchronized.
- Reduced the 39-invocation accepted-boundary matrix to four representative dispatched
  fixtures while retaining zero/one/two-blank-line and boundary-category coverage.
  The case fell from 113.762 to 11.092 seconds; final `npm test` passed 129/129 in
  235.993 seconds, 102.177 seconds faster than the 338.171-second Round 2 baseline.
- Before production changes, all four focused behavior/documentation groups failed in
  31.819 seconds. After correction they passed in 51.564 seconds, and each retains a
  deliberate `negativeControl`. The final negative run produced zero passes and all
  129 deliberate failures in 234.225 seconds. An earlier complete attempt reported
  `listen EPERM: operation not permitted` in sandboxed board socket coverage; the
  final rerun reached the intended socket controls.
- Strict OpenSpec validation passed 19/19; `git diff --check` and the added-line
  public-text scan passed. Main remained at `3367cd5`, so no rebase was required.
  Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive,
  board-code edit, or `docs/reviews/` change was performed. The final commit and
  single post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 3 corrections

- Removed opaque shell command-substitution skipping while retaining a narrower regex
  exemption at that round. Round 4 supersedes that exemption with unconditional
  concrete path matching because syntax-shaped paths remained ambiguous. POSIX,
  drive-letter, and UNC paths inside command substitutions remain sanitized.
- Extended spaced-path ambiguity checks across separator-free tokens and moved them
  after repository-root conversion. Separator-bearing suffixes refuse, while adjacent
  in-repository absolute paths convert independently. REFERENCE, design, delta, and
  current review specs are synchronized.
- Corrected the compact boundary matrix to cover one and two leading blank lines and
  a zero-blank before-section boundary. The added behavior fixtures failed before the
  production change: three affected groups failed in a 54.040-second focus, and the
  reordered multi-token refusal failed in a 36.417-second focus. Each retains a
  deliberate `negativeControl`; the four-group post-fix focus passed in 76.485 seconds.
- Baseline `npm test` passed 129/129 in 222.803 seconds. Final `npm test` passed
  129/129 with zero skips in 231.430 seconds; all 129 deliberate controls failed with
  zero passes in 221.923 seconds. Strict OpenSpec validation passed 19/19. Runs were
  serialized after clear process probes.
- `git diff --check` and the added-line public-text scan passed. Verification used
  Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No Unix-socket
  `listen EPERM` occurred.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive,
  board-code edit, or `docs/reviews/` change was performed. The final commit and
  single post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 4 corrections

- Deleted the regex-literal scanner and syntax-range replacement helper, leaving the
  previously removed command-substitution helper absent. Every non-placeholder string
  now uses the concrete absolute-path matcher directly, removing 60 net lines from
  `lane.mjs` (10 additions and 70 deletions).
- Matching regex literals and slash-delimited phrases may over-redact to `[ABS_PATH]`
  without refusing the record; reviewers should spell patterns in words. Parentheses
  were removed from the file-URL class so `$()` delimiters remain intact. Existing
  settle, timeout, blank-boundary, ambiguity-ordering, and continuation behavior stays.
- Added separately negative-controlled coverage for syntax-shaped two-segment, deeper,
  drive-letter, character-class, protected-location, slash-phrase, and file-URL forms.
  The seven-test pre-change focus failed four new expectations while three already-safe
  controls passed in 16.245 seconds; all seven passed after correction in 18.853 seconds.
- Baseline `npm test` passed 129/129 in 227.816 seconds. Final `npm test` passed
  135/135 with zero skips in 242.151 seconds; all 135 deliberate controls failed with
  zero passes in 236.331 seconds. Strict OpenSpec validation passed 19/19. Runs were
  serialized after clear process probes.
- REFERENCE, the review template, design, delta, current spec, and implementation
  report document the asymmetric rule and ambiguous spaced-path refusal. Verification
  used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No Unix-socket
  `listen EPERM` occurred.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive,
  board-code edit, or `docs/reviews/` change was performed. The final commit and
  single post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 5 corrections

- Decoded backslash-escaped forward separators during residual and protected-value
  path inspection, closing escaped-path publication in finding prose, locations, and
  commands. Concrete matches followed immediately by an opening parenthesis now
  refuse as ambiguous residue; no syntax exemption was added.
- Added separately negative-controlled cases for each escaped field, parenthesized
  POSIX and file-URL residues, and a relative-looking location. The last case passed
  on Round 4 and failed against an isolated `e1edc15` tool copy, proving it detects
  the earlier exemption. The pre-change six-case focus failed five and passed one in
  13.680 seconds; the general-parenthesis expectation failed alone in 2.860 seconds;
  all seven affected cases passed after correction in 16.219 seconds.
- Baseline `npm test` passed 135/135 in 246.662 seconds. Final `npm test` passed
  140/140 with zero skips in 258.378 seconds; all 140 deliberate controls failed with
  zero passes in 252.556 seconds. Strict OpenSpec validation passed 19/19. Runs were
  serialized after clear process probes.
- REFERENCE, design, delta/current specs, and the implementation report document the
  escaped-separator inspection, parenthesized residue, and matcher-versus-ambiguity
  distinction. Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and
  OpenSpec 1.6.0. No Unix-socket `listen EPERM` occurred.
- No live reviewer/Herdr mutation, alternate host, push, promotion, archive,
  board-code edit, or `docs/reviews/` change was performed. The facilitator-owned
  Round 4 record remains unchanged; the final commit and single post-commit gate
  remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 6 corrections

- Sanitized POSIX paths attached directly to short alphabetic flags in prose and
  commands while preserving the flag, and refused them in protected locations.
  Added token-bounded forward-separator UNC matching and hosted file-URL matching.
  The asymmetric no-syntax-exemption rule remains unchanged.
- Added five separately negative-controlled behavior fixtures across the three
  affected fields and two missing path forms. Extended reviewer-facing refusal
  guidance for ambiguous spaced paths and parenthesized residue, and corrected the
  REFERENCE refusal lead-in to plural.
- The six-test failure-first focus failed all six expectations in 13.536 seconds and
  passed all six after correction in 13.575 seconds. Baseline `npm test` passed
  140/140 in 252.048 seconds. Final `npm test` passed 145/145 with zero skips in
  265.164 seconds; all 145 deliberate controls failed with zero passes in 261.804
  seconds. Strict OpenSpec validation passed 19/19.
- Runs were serialized after clear process probes. No Unix-socket `listen EPERM`
  occurred. No live reviewer/Herdr mutation, alternate host, push, promotion,
  archive, board-code edit, or `docs/reviews/` change was performed. The
  facilitator-owned Round 5 record remains unchanged; the final commit and single
  post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 7 corrections

- Broadened only the short-flag boundary so punctuation-delimited flags redact their
  attached POSIX paths in prose and commands while protected locations refuse. The
  lookbehind still rejects letters, marks, numbers, underscore, dot, hyphen, and path
  separators; no syntax exemption or other matcher change was added.
- Added separately negative-controlled fixtures for backtick-quoted prose, an
  assigned command flag, and a double-quoted location. Extended the existing public
  documentation assertion and REFERENCE's prose-refusal enumeration to include
  ambiguous spaced paths and parenthesized residue.
- The four-test failure-first focus failed all four expectations in 8.287 seconds and
  passed all four after correction in 8.107 seconds. The ordinary inherited baseline
  produced 141 passes and four failures in 266.199 seconds because a user-level Git
  excludes file contains `.lane/`, matching the facilitator's Round 6 warning.
- With global Git and XDG configuration isolated for each command, final `npm test`
  passed 148/148 with zero skips in 275.329 seconds; all 148 deliberate controls
  failed with zero passes in 269.666 seconds. Strict OpenSpec validation passed
  19/19. Runs were serialized after clear process probes.
- Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No
  Unix-socket `listen EPERM` occurred. The five additional base-commit matcher
  candidates remain untouched and out of scope. No live reviewer/Herdr mutation,
  alternate host, push, promotion, archive, board-code edit, or `docs/reviews/`
  change was performed. The facilitator-owned Round 6 record remains unchanged; the
  final commit and single post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 8 corrections

- Refused a concrete absolute-path match followed by a closing parenthesis and an
  immediate non-whitespace suffix. A standalone closing delimiter remains
  publishable, including the command-substitution form, and the asymmetric
  no-syntax-exemption rule is unchanged.
- Added a differential fixture that executes an isolated `3367cd5` tool copy and
  proves the base matcher redacted the whole file URL before checking that the current
  CLI refuses the ambiguous residue. Added a separately controlled standalone-
  delimiter fixture and synchronized REFERENCE, design, delta, and current spec.
- One preliminary historical-tool run stopped on missing temporary board imports and
  was not behavior evidence. After the fixture included those base modules, the valid
  pre-change differential failed because the current CLI returned 0 instead of 2 in
  3.469 seconds; the corrected three-test focus passed in 6.151 seconds. Both new
  behavior fixtures retain their own deliberate `negativeControl`.
- The ordinary inherited baseline produced 144 passes and four failures in 285.989
  seconds from the previously documented user-level Git excludes issue. With global
  Git and XDG configuration isolated, final `npm test` passed 150/150 in 280.990
  seconds; all 150 deliberate controls failed with zero passes in 277.117 seconds;
  strict OpenSpec validation passed 19/19. Runs were serialized after clear probes.
- Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. No
  Unix-socket `listen EPERM` occurred. The five other base-commit matcher candidates
  remain untouched and out of scope. No live reviewer/Herdr mutation, alternate host,
  push, promotion, archive, board-code edit, or `docs/reviews/` change was performed.
  The facilitator-owned Round 7 record remains unchanged; the final commit and single
  post-commit gate remain conversation-only evidence.

## 2026-09-10 — review CLI precise paths Round 9 corrections

- Extended the spaced-path scanner across closing parenthesis, quote, backtick, and
  square-bracket delimiters before a space while preserving standalone closing
  delimiters. Continuation tokens are independently sanitizable only when concrete
  path replacements leave no unmatched separator-bearing prefix or suffix.
- Added differential refusal fixtures for parenthesis, quote, and bracket terminators
  plus an embedded absolute match with a relative path prefix. Replaced the Round 8
  historical tool checkout with retained `3367cd5` matcher and ambiguity-pattern
  fixture data, so the suite no longer requires a source-history object in shallow
  clones. Synchronized REFERENCE, design, delta spec, and current spec.
- Before the production change, the four-test focus failed all four exit expectations
  because the CLI published with exit 0 instead of refusing with exit 2 in 11.095
  seconds. The post-fix six-test focus passed in 16.144 seconds. The documentation
  assertion also failed before the synchronized wording and passed afterward. Every
  new behavior fixture retains its own deliberate `negativeControl`.
- Baseline `npm test` passed 151/151 in 280.962 seconds. Final `npm test` passed
  155/155 with zero skips in 301.755 seconds. The full negative-control run reported
  zero passes and 155 failures in 292.609 seconds; four Unix-socket fixtures emitted
  `listen EPERM: operation not permitted` at a system-temp `board.sock` path instead
  of reaching their deliberate controls. The tests were not changed for this known
  Codex sandbox limitation. Strict OpenSpec validation passed 19/19.
- Runs were serialized after explicit process and load probes. Verification used
  Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. The five previously
  recorded matcher candidates remain out of scope. No live reviewer/Herdr mutation,
  alternate host, push, promotion, archive, board-code edit, or `docs/reviews/`
  change was performed. The facilitator-owned Round 8 record remains unchanged; the
  final commit and single post-commit gate remain conversation-only evidence.

## 2026-09-10 — substantive Codex and Claude message previews

- Added conservative, built-ins-only rendered-output adapters for registered Codex
  and Claude panes. Plain, JSON, and watch modes now share bounded substantive
  previews; prompts, tools, spinners, and footer chrome remain excluded, while
  ambiguous output is unavailable with a separately labeled raw pane excerpt.
- Added protocol-20 pane reads capped at 200 lines and a local 16 KiB suffix, plus
  in-memory occupant identity, late-response rejection, revision/truncation metadata,
  stale-on-error retention, five-second sampling, and at-most-once-per-pane-per-second
  event coalescing. Tripwire matching stays live-only and independent.
- Five new parser/read groups failed 0/5 before implementation because the module was
  absent. The fake-Herdr acceptance first hit sandbox `listen EPERM`; with socket
  access it reached the intended 0/1 `LAST OUTPUT` negative result. The post-change
  parser focus passed 5/5, the integrated model/client/parser focus passed 28/28, and
  the integrated one-shot/watch parity case passed 1/1 with 104 unrelated skips.
- Rebased onto board-actions implementation `3ef8230` and its facilitator-reviewed
  tip `8a98b80`, preserving the earlier HANDOFF entry, CLI-only UI/action boundary,
  and inherited review record. The pre-final-rebase `npm test` passed 133/133 with
  zero skips in 114.802 seconds. At the reviewed commit, `npm test` passed 134/134
  and all 134 deliberate controls failed with zero passes in the facilitator's
  re-execution. The earlier sandboxed negative run hit `listen EPERM` only in the
  inherited socket case; its socket-enabled repeat failed all 133 controls with zero
  passes or skips in 110.015 seconds. Strict OpenSpec validation passed 20/20.
- README, REFERENCE, `docs/reports/board-messages.md`, the completed change task, and
  current message-preview spec are synchronized. Verified Node.js 20.19.4, npm
  10.8.2, Git 2.54.0, and OpenSpec 1.6.0 after clear serialized load probes.
  `board/app.mjs` and `docs/reviews/` are unchanged by this lane.
- No live pane, real-TTY interaction, alternate host, model API, push, promotion,
  archive, independent review, or contract amendment was exercised. Missing
  alternate-screen history and unrecognized rendered formats remain explicitly
  unavailable; the final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — message previews Round 2 corrections

- Resolved all nine Round 1 findings: status-first and expanded trailing chrome are
  rejected; tool calls require corroboration; top-level markers are column-zero;
  pane reads use a separate two-second timeout and four-reader pool; timeout and
  unsupported limitations differ; revision changes preserve fallback occupants; and
  plain reads show message notices. REFERENCE and reviewed-commit counts are fixed.
- The pre-fix focus failed all 11 selected expectations. Post-fix module tests passed
  34/34 and the socket-enabled root subset passed 4/4; its sandbox attempt hit only
  `listen EPERM: operation not permitted …/board.sock`. Final `npm test` passed
  142/142 in 115.630 seconds, all 142 deliberate controls failed in 110.431 seconds,
  and strict OpenSpec passed 20/20 after clear serialized load probes.
- No live-pane repeat, real-TTY or alternate-host check, model API, push, promotion,
  archive, contract amendment, `board/app.mjs` change, or `docs/reviews/` change was
  performed. The final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — message previews Round 3 corrections

- Resolved all six Round 2 findings: interrupt affordances identify status regardless
  of progress verb, named-verb status requires elapsed time or interruption, Claude
  result markers independently identify and bound tools, incomplete Codex tool labels
  stay unavailable, indented approval prompts stop answers, and content-bearing trees
  and tables no longer match pure composer frames.
- The extended chrome case and four new groups all retain deliberate controls. Before
  implementation the focused run passed 9/14 and failed the five affected groups;
  a follow-up padding-only frame assertion then failed its group at 13/14 against the
  first correction. The final focus passed 14/14 in 0.050 seconds. The untouched
  baseline passed 142/142 in 120.972 seconds.
- Final `npm test` passed 146/146 with zero skips in 124.049 seconds; all 146
  deliberate controls failed with zero passes or skips in 106.511 seconds; strict
  OpenSpec validation passed 20/20. Pre-commit runs were serialized after clear
  executable-aware probes and had no socket failure. The single post-commit lane check
  failed 140/146 solely on the known sandbox `listen EPERM: operation not permitted
  …/board.sock` restriction across six fake-server cases; no workaround was made, and
  the facilitator gate for the same commit exited zero. Verification used Node.js
  20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live-pane repeat, real-TTY or alternate-host check, model API, push, promotion,
  archive, contract amendment, `board/app.mjs` change, or `docs/reviews/` change was
  performed. The final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — message previews Round 4 corrections

- Resolved the five Round 3 findings without broad sentence-length heuristics:
  progress durations must occupy a trailing rendered status form; bare and
  command-shaped tool openings suppress superseded answers; a bounded live Claude
  tool summary ends the answer; and same-indent bare tree-marker runs remain content.
  README and REFERENCE now qualify chrome exclusion and document the isolated-elbow
  limitation. The Round 3 gate record now distinguishes its passing pre-commit runs,
  sandboxed post-commit socket failure, and passing facilitator gate.
- The cumulative parser file contains 28 negative-controlled groups, comprising 24
  extraction groups and four read-state groups. Round 4 added 14 groups with 19
  distinct variants and 34 adapter cases while retaining the Round 1 and Round 2
  corpus. The initial focus passed 15/28 and failed 13/28; a later inline-command
  control failed 1/28; the final focus passed 28/28 in 0.043 seconds. The unchanged
  baseline passed 146/146 in 111.644 seconds.
- Final `npm test` passed 160/160 with zero skips in 114.092 seconds. The negative run
  had zero passes, 160 failures, and zero skips in 102.976 seconds: 159 deliberate
  controls and one known sandbox `listen EPERM: operation not permitted …/board.sock`
  failure in the board-focus case. Strict OpenSpec passed 20/20 and
  `git diff --check` was clean after clear serialized load probes. Verified Node.js 20.19.4,
  npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- One bounded 120-line Herdr pane read supplied only the sanitized public-safe tool
  summary fixture. No raw pane output, private path, live interactive render,
  alternate host, model API, push, promotion, archive, contract amendment,
  `board/app.mjs` change, or `docs/reviews/` change occurred. The final clean-commit
  gate remains conversation-only evidence.

## 2026-09-10 — message previews Round 5 corrections

- Generalized only the existing in-flight summary grammar to fixed-verb count clauses
  in any subset/order, applied the existing approval boundary to Claude, and accepted
  three periods as the already-supported status ellipsis. REFERENCE now names the
  count-clause shape; no new sentence or prose heuristic was introduced.
- Seven fixtures extended three negative-controlled groups. Before product changes,
  the focused file passed 25/28 and failed the three affected groups; afterward it
  passed 28/28 in 0.046 seconds with the cumulative answer corpus intact. The clean
  baseline passed 160/160 in 117.024 seconds.
- Final `npm test` passed 160/160 with zero skips in 116.792 seconds. The negative run
  had zero passes, 160 failures, and zero skips in 107.582 seconds: 159 deliberate
  controls and one known sandbox `listen EPERM: operation not permitted …/board.sock`
  failure in the board-focus case. Strict OpenSpec passed 20/20; every build or test
  followed a clear load probe and ran alone. Verified Node.js 20.19.4, npm 10.8.2,
  Git 2.54.0, and OpenSpec 1.6.0.
- Count-clause prose remains conservatively ambiguous. No live-pane or interactive
  check, alternate host, model API, push, promotion, archive, contract amendment,
  `board/app.mjs` change, or `docs/reviews/` change occurred. No further approval is
  needed; the final clean-commit gate remains conversation-only evidence.

## 2026-09-10 — message previews Round 6 corrections

- Narrowed Claude approval chrome to indented boundary rows and required elapsed time
  to end a trailing status form. This preserves approval-worded Claude answers and
  progress-verb prose containing three dots plus a later duration without adding a
  sentence-shape, word-count, or general prose heuristic.
- Added one negative-controlled paired-fixture invariant: 30 chrome/answer definitions
  exercised as 43 adapter pairs across status and ellipsis forms, tool words, approval
  wording, and count-clause tool summaries. Before product changes the focused file
  passed 28/29 and failed the invariant; afterward it passed 29/29 in 0.044 seconds.
- The untouched baseline passed 160/160 in 116.702 seconds. Final `npm test` passed
  161/161 with zero skips in 114.426 seconds. The negative run had zero passes,
  161 failures, and zero skips in 103.725 seconds: 155 deliberate controls and six
  known sandbox `listen EPERM: operation not permitted …/board.sock` failures. Strict
  OpenSpec passed 20/20; every build or test followed a clear load probe and ran alone.
  Verified Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live pane, interactive render, alternate host, model API, push, promotion,
  archive, contract amendment, `board/app.mjs` change, or `docs/reviews/` change
  occurred. No further approval is needed; the final clean-commit gate remains
  conversation-only evidence and may encounter the known sandbox socket restriction.

## 2026-09-10 — message previews Round 7 restructure

- Replaced free-form preview chrome predicates with named per-adapter tables containing
  exactly three fields per rule: an anchored rendered-row pattern, a
  candidate-first-line scope flag, and a minimal chrome example. The tables contain
  16 Codex rules and 17 Claude rules; only `interrupt-status` declares candidate-text
  scope. At that commit, tests enumerated all 33 entries but retained at most three
  leading word tokens per twin and exercised twins only as marked first lines. The
  group pinned the declared scope list, not matcher enforcement or continuation twins.
- Extended timed status structurally for elapsed-ending groups, elapsed time anywhere
  in parentheses or brackets, and elapsed plus a rendered `·`, `•`, or `|` separator.
  Four explicit pairs cover token count, file count, `total`, and `remaining` fields.
  Shortcut/context/token-cost bars, the Claude spinner, and Codex approval/footer
  rows now share the table mechanism. REFERENCE documents the approval-row asymmetry
  and that neither approval rule inspects a marked candidate's captured first line.
- Before product changes, the focused parser file passed 29/31 groups and failed the
  two new negative-controlled groups: missing rule tables and the trailing-token
  status leak. It finally passed 32/32 in 0.059 seconds. The cumulative corpus retains
  the examples from all six review rounds.
- Final `npm test` passed 164/164 with zero skips in 125.195 seconds. The isolated,
  socket-enabled negative-control run had zero passes, 164 deliberate failures, and
  zero skips in 119.958 seconds. Strict OpenSpec validation passed 20/20. The initial
  in-sandbox baseline passed 157/161, with four unrelated host Git-ignore policy
  failures; separate probes also reproduced the known sandbox socket restriction.
  Every build, test, or validation followed a clear load probe and ran alone.
  Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0.
- No live pane, interactive render, alternate host, model API, push, promotion,
  archive, action-boundary change, or contract amendment occurred. `board/app.mjs`,
  read bounds, reader pool, pane timeout, occupant replacement, stale retention,
  tripwire behavior, and `docs/reviews/` are unchanged. The final post-commit lane
  gate remains to be run and quoted in the handoff conversation.

## 2026-09-10 — message previews Round 8 corrections

- Enforced each chrome rule's candidate-first-line scope before its pattern is
  consulted for either the marked rendered row or captured body. Only
  `interrupt-status` remained first-line scoped at that commit; timed status therefore
  still leaked from marked-candidate and lone-row placements. Timed status requires a
  direct, trailing rendered group or ellipsis; mid-sentence duration prose survives,
  Codex prompts are column-zero, and colon-bearing `Context left:` continuations remain
  content.
- Kept the 16-entry Codex and 17-entry Claude tables and generated all 33 pairs from
  their examples. Twins retained later distinguishing groups but stripped the keyed
  leading glyph from eight rules, appended an ordinary clause, and ran in both candidate
  and indented-continuation positions. A matcher spy proves a flag-false marker-admitting
  `Summary:` rule is not consulted on either first-line form; the generated continuation
  catches an overbroad `Note:` rule, but not a widened question-shortcut rule. Every new
  group has a deliberate negative control.
- The finalized fixtures passed 29/35 focused groups before product edits, failing
  the six affected groups, and 35/35 afterward in 0.057 seconds. The initial clean
  baseline passed 164/164 in 113.331 seconds. After rebasing onto advanced main,
  `npm test` passed 168/168 with zero skips in 115.479 seconds; the exact full negative
  run had zero passes, 168 failures, and zero skips in 108.497 seconds with no socket
  failure. Strict OpenSpec validation passed 20/20. Verified Node.js 20.19.4, npm
  10.8.2, Git 2.54.0, and OpenSpec 1.6.0 after clear serialized load probes.
- Main advanced twice; both required rebases preserved main's HANDOFF entries before
  the lane history, and the second advance changed documentation/OpenSpec only. No
  live pane, UI, alternate host, model API, push, promotion, archive, contract change,
  `board/app.mjs` change, or `docs/reviews/` edit occurred. Read bounds, reader pool,
  pane timeout, occupant replacement, stale retention, the live-only tripwire rule,
  and the action boundary are unchanged. The final post-commit lane gate remains to
  be run once and quoted verbatim.

## 2026-09-11 — message previews Round 9 corrections

- Corrected the scope principle without weakening enforcement: `interrupt-status` and
  `timed-status` are the only candidate-first-line rules. Timed status now admits each
  adapter marker, captured first-line body, and indentation, so all 16 recorded status
  forms are chrome in candidate, continuation, and lone placements. Its parenthesized,
  bracketed, and ellipsis bodies accept only elapsed and bounded status fields, keeping
  duration-bearing prose and time ranges as messages.
- Kept the 16-entry Codex and 17-entry Claude tables. At that commit, generated prose
  twins placed fixed explanatory words before each complete example, so their literal
  containment assertion was tautological and a tail-widening mutation escaped for 20
  rules. Eight keyed rules had explicit glyph-preserving indented near misses; the
  reviewer's temporary question-shortcut widening failed the focused suite 37/38.
  Status fixtures paired all 16 forms with same-opening prose twins in all three
  placements and both Claude marker forms. Every new group had a deliberate negative
  control.
- Documented that approval chrome requires its trailing question mark on the same
  rendered row, retained the Codex-any-indentation/Claude-indented asymmetry, and pinned
  two wrapped approval openings as prose. Corrected the Round 8 report and handoff text
  that overstated glyph retention and omitted the timed-status first-line leak.
- The untouched baseline passed 168/168 with zero skips in 123.195 seconds. Fixture-first
  focused tests passed 34/38 and failed the four affected groups before product changes;
  the corrected focused file passed 38/38. Final `npm test` passed 171/171 with zero
  skips in 128.896 seconds. The exact full negative-control run produced zero passes,
  171 deliberate failures, and zero skips in 112.917 seconds without a socket failure.
  Strict OpenSpec validation passed 20/20. Verified Node.js 20.19.4, npm 10.8.2, Git
  2.54.0, and OpenSpec 1.6.0 after clear serialized load probes.
- Main did not move, so no rebase was needed. No live pane, interactive UI, alternate
  host, model API, push, promotion, archive, contract amendment, `board/app.mjs` change,
  or `docs/reviews/` edit occurred. The read bounds, reader pool, pane timeout, occupant
  replacement, stale retention, live-only tripwire rule, and action boundary are
  unchanged. The final post-commit lane gate remains to be run once and quoted verbatim.

## 2026-09-11 — review CLI precise paths Round 10 corrections

- Removed the fixed terminator class from spaced-path continuation scanning. After
  each concrete match, scanning advances through any non-whitespace residue to the
  next whitespace before applying the unchanged continuation and independent-token
  rules. Standalone delimiters and the parenthesized-residue guards remain intact.
- Added six separately negative-controlled, self-contained differential fixtures
  across command and finding prose for greater-than, colon, less-than, opening square
  bracket, closing brace, and arbitrary punctuation runs. Synchronized REFERENCE,
  the review template, design, delta spec, and current spec without enumerating
  terminators.
- Before the production change, the focused run produced zero passes and seven
  expected failures in 16.318 seconds: all six CLI cases published instead of
  refusing, and the documentation assertion was absent. The corrected behavior focus
  passed 6/6 in 16.032 seconds, and the documentation focus passed in 0.071 seconds.
- Baseline `npm test` passed 155/155 in 288.660 seconds. Final `npm test` passed
  161/161 with zero skips in 312.810 seconds; the full deliberate-control run produced
  zero passes and 161 failures in 311.809 seconds. Strict OpenSpec validation passed
  19/19. No Unix-socket `listen EPERM` occurred.
- Runs were serialized after explicit clear process probes. Verification used Node.js
  20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0. Main remains the lane merge base
  at `03a5dc1`, so no rebase was required. The five previously recorded matcher gaps
  remain out of scope. No live reviewer/Herdr mutation, alternate host, push,
  promotion, archive, board-code edit, or `docs/reviews/` change was performed. The
  facilitator-owned Round 9 record remains unchanged; the final commit and single
  post-commit gate remain conversation-only evidence.

## 2026-09-11 — message previews Round 10 corrections

- Restored mechanical power to the table-derived corpus. Each of the 27 end-bounded
  rules now generates a same-row twin beginning with its complete rendered example
  and ending in ordinary words, exercised in candidate and indented-continuation
  placements. The group constructs a tail-widened mutant for every bounded rule and
  proves that it matches the witness while the committed rule rejects it. The six
  arbitrary-tail rules retain keyed near-miss coverage; every added group has a
  deliberate `negativeControl`.
- Expanded only the rendered Claude rows requested by review. Fast-mode chrome accepts
  indented `accept edits on` and `bypass permissions on`, with an optional exact
  shift+tab hint. Spinner chrome accepts one or more words plus an ellipsis and an
  optional parenthesized elapsed field with rendered token counts. Continuation and
  inner-row fixtures reject six chrome forms while preserving four prose near-misses.
  REFERENCE and the Round 9 report/HANDOFF claims now describe those actual bounds and
  the previous prefix-first test gap.
- The untouched Round 10 baseline passed 171/171 in 124.877 seconds. The fixture-first
  focused run passed 38/40: the expanded Claude group failed on `accept edits on`
  before the parser edit, while the second failure exposed and prompted correction of
  a stale helper name in the refactored fixture. The corrected focus passed 40/40 in
  0.096 seconds. Before rebasing, the full suite passed 173/173 in 124.751 seconds and
  the negative run produced zero passes and 173 deliberate failures in 118.369 seconds.
- `main` advanced to `a9cd127` with the review sanitizer correction, so this lane
  rebased only onto that tip and retained HANDOFF entries in chronological order.
  Post-rebase `npm test` passed 206/206 with zero skips in 317.998 seconds; the exact
  full negative-control run produced zero passes, 206 deliberate failures, and zero
  skips in 305.020 seconds, without a socket failure. Repository-wide strict OpenSpec
  validation passed 20/20. Verification used Node.js 20.19.4, npm 10.8.2, Git 2.54.0,
  and OpenSpec 1.6.0 after clear serialized load probes.
- The Round 9 review exists only as a private record because the canonical sanitizer
  refused projection of relative paths inside the reviewer's command strings; the
  promoted review-cli-fix-3 work addresses that defect. No live pane, interactive UI,
  alternate host, model API, push, promotion, archive, contract amendment,
  `board/app.mjs` change, or `docs/reviews/` edit occurred in this round. Read bounds,
  reader pool, pane timeout, occupant replacement, stale retention, the live-only
  tripwire rule, and the action boundary are unchanged. The single post-commit lane
  gate remains to be run once and quoted verbatim.

## 2026-09-11 — board inventory (2c-i)

- Activated the pre-agreed board-discovery split before implementation. The original
  change remains superseded and unchecked; board-inventory owns machine default/repo
  filtering, complete live-agent visibility, and history semantics, while the future
  board-sampling change alone owns responsive bounded observation. Synced only the
  inventory delta into the current machine-session-discovery spec.
- Added dependency-free local Herdr endpoint enumeration and real-path deduplication,
  per-endpoint coverage/errors, canonical Git-common-directory repository discovery,
  verified repository-scoped worktree mapping, isolated per-repository configuration
  and registries, unregistered/unnamed/non-Git/facilitator rows, stable display
  disambiguators, group ordering, `--repo`, `--all`, and independent metadata/Herdr
  completion handling. All document changes are additive; existing field meanings and
  action boundaries remain intact.
- The untouched baseline passed 206/206 with zero skips in 315.780 seconds. Before
  implementation the new inventory file passed 0/4; missing service imports caused
  three failures and rejected `--all` caused the fourth. Corrected inventory coverage
  passed 4/4 in 1.134 seconds, and the existing board focus passed 20/20 with 122
  name-filter skips in 8.986 seconds. The deliberate-control run produced zero passes
  and four named failures in 1.195 seconds.
- The first full post-change suite reached 209/210 in 317.460 seconds; only its stale
  README/usage assertion failed. After correction, the focused assertion passed 1/1
  and final `npm test` passed 210/210 with zero skips in 317.701 seconds. Strict
  OpenSpec validation passed 23/23. Syntax and whitespace checks passed. Runs were
  serialized after clear process probes and used Node.js 20.19.4, npm 10.8.2, Git
  2.54.0, and OpenSpec 1.6.0.
- A sanitized live read found two local endpoint records, one accessible endpoint,
  seven repositories, and nineteen rows, correctly reporting partial discovery and
  one endpoint error. No raw local identity was recorded. Multiple accessible servers,
  malformed/foreign registries, and offline startup were fixture-verified; alternate
  hosts were not checked.
- `board/app.mjs`, `board/ui/`, responsive/freshness behavior, lifecycle scheduling,
  Git identity, remote discovery, push, promotion, close, and `docs/reviews/` were
  untouched. Main remained the lane merge base at `de11d4b`, so no rebase was needed.
  The single post-commit lane gate remains to be run and quoted verbatim.

## 2026-09-12 — pinned core configuration release 2026.09.12.1

- Added `config/releases/2026.09.12.1/` with a portable two-route profile, a
  monitoring protocol, a source-commit manifest, and the exact core CLI file list.
  The source is `de11d4b` at package version 0.1.0. The installed core snapshot
  omits the interactive console entrypoint and dependencies; the two new console
  lanes remain unreviewed and unpromoted. No CLI behavior or product default changed
  in the canonical checkout.
- The operator-local rollout pinned the `lane` command to a versioned core snapshot
  and installed parent configurations under three identity roots, preserving exact
  before-images and release hashes for rollback. Existing engineering and review
  routes were retained. A new opt-in one-shot monitor route uses Codex Luna low;
  `review-codex` permits explicit independent Codex review. A project-specific
  Codex root marker was preserved where present.
- Before rollout, two representative target repositories lacked both new routes.
  After rollout, read-only `lane config` verified both route sources in all 74
  discovered canonical repositories across the three roots, with zero errors.
  Installed configuration and all nine core files verified against the private
  release manifest in every root; no interactive console entrypoint was present.
- The sandbox baseline `npm test` passed 200/206; six board fixture failures were
  all Unix-socket `listen EPERM` from the sandbox. The serialized host rerun
  passed 206/206 with zero skips in 309.513 seconds. `git diff --check` passed.
  Verification used Node.js 20.19.4, npm 10.8.2, and Git 2.54.0.
- No live dispatch, reviewer, supervisor restart, model spend reduction, remote
  push, console promotion, or alternate-host behavior was verified. Repository-local
  dispatchers and direct Herdr starts do not inherit the parent route profile.

## 2026-09-12 — report-driven daily supervisor protocol

- Added `config/supervisor/2026.09.12.1/` with a daily starter, private checkpoint
  template, engineering-brief report appendix, and deployment guide; linked it from
  `README.md`. A dispatched engineer now has an explicit way to send one concise
  evidence pointer to the named supervisor after a material milestone, blockage, or
  gate. The supervisor verifies artifacts instead of polling. Independent reviewers
  still write only their mandated record; the review command supplies their verdict.
- The versioned protocol pack was copied into three operator identity roots. All
  five manifest-listed files matched byte-for-byte in each root. No model session
  was started or restarted. The earlier config release remains immutable, and no
  product CLI behavior or route default changed.
- The prior release's `routes.<name>.use` field is descriptive and ignored by
  dispatch; that was the observed gap before this workflow supplement. There was
  no code-behavior negative control because this change is documentation only.
  `npm test` passed 206/206 with zero skips in 310.221 seconds on the host;
  `git diff --check` passed. Node.js 20.19.4, npm 10.8.2, and Git 2.54.0.
- Live engineer-to-supervisor Herdr delivery, delivery while the supervisor is
  busy or blocked, and actual token savings remain unverified. Reports are claims
  to check against Git, gates, and review records. No push, promotion, or console
  review was performed.

## 2026-09-12 — project-aware daily supervisor bootstrap 2026.09.12.2

- Added a versioned project locator and daily handoff template to the
  report-driven supervisor pack. A fresh supervisor now reads the project's
  own agent instructions, exact goal sources, latest durable transition record,
  and declared archive destinations before acting. It checks newer commits and
  records, treats stale daily notes as handoffs, and does not poll engineers.
  Project-approved supervisor worktrees are supported where canonical checkouts
  must remain clean. The core CLI, route defaults, and console are unchanged.
- Installed the new pack under three local identity roots, advanced only their
  `current` protocol pointers, and verified six release hashes per root. The
  previous pack remains intact and hash-verified for rollback. Two private,
  gitignored project locators and daily handoffs were prepared as examples;
  other projects still require their own verified goal and archive mappings.
  No project archive path was guessed from identity alone.
- The prior pack contained no project goal-source or archive locator; that was
  the observed documentation gap. No code-behavior negative control applies to
  this documentation-only update. The pre-change `npm test` baseline passed
  206/206 in 309.496 seconds. The final sandbox run passed 200/206; six board
  socket fixtures were refused by local `listen EPERM`, with no assertion
  failure outside those fixtures. The host-side final run passed 206/206 in
  308.297 seconds with zero skips.
  `git diff --check` passed. Node.js 20.19.4, npm 10.8.2, Git 2.54.0.
- Live report delivery, actual token savings, and automatic freshness for
  projects without an onboarded locator remain unverified. A conflict between
  one project's supervisor model sources is explicitly surfaced before a new
  queue owner starts. No new supervisor session, financial action, publication,
  console review, or push occurred.

## 2026-09-12 — native Codex remote and explicit daily model selection

- Added `config/supervisor/2026.09.12.3/` with separate fields for the future
  daily supervisor default, the currently active queue owner, and an explicit
  launch-time model override. A default change does not replace a running
  supervisor. Added a host-level native Codex remote-control guide: start the
  managed daemon once, connect new Herdr Codex TUIs with `--remote unix://`,
  and generate a short-lived manual phone pairing code only when needed. The
  core CLI, console, and lane route defaults remain unchanged.
- Installed the versioned protocol under three local identity roots, advanced
  their `current` pointers, verified seven source and installed hashes in each,
  and retained the prior pack for rollback. A private project locator and an
  external archive record now preserve the operator's active-owner and future
  default distinction. The installed Codex CLI 0.154.0 reported its managed
  app-server running and native remote control connected and enabled. No
  pairing code was generated or stored.
- Before the documentation change, the prior pack had no native CLI server
  launch recipe and did not distinguish default model from active owner. No
  code-behavior negative control applies. The sandbox `npm test` baseline
  passed 200/206; six board Unix-socket fixtures were refused with `listen
  EPERM`. The host-side final run passed 206/206 with zero skips in
  307.908 seconds. `git diff --check` passed. Node.js 20.19.4,
  npm 10.8.2, Git 2.54.0.
- iOS manual pairing, visibility of a new daemon-connected Herdr Codex
  session, live engineer report delivery, and measured token savings remain
  unverified. Existing agents were not retargeted or restarted. No push,
  financial action, publication, or console review occurred.

## 2026-09-12 — native remote Codex working-root correction

- A live supervisor exposed a launch-recipe defect: Herdr's pane and TUI
  process had the intended project worktree cwd, but the native remote Codex
  status bar showed the shared app-server daemon's unrelated cwd. The previous
  `--remote unix://` example omitted Codex `-C`. A no-prompt Herdr startup
  with `-C` displayed the intended project worktree. The affected supervisor
  was interrupted and a freshly rooted session took its name; affected lane
  results require independent revalidation before acceptance.
- Added versioned supervisor pack `2026.09.12.4`. Its native remote launch
  example passes `-C "$supervisor_worktree"` after Herdr's `--`; its guide and
  starter require checking Codex's startup `directory:` before prompting each
  remote supervisor, engineer, or reviewer. Updated the README's pack pointer
  and added an offline contract test in `test/supervisor-pack.test.mjs`.
- Negative control: the focused new test failed against the previous pack's
  missing `-C`, then passed against `2026.09.12.4`. The pre-change `npm test`
  baseline passed 206/206. The final sandbox run passed 201/207; its six board
  Unix-socket tests were refused with `listen EPERM`, while the new test passed.
  The host-permitted final run passed 207/207 in 310.963 seconds, with no skips.
  `git diff --check` passed.
  Node.js 20.19.4, npm 10.8.2, Git 2.54.0, Codex CLI 0.154.0.
- Installed the new pack under three local identity roots, advanced each
  `current` pointer, and verified seven source/installed hashes per identity.
  The earlier pack remains available for rollback. This is a launch and
  documentation correction; the core CLI, board, and route defaults did not
  change. Native phone pairing and visibility remain unverified. No push,
  publication, wallet, chain, or prover action occurred as part of this fix.

## 2026-09-13 — supervisor-owned lane closeout protocol 2026.09.13.1

- Added `config/supervisor/2026.09.13.1/` with a supervisor-owned closeout
  sequence and synchronized starter, engineer handoff, project locator, daily
  checkpoint, manifest, and release digests. After the operator delegates
  promotion and close, the supervisor verifies the final gate and independent
  review, preserves required evidence, promotes once from the canonical
  checkout, closes the lane, and verifies the exact Herdr sessions retired.
- The protocol distinguishes `promoted-cleanup-pending` from `closed`, retains
  lanes after failed promotion, refuses cleanup with ambiguous or replaced
  occupants, and does not replay promotion or lifecycle commands to repair a
  leftover workspace or display marker. Engineers stop changing the lane after
  READY_FOR_REVIEW and leave promotion, worktree removal, and session retirement
  to the supervisor. README and REFERENCE now link and describe this boundary.
- Before the pack existed, the focused contract test failed 0/2: the latest
  manifest omitted `CLOSEOUT.md` and the closeout document was absent. The
  explicit post-change negative-control run also produced zero passes and two
  deliberate failures. Focused final tests passed 3/3, including the inherited
  native-remote working-directory contract and all release digest checks.
- The initial sandbox baseline passed 201/207; its six failures were the known
  Unix-socket `listen EPERM` board fixtures. The resumed final `npm test` passed
  209/209 with zero skips in 316.814 seconds, including all socket fixtures.
  `git diff --check` passed. Verification used Node.js 20.19.4, npm 10.8.2,
  and Git 2.54.0.
- No CLI runtime behavior changed. The new pack was not installed into identity
  roots or sent to a running supervisor, and no live accepted-lane promotion,
  Herdr retirement, fallback cleanup, alternate host, push, or publication was
  performed.

## 2026-09-13 — console integration resumed

- Recorded the exact inventory/frame delivery commits, current gates, integration
  order, and remaining split dependencies in `docs/reports/console-integration.md`.
  Both lanes were clean; inventory had a matching successful gate and frame a
  matching failed gate attributed by its delivery report to sandbox socket fixtures.
- Started independent inventory Round 1 through the configured Codex review route
  with a zero-test budget and a fixed target. The reviewer was observed working in
  the intended lane workspace. No verdict or acceptance is claimed at this checkpoint.
- Git merge-tree previews against release `48ee44c` identify only HANDOFF conflicts
  for both lanes. Neither lane was rebased, promoted, or closed. Required review,
  refreshed gates, and post-close identity checks remain before acceptance.
- Reused the immediately preceding 209/209 full-suite result and 3/3 release checks;
  no product code changed. This checkpoint is documentation only, so no behavior
  negative control applies. Whitespace and public-text checks passed. Live console
  integration, downstream sampling/details/composer, installation, and publication
  remain unverified or pending.

## 2026-09-13 — daily console and coordination goals

- Added `docs/plans/2026-09-13-console-coordination.md` with three outcomes:
  verified console integration, a coordinator/supervisor protocol specification
  reconciled with console dependencies, and a measurable two-project pilot brief.
  Refreshed the private daily handoff to point to this authoritative plan.
- Updated the integration report to inventory Round 1 NEEDS-WORK: two major and
  five moderate findings at the original delivery SHA. Private evidence and the
  untracked lane public projection are retained. No correction, promotion, or
  completed integration is claimed by this planning step.
- Documentation only; no runtime behavior or dependencies changed. No new tests
  or behavior negative controls were needed. Prior 209/209 baseline evidence
  remains applicable to unchanged product code; `git diff --check` passed.
  Pilot project selection, protocol review, implementation, measured savings,
  and external rollout remain pending.

## 2026-09-13 — identity coordinator protocol and pilot specification

- Added `openspec/changes/identity-coordinator/` proposal, design, manual and
  read-only observation deltas, and three independently deliverable future briefs.
  Added `docs/identity-coordinator-pilot.md`, its measurement template, and
  `docs/reports/identity-coordinator-spec.md`. No product runtime, dependency,
  current capability spec, supervisor release, in-flight inventory/frame slice, or
  review record changed.
- The proposed manual protocol fixes one integration owner per canonical project,
  explicit daily outcome/budget allocation, optional supervisor as acceptance owner,
  direct coordinator-to-engineer ownership for small work, stable assignment and
  delta-report identities, explicit reassignment and evidence-based resumption.
  The later console projection is opt-in/read-only after bounded discovery; it is
  not a work queue, lease, authorization, or lifecycle trigger.
- Read-only `git show` audited inventory `1fdd8f9` and frame `9e8c8f9` JSON/spec
  surfaces. Existing goal, lane report and technical attention were separated from
  proposed assignment owner, latest coordination delta, and decision attention.
  Pilot selection remains pending: one identity and two explicit canonical projects.
- Baseline `npm test` passed 209/209, zero skips, in 309.880 seconds after a clear
  process probe. No behavior change warranted a failing product test or negative
  control. Focused strict OpenSpec validation passed; repository-wide strict
  validation passed 21/21 at concurrency one. Node.js 20.19.4, Git 2.54.0,
  OpenSpec 1.6.0. Final diff checks and post-commit gate are conversation evidence.
- Initial baseline waited for another suite's test slot; this lane ran no test
  during inventory's later reserved focused slot. No live pilot, selected identity
  or projects, protocol adoption, supervisor notification result, console extension,
  independent review, alternate-host check, push, promotion, or close is claimed.

## 2026-09-13 — identity coordinator specification Round 1 corrections

- Addressed all six Moderate/Minor findings in the preserved NEEDS-WORK review of
  `dcf44a1` (record `docs/reviews/identity-coordinator-spec/dcf44a1-r1.md`).
  Stale saved evidence now has a same-owner reconciliation path distinct from
  authority-backed owner transfer; no automatic successor or duplicate review.
- Assigned the future interactive source path across the CLI launcher,
  `board/args.mjs`, app, and observation client, including initial watch, refresh,
  reconnect, unchanged action arguments and an injected process-boundary fixture.
  The earlier CLI slice refuses interactive use until that UI path exists.
- Specified a regular-file/no-symlink 1 MiB snapshot cap, finite project/assignment/
  row-link and text limits, typed nullable fields, bounded reads, localized errors,
  and read freshness separate from HEAD/revision applicability. Old matching
  evidence needs no heartbeat; planned/reported milestones remain unaccepted
  without project-owner evidence.
- Partitioned current-spec sync: CLI projection and bounded-read blocks ship with
  the future CLI lane; interactive forwarding and separate-attention blocks ship
  with the future UI lane. The manual protocol is separate. No current spec,
  runtime, dependency, inventory/frame lane, or review file was edited here.
- After inventory's final gate released the slot, `npm test` passed 209/209 with
  zero failures/skips in 309.445 seconds; strict OpenSpec validation passed 21/21
  at concurrency one. No behavior change warranted a failing product test or
  prose negative control. Node.js 20.19.4, Git 2.54.0, OpenSpec 1.6.0.
  Diff/public-safety checks and the final source-CLI gate are conversation evidence.
- Live source parsing/forwarding, report delivery, pilot selection/measurement,
  alternate-host behavior, independent Round 2 review, push, promotion and close
  remain unverified or undone. The historical Round 1 verdict is not acceptance.

## 2026-09-13 — coordinator specification accepted and evening queue bounded

- Accepted independent Round 2 PASS at `6d8e74d`; preserved its public projection
  as the sole evidence-only successor change in `e69143a`. Refreshed the final
  gate, then promoted through fresh validation and fast-forward-only integration.
  Reports and public reviews remain committed, with private review/gate evidence
  preserved outside the removed worktree. Verified merged branch/worktree removal,
  retirement of the exact completed Herdr workspace/tabs, and three done markers.
- Main baseline passed 209/209 in 328.225 seconds; final evidence-commit gate
  passed 209/209 in 339.648 seconds; promotion validation passed 209/209 in 324.116
  seconds, each with zero skips and serialized test execution. No behavior change
  or new product negative control applies to this evidence/planning closeout.
- Updated the daily plan and console integration report with accepted versus
  pending work and conditional overnight boundaries. Inventory Round 3 remains
  NEEDS-WORK with four scoped findings; its review was preserved in the lane and
  failure-first corrections assigned to the existing engineer. Frame remains
  queued. Sampling precedes coordination read-model; complete details precedes
  coordination UI. Exact local assignments and cleanup evidence stay private.
- Documentation-only checkpoint after validated integration; whitespace and
  full-diff public-safety inspection passed. No push, publication, installed
  snapshot update, live protocol adoption, selected pilot, measured savings, or
  completed console integration is claimed.

## 2026-09-13 — board inventory Round 1 corrections

- Rebasing the clean inventory lane only onto `main` at `8d80ffa` retained its earlier
  HANDOFF entry and all newer supervisor release/planning entries. The saved Round 1
  NEEDS-WORK review remains unchanged at Git blob
  `992703ffe8d47594cdbdc416bbff92b2cd248172`; no review record was edited.
- `board/board.mjs`, `board/inventory.mjs`, and `board/message-preview.mjs` now keep
  Git/report evidence within canonical repository/session identity, derive live
  repository and branch from actual cwd, require unique verified workspace/occupant
  joins, and retain matching preview/tripwire runtime across watch refreshes. The
  inventory cancels active snapshot and pane-read clients before further endpoint
  probes. `lane.mjs` preserves configured-substring tripwire semantics and unchanged
  event frames. `board/view.mjs` adds plain scope, coverage, endpoint, repository,
  group, and active-after-done text without changing the JSON schema or table fields.
- Seven offline test groups were observed failing before product edits: four in the
  inventory file and three in the watch/plain selection. The two socket witnesses
  first encountered sandbox `listen EPERM`, then failed on product behavior outside
  the sandbox. Each group has a deliberate negative control; after correction the
  four controls failed 4/4 at their named controls and the three selected controls
  failed 3/3, with unrelated tests skipped by name filters. Corrected focused runs
  passed 8/8 inventory and 3/3 selected watch/plain tests.
- The untouched baseline passed 210/210 in 311.657 seconds. The first full
  correction run reached 219/220 in 312.646 seconds; its one failure exposed an
  inherited unconfigured match-event frame expectation. A watch child left after
  that failed temporary fixture was terminated by exact PID, and related fixtures
  now close children even on assertion failure. The four related focused watch
  tests passed 4/4 after the frame fix. The final serialized `npm test` passed
  220/220 with zero skips in 311.140 seconds; strict OpenSpec validation passed
  23/23. Clear machine process probes preceded every full run. Node.js 20.19.4,
  npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0 were used.
- `docs/REFERENCE.md` documents the corrected plain and watch behavior; only the
  board-inventory delta was synchronized to the current machine-discovery spec.
  `board/app.mjs`, `board/ui/`, the sampling responsiveness/freshness slice, Git
  identity, remote discovery, lifecycle actions, promotion, close, and push remain
  untouched. No alternate host, live multi-endpoint watch, or Ink rendering was
  exercised; offline protocol/socket fixtures provide those boundary checks.
  Final whitespace/public-safety checks and the post-documentation source-CLI gate
  remain to be recorded before handoff to the supervisor.

## 2026-09-13 — board inventory Round 2 corrections

- Addressed all four findings in the preserved Round 2 NEEDS-WORK review (unchanged
  blob `99c93a64d595f3780621e8ccb668d7cace29895a`). Registered live joins now
  require the recorded lane to equal the verified Git branch and a matching immutable
  agent-session ID; a stored terminal ID is also checked. Switched, detached,
  replaced, and unverifiable older records stay separate from visible live occupants.
- Dispatch now records optional, display-only agent-session and terminal IDs after
  verifying the same occupant before and after delivery. A detected replacement
  yields partial success without another prompt or false record. Title-only
  unregistered goals no longer create a brief excerpt. Status-only watch events
  emit the status frame and schedule the existing coalesced preview read. The board
  JSON schema remains v1 with no new fields; the record metadata, reference,
  inventory change/current spec, and delivery report are synchronized.
- The untouched baseline passed 220/220 in 311.606 seconds. Five focused groups
  failed before product edits at the branch, replacement, title, missing dispatch
  metadata, and status-only preview behaviors. Corrected inventory passed 11/11;
  three selected dispatch/watch checks passed 3/3. Six selected deliberate controls
  failed at their named controls. Two older fixtures were updated to model actual
  lane branches and immutable identities after the new safety rule exposed their
  previous main-checkout mismatch.
- Final serialized `npm test` passed 226/226, zero skips, in 316.863 seconds; strict
  OpenSpec validation passed 23/23. Syntax and whitespace checks passed. Node.js
  20.19.4, npm 10.8.2, Git 2.54.0, and OpenSpec 1.6.0 were used. The final clean-
  commit source-CLI gate is conversation-only evidence, not stored here.
- No live dispatch, alternate host, multi-endpoint watch, Ink rendering, minimum-
  version run, sampling freshness guarantee, lifecycle action, push, promotion,
  close, or review-record edit was performed. `board/app.mjs` and `board/ui/` remain
  untouched.

## 2026-09-13 — board inventory Round 3 corrections

- Addressed all four findings in the preserved Round 3 NEEDS-WORK review. The
  three inventory review blobs remain unchanged: Round 1
  `992703ffe8d47594cdbdc416bbff92b2cd248172`, Round 2
  `99c93a64d595f3780621e8ccb668d7cace29895a`, and Round 3
  `2de4e8575ab78962162e97170ce4ba4dd44258ea`.
- `lane.mjs` drains a coalesced status-preview request after a busy machine-watch
  collection without observation overlap. `board/inventory.mjs` and
  `board/message-preview.mjs` use available terminal identity alongside the
  agent-session value so replacement occupants do not inherit preview/tripwire
  state or late reads. `board/board.mjs` preserves null goal provenance for a
  titleless unregistered row. The workspace-claim fixture now proves a successful
  verified lane join before missing, stale, and duplicate claims. The JSON schema
  remains v1; the reference and only board-inventory capability delta/current
  spec were updated.
- Failure-first `npm test` passed 226/230 with four expected product failures;
  the eligible-join baseline passed. Corrected focused groups passed 5/5, and
  their five deliberate controls failed at named assertions. Strict OpenSpec
  validation passed 23/23. The correction was committed, then rebased only onto
  confirmed main `ee529a3`; the HANDOFF conflict retained both coordinator and
  inventory histories. Post-rebase serialized `npm test` passed 230/230, zero
  skips, in 339.090 seconds. Post-rebase strict OpenSpec passed 24/24, including
  the coordinator change on main; five selected controls failed 5/5 at their
  named controls. Clear process probes preceded full runs.
- The final clean-commit source-CLI gate is conversation-only evidence after this
  documentation commit. Offline system-temp fixtures were cleaned. No live
  terminal replacement, alternate-host or multi-endpoint watch, Ink rendering,
  sampling freshness guarantee, push, promotion, close, or review-record edit is
  claimed. Node.js 20.19.4 and Git 2.54.0 were used.

## 2026-09-13 — board inventory Round 4 tripwire race correction

- Preserved the Round 4 NEEDS-WORK review unchanged at blob
  `6d8cc34b94c080c16b053bf8bee34be14b8b943a`; all earlier inventory review
  records also remain untouched. Main stayed `ee529a3`, with no rebase.
- `board/inventory.mjs` merges the latest same-occupant tripwire and match time
  after pending pane reads and refuses an intervening different-occupant runtime
  write. The adjacent successful and failed preview writebacks in
  `board/message-preview.mjs` retain newer same-occupant match evidence without
  overriding a different occupant. `docs/REFERENCE.md` and only the inventory
  delta/current machine-session-discovery spec describe this display-only rule;
  no JSON field, lifecycle action, or sampling bound changed.
- The untouched baseline passed 230/230 in 332.922 seconds. Failure-first
  witnesses showed `OLD` instead of `LATEST` after a delayed two-pane collection,
  null instead of `LATEST` after a real watch match frame, and `OLD` instead of
  `LATEST` in direct successful and failed preview writebacks. The socket fixture
  first timed out because it lacked an agent-kind field; after completing that
  fixture, its behavioral failure was observed before product edits.
- Corrected race and existing replacement/late-read focused checks passed 7/7;
  the fourth failed-read witness passed in the full run. Four deliberate controls
  failed 4/4 at their named assertions. Serialized `npm test` passed 234/234,
  zero skips, in 336.045 seconds. Strict OpenSpec passed 24/24. Clear process
  probes preceded tests; Node.js 20.19.4 and Git 2.54.0 were used.
- Offline system-temp fixtures were cleaned. Live Herdr matching, an alternate
  host, Ink rendering, a multi-endpoint watch, and sampling freshness remain
  unverified. The final source-CLI gate is run after the documentation commit
  and reported in the conversation. No push, promotion, close, or review edit
  was performed.

## 2026-09-15 — board-inventory integrated and open lanes closed

- Accepted independent Round 5 PASS (no findings) for board-inventory at
  `204b6ea`, which corrects the Round 4 tripwire/match-timestamp overwrite. The
  public review is the sole change in evidence-only commit `205b619`. Refreshed its
  gate, promoted by fast-forward from `ee529a3` without a rebase, and closed the
  lane: merged branch and worktree removed, Herdr workspace retired, six registered
  sessions marked done. Private reviews and final gate bytes were preserved first.
- Closed board-frame unmerged at the operator's request to retire all open work
  trees. It is recoverable from `archive/lane/board-frame` at `9e8c8f9`; it was never
  reviewed and its saved gate failed. Its gate bytes were preserved.
- Added `docs/plans/2026-09-15-carry-forward.md` with every unresolved slice,
  prerequisite, operator decision, frame compatibility gap, and verification gap.
  Marked the 2026-09-13 plan closed and appended the integration report.
- Gate at `205b619`: `npm test` 234/234, zero skips, 326.873 seconds. Promotion
  validation: 234/234, zero skips, 323.327 seconds. Both ran serialized after clear
  process probes with Node.js 20.19.4, npm 10.8.2, and Git 2.54.0. No separate main
  baseline was run; promotion validated main plus the lane, a superset of it.
- This follow-up is documentation only, so no failing test or negative control
  applies; `git diff --check` and a public-safety scan of the diff were run before
  commit. Frame reconciliation, sampling, details, coordination, composer, release,
  pilot, and publication remain open as listed. No push occurred.
