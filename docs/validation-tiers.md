# Validation tiers

Workers select focused offline test files and record them once on their clean
committed candidate with `node lanes/lane.mjs check --cmd 'COMMAND'` before reporting.
They never run a baseline,
`npm test`, `test:promotion`, `test:lanes` or the release acceptance harness.
Settle reviews code and runs no suite.

Under the current operator landing waiver, finished owned source lands through
`lane promote TOPIC --expected-head FULL_SHA` with native identity, claim,
source, clean rebase, STOP/HOLD and fast-forward/CAS checks. Tests, report and
review readiness add no landing gate. The record dispatches one asynchronous
post-code diff/evidence review. Outside that waiver, promotion validates once
per batch before moving main. `npm run test:promotion`
starts shared immediately (ARCH-34) and runs the explicit promotion inventory plus selected
merge-critical lane and mixed-file cases. The inventory is in
`test/helpers/tier.mjs`; title selectors are in `package.json`. Clean worktrees,
canonical Git identity, clean replay, compare-and-swap, fast-forward and recoverable
archives remain mandatory. Saved session metadata never grants lifecycle authority.

## Early checks of combined changes

Bring focused integration checks into the work that changes a shared contract,
as soon as its writer and consumers can be exercised together. Assign one owner
to that contract across concurrent items; separate worktrees do not make
interface changes independent. The owner records the shared base, the source
slices included, and any missing consumer in the existing item/report. Other
workers reuse that evidence rather than repeat it. This applies now, without
waiting for Stage 5 or the background full-coverage work in ENG-713.

Use a clean committed lane rebased onto the relevant landed sources, or an
already combined clean checkout. This helper does not merge or edit sources.
Choose the full commit SHA before the interacting changes, so the range includes
both earlier landings and the current candidate. Preview the focused selection:

```sh
node test/helpers/combined-checks.mjs --base FULL_BASE_SHA --plan
```

Then capture the check through the existing lane receipt path:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/combined-checks.mjs --base FULL_BASE_SHA'
```

The helper checks the union of changed paths against the combined HEAD with the
existing one-hop affected-test planner. It includes changed tests, direct
consumers of deleted/renamed paths, and deduplicates shared tests. The existing
estimated time/file budgets bound the selection; deferred files remain named
and unrun. Dynamic or indirect contract consumers need an explicit repeated
`--extra path/to/consumer.test.mjs` in the preview and recorded command. Extras
are required selections even when estimates exceed the planning budget.

Execution uses the existing project runner, host ownership and file grouping
(at most four files per suite; heavy lane/acceptance files isolated), with no
retry or full-tier append. Logs capture base/head/tree, changed paths, selected
and deferred files, groups and status; `lane check` keeps the command, actual
exit, Node version and TAP totals in its normal gate/log/shared receipt. A
plan-only or empty selection is unrun, never a test PASS. A failure stays red;
the owner fixes it forward and runs only failing, affected or unrun controls.
Reuse the immutable command/target evidence across unchanged-tree rebases;
source movement during a check refuses attribution to the new target.

This is an explicit focused check, not an automatic main-health service,
universal landing gate or replacement for the release coordinator's one full
final-release check and actual live acceptance. No watcher, saved runtime,
release pin or closeout path changes are needed.

The promotion tier includes `test/bch-cloak-contract.test.mjs`, an offline scratch
record exercising bch-cloak's subcommands, flags, text parsers, JSON and event
fields, installed settle-watch flags, and reconcile usage. Identity desk requests
are tested with fake Herdr in `supervisor/test/request.test.mjs`.

`bash herdr/release.sh build TAG` archives the tag into a partial directory and
runs `npm run test:release` inside it once per candidate. The full offline chain
covers slot, core, cycle, lanes, offline acceptance and the remaining release-only
inventory. New files default to release until explicitly assigned to promotion.
Release-only files are grouped into bounded suites; heavy lane and acceptance
files are isolated. The outer gate never retries the full inventory; an individual
suite can retry a timeout under measured load once.

A green gate makes the release immutable. A red or interrupted gate leaves the
partial snapshot for inspection and refuses activation. `build TAG --live` adds
the optional live acceptance harness after the offline gate. That harness owns
scratch records and panes; it never belongs to a worker lane. Activation and
publishing are operator decisions.

Validation receipts bind the Git tree, command and environment. Host slot
ownership uses PID and process birth identity, and all refusal, recovery and
freshness checks remain in force. All tests are offline and never call a model.
