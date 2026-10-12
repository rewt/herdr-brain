# Test tiers

Lanes ship the tests for their change and may run the relevant files while
working. The promotion batch runs the complete promotion tier once before a
fast-forward merge. Settle reviews do not run a suite.

| Command | Boundary and cost |
| --- | --- |
| `npm run test:fast` | Selected parsers, derived models, rendering, routes and process-identity logic; seconds, two small Git discovery fixtures and no PTYs. |
| `npm run test:promotion` | Explicit merge correctness files, selected fast logic and lane lifecycle cases, plus native host-slot tests. Holds the host slot across the batch. |
| `npm run test:release` | The complete offline suite, including copied-product workflows and deliberate wall-clock deadline regressions. Holds the host slot; calls no model and never runs the live harness. |

`test/helpers/tier.mjs` selects only `.test.mjs` entries. Support modules and
frozen folds remain imported by their tests rather than being reported as empty
passing tests. Every bounded test file belongs to promotion or release; the tier
regression also verifies that fast checks remain included in promotion. The
explicit promotion list and dynamically discovered release list cover the current
inventory. Selected fast cases from mixed release files remain in the promotion
logic and lane commands. The complete release command runs each current file once
through core, cycle, lanes, acceptance and release-only steps, plus the native slot
suite. New files default to release until explicitly assigned to promotion.

`herdr/release.sh build TAG` runs the offline release tier inside the archived
partial snapshot before making it immutable. A failed check leaves that partial
snapshot for inspection. The optional `--live` pass follows a green offline gate;
workers run focused offline files and never the live harness.

Lane and settle fixtures copy an immutable initial Git repository, including its own
objects, index, refs and common directory. Changes still use real Git; fixture
state never crosses repository identities. PTY fixtures cache compiled ownership
code by source bytes inside the suite's scratch tree. Every invocation still
creates its own native session, audit and cleanup window. Fault-injection
variants receive separate executables.

File readiness and queue-state waits subscribe before checking existing evidence.
They follow newly created parent directories, re-read after events, close their
watchers on success, error, cancellation or timeout, and scale response deadlines
with `lib/deadline.mjs`. A partial PID marker cannot authorize a process lookup;
fixture writers publish complete PID bytes by rename. Detached-process audits
still require fresh OS identity checks: a file notification cannot prove a
process has exited. Their finite response allowances scale with measured load.

Normal native fixture command allowances also scale once. Explicit cancellation
bounds, backoff intervals, negative observation windows, caller-selected policy
budgets, and deliberate wall-clock delays retain their durations; changing those
would change the behavior being proved. The native test helper continues to cap
compound commands at the enclosing test allowance and refuses uncertain process
ownership. See [response deadlines](load-deadlines.md).
