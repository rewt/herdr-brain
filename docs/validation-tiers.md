# Validation tiers

Workers run focused offline test files while developing and
`node lanes/lane.mjs check --tier fast` before reporting. They never run a baseline,
`npm test`, `test:promotion`, `test:lanes` or the release acceptance harness.
Settle reviews code and runs no suite.

Promotion validates once per batch before moving main. `npm run test:promotion`
holds the host test slot and runs the explicit promotion inventory plus selected
merge-critical lane and mixed-file cases. The inventory is in
`test/helpers/tier.mjs`; title selectors are in `package.json`. Clean worktrees,
canonical Git identity, clean replay, compare-and-swap, fast-forward and recoverable
archives remain mandatory. Saved session metadata never grants lifecycle authority.

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
