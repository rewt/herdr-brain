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
explicit `promotion` list contains 69 full files; the `release` list discovers the
other 54 files. Selected fast cases from mixed release files remain in the
promotion logic and lane commands. The complete release command runs each of
all 123 bounded files once through core, cycle, lanes, acceptance and release-only
steps, plus the native slot suite. New files default to release until explicitly
assigned to promotion. See [validation tiers](../validation-tiers.md) for the
behavior inventory and measured promotion timing. The
native test-slot suite has its own runner because it intentionally exercises
real detached groups. `test/mcp.test.mjs` runs the optional MCP tests when their
dependencies are installed and otherwise names the skip. Console startup and
provider/kernel checks likewise report their prerequisite skips.

The project release wrapper executes the offline release tier against the
prepared candidate before writing build evidence and starting acceptance. A failed check prevents that
candidate's live gate. This is part of the once-per-candidate gate; workers run
only the offline command when it is relevant. Acceptance source and its timeout
policy remain independently maintained.

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
