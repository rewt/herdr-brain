# Validation tiers in herdr-brain

Promotion runs once per batch before main moves. `npm run test:promotion` holds
the host test slot and runs native slot ownership tests, explicitly named logic
and merge correctness files, and a selected lane lifecycle subset through the
existing bounded runner. Fast remains the worker smoke command.

`npm run test:release` retains the complete former promotion chain: slot, core,
cycle, lanes and offline acceptance. The release candidate prepare step installs
the pinned offline dependencies, runs this full suite under the release-owned
slot, and writes build evidence only after success. Preparation failure stops
the release lifecycle before live acceptance. The live harness still runs once
per release candidate; lanes never run it. No behavioral assertion was deleted.

The explicit promotion file list is in `package.json`. Real processes remain in
CI where they protect record consistency, canonical Git identity, current-run
readiness, clean replay, compare-and-swap, clean fast-forward or recoverable
archives. Most installed-adapter, PTY, copied-product, reviewer/dispatch cycle,
wall-clock, sandbox and fake-server integration runs move to release.

Whole files moved from CI are listed below. The full lane file still runs in
release; only the merge-critical titles listed afterward remain in promotion.
All new test files must be assigned deliberately to promotion or release.

| File moved to release | Behavior protected | Reason |
| --- | --- | --- |
| `acceptance/test/boundary.test.mjs` | Confined native adapter preserves socket identity, ownership, no-focus rules and explicit refusal attribution. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/cleanup.test.mjs` | Cleanup closes only receipt-owned resources and reports residue despite malformed journals or failed inventory. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/cutover.test.mjs` | Cutover and rollback preserve exact bytes; transitive executable callers prevent premature contrib retirement. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/focus.test.mjs` | Continuous focus evidence distinguishes operator activity from transient owned moves and refuses incomplete monitoring. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/load-round2.test.mjs` | Operation-scoped contention may classify timeouts as pending, while independent assertions and safety failures remain failures. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/recovery.test.mjs` | Signals stop producers before ownership snapshots and recover late or lost replies without granting foreign authority. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/validation.test.mjs` | Confined native validation and promotion protect Git/shared state while allowing only proved scratch writes. | Native confinement, socket, focus, load or release cleanup integration. |
| `acceptance/test/verification.test.mjs` | Kernel-confined verification permits authorized refs/worktrees but denies config, hooks and redirected record writes. | Native confinement, socket, focus, load or release cleanup integration. |
| `console/test/session.test.mjs` | Session interaction routes answers through the CLI, preserves modal input and distinguishes gone from unavailable sessions. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/acceptance.test.mjs` | Copied Codex and Claude workflows validate, guard, promote and finish both worker and approved-routing changes offline. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/entry.test.mjs` | Installed supervisor entry completes the unconfigured cold-start and notice contract using real record and lanes. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/lifecycle.test.mjs` | Atomic lifecycle receipts and conservative close rules retain ignored files, working sessions and unconfirmed process evidence. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/owner.test.mjs` | Bundled native ownership binaries match source/architecture and preserve independent bounded cleanup without compiler overrides. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/review-r2.test.mjs` | Provider guards refuse writable symlink escapes and preserve PTY argument, shell, filter and validation boundaries. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/review-r3.test.mjs` | Kernel syscall/network guards and detached cleanup retain immutable ownership evidence and protect unrelated processes. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/review.test.mjs` | Automatic entry, route adoption and validation guard preserve project opt-out, canonical records and refusal safety. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/sandbox.test.mjs` | Optional real native sandbox supports authorized validation/promotion while denying external writes and Git metadata. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `discovery/test/settings.test.mjs` | Installed interactive adapters honor opt-out, explicit assignment, project settings and conservative entry cleanup. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `dispatch/test/dispatch.test.mjs` | Dispatch validates priorities, startup, identity and reports; lost replies, STOP, refused ownership and PID reuse never duplicate or authorize work. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `housekeeping/test/auto-tidy.test.mjs` | finished worker tabs close before promotion while working, blocked, unnamed and operator tabs stay; dry-run previews finished tabs and never closes, including through housekeeping --once; a working or blocked change at the final recheck preserves the finished tab | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `lanes/test/workspace-native.test.mjs` | native dispatch opens a one-tab lane from a project with no Herdr workspace and preserves focus | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `release/test/release.test.mjs` | Release state machine binds immutable candidates, records/retries gate evidence and refuses stale main or failed preflight without executing ship. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `settle/test/config.test.mjs` | Settle intake and canonical review use validated project settings and independent reviewer routes. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/memory-boundaries.test.mjs` | Memory and STOP at dispatch/review child boundaries remain resumable and never create hidden double waits. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/recapture.test.mjs` | recovery: record-stage recapture waits for ingestion and follows the latest main; two recaptures after an applied rebase replay only lane and review commits from the same lineage; uncertain review retry guards lane mutation before recapturing a moved main | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/receipts.test.mjs` | Report ingestion and correction receipts recover lost replies without repeating dispatch or accepting uncaptured reports. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/round-cap.test.mjs` | Review caps preserve severity, claim verification, STOP, exact head/current run and idempotent record recovery. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/settle.test.mjs` | Unconfigured independent review/correction cycle preserves claim verification, readiness, queue delivery, restart and safe fixture teardown. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/teardown.test.mjs` | Fixture teardown stops freshly owned detached inbox/transport groups before deleting evidence and refuses uncertain ownership. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `settle/test/validation-tiers.test.mjs` | Worker, settle and queue panes reuse validated trees only while head, command and environment match. | Full review/correction, recovery or transport integration; rebase and current-record guards remain in CI. |
| `supervisor/test/supervisor.test.mjs` | Foreground supervisor enforces review/correction caps, STOP, bound promotion, durable context and conditional record completion. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/brain-start.test.mjs` | Brain launcher records the acting session through a fake Herdr transport. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/console-launch.test.mjs` | Console CLI explains missing dependencies and launches/configures the optional console correctly. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/fleet.test.mjs` | first entry maps an existing record in place; a neighbouring repository gets its own record and routes; concurrent first entries publish one complete fleet with both projects; join is a byte and mtime no-op from a linked checkout; session limit changes only through join | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/mcp.test.mjs` | Core wrapper invokes optional offline MCP suite when dependencies exist and names its missing-dependency skip. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/open-session.test.mjs` | Legacy session launcher records actor/run identity, resolves routes and refuses duplicate supervisor/settle sessions. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/plugin-install.test.mjs` | Install/upgrade/rollback/recovery preserve exact shell bytes/modes and foreign runtime state across real CLI and PTY boundaries. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/pty.test.mjs` | Real PTYs retain arguments/status/TTY and independent native cleanup through timeouts, refusal and outer-runner death. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/release.test.mjs` | Legacy immutable tagged release switches/rollback/restore preserve launchers, Brain service and plugin links. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/settle-watch.test.mjs` | Retained settle-watch compatibility launcher keeps its flags, route arguments and acting-session record. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/startup-deadlines.test.mjs` | Module startup handshakes receive measured-load allowances without starting real project background services. | Real elapsed response, watchdog or descendant-cleanup integration. |
| `test/test-hangs.test.mjs` | Native watchdog/ownership cleanup survives blocked event loops, cancellation, nested runners and detached descendants without touching replacements. | Real elapsed response, watchdog or descendant-cleanup integration. |
| `watch/test/watch.test.mjs` | Real detached watcher derives report/worker terminal states, wakes on file events and delivers durable notices once across typing, restart and transport outage. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |

Lane merge checks retained in promotion (`test:promotion:lanes`):

- promote refuses a dirty lane worktree
- promote leaves main unchanged when validation fails
- promote rebases a clean lane behind main and fast-forwards
- promote refuses to linearize a merge-bearing lane while the equivalent linear lane promotes
- promote accepts a gitignored session registry in the canonical checkout
- promote refuses a conflicting rebase and names the file
- promote refuses when main moves during validation
- close deletes a merged branch
- close retires a background workspace without worktree.remove and preserves the archive
- close refuses a dirty worktree
- close preserves a locked worktree and its workspace when Git removal refuses
- linked invocations use canonical repository config for explanation, check, and promote
- bare repositories with only linked worktrees allow reads and refuse mutations clearly
- same-named repositories in equal-labeled roots keep distinct paths, labels, agents, and git identities
- open refuses symlink escapes and destinations inside repository checkouts before mutation
- registered paths are rejected when their on-disk repository identity changes
- failed archive and post-close metadata writes preserve honest completion state
- a repository with a separate git directory retains its canonical checkout identity
- selected malformed, unreadable, and wrongly typed config files fail before mutation
- open refuses ordinary and foreign-worktree destinations without creating branches

Every other title in `lanes/test/lane.test.mjs` moves to release. These cover
Herdr startup/readiness, workspace/tab setup, routing/configuration matrices,
display-only session/registry metadata and review publication/transport. Their
real process/server/wait cost is paid once per candidate. Exact selection uses
`--test-name-pattern` passed to Node's existing test runner; the same suite group,
watchdogs, offline policy and owned-process cleanup apply.

Validation evidence still binds the entire Git tree, command and environment.
All lifecycle freshness and cleanliness guards remain unchanged. Native entry
bounds and the host slot's PID/birth identity, refusal and retry semantics are
unchanged. Leaf steps alone may retry a timeout under measured load once.

Mixed files retain fast logic and safety checks via `test:promotion:logic`:

| Partial file | Kept in promotion | Moved behavior and cost |
| --- | --- | --- |
| `test/load-deadlines.test.mjs` | All except the 15.2-second Git response. | Real response beyond the old deadline runs only in release. |
| `settle/test/ref-deadlines.test.mjs` | Exhausted/refused transactions, concurrent-ref CAS and foreign locks. | Three real 15.2-second start/prepare/commit responses run only in release. |
| `discovery/test/alternatives.test.mjs` | Provider selection and confinement profile construction. | Scratch installation, native sandbox/syscall/filter/network and descendant deadlines run in release. |
| `discovery/test/validation-deadlines.test.mjs` | Static owner, wrapper and client allowance calculations. | Real descendant lifetime and delayed promotion run in release. |
| `supervisor/test/delivery.test.mjs` | Captured composer/ANSI parsing, wrapping and placeholder ambiguity. | Quiet-read waits, fake Herdr transport, durable delivery/replay and inbox teardown run in release. |
| `housekeeping/test/housekeeping.test.mjs` | Interruption/composer parsing. | Native Git lifecycle, process/startup, schedule recovery and fake Herdr action scenarios run in release. |
| `supervisor/test/entry.test.mjs` | Repository hook policy. | Installed adapters, startup/recovery and durable pane/owner integrations run in release. |
