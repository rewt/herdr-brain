# Validation tiers in herdr-brain

Promotion runs once per batch before main moves. `npm run test:promotion` holds
the host test slot and runs native slot ownership tests, explicitly named logic
and merge correctness files, and a selected lane lifecycle subset through the
existing bounded runner. Fast remains the worker smoke command.

`npm run test:release` retains the complete former promotion chain: slot, core,
cycle, lanes, offline acceptance and the release-only tier inventory. The release candidate prepare step runs
its build step, runs this full suite under the release-owned
slot, and writes build evidence only after success. Preparation failure stops
the release lifecycle before live acceptance. The live harness still runs once
per release candidate; lanes never run it. No behavioral assertion was deleted.

The explicit promotion file list is in `test/helpers/tier.mjs`; selected mixed-file
case patterns remain in `package.json`. Real processes remain in
CI where they protect record consistency, canonical Git identity, current-run
readiness, clean replay, compare-and-swap, clean fast-forward or recoverable
archives. Most installed-adapter, PTY, copied-product, reviewer/dispatch cycle,
wall-clock, sandbox and fake-server integration runs move to release.

The 31 original whole files moved from CI are listed below; the mixed-file tables identify
fast cases retained from the other files. The full lane file still runs in release;
only the merge-critical titles listed afterward remain in promotion.
The merged ENG-135 inventory assigns 69 full files to promotion and the remaining
54 to release, including mixed files supplying selected promotion cases. Each of
all 123 bounded files runs once in the complete release command. New files default
to release until explicitly assigned to promotion. ENG-135's file-wait, Git-seed
and tier-plan regressions are retained in promotion. Its additional slow files
remain in release:

| Additional release file | Behavior protected | Reason |
| --- | --- | --- |
| `test/deadline-boundaries.test.mjs` | Git response past the old command deadline; nested suites exceeding one fixture command while ordinary commands remain bounded. | Real 15.2/15.5-second response boundaries. |
| `settle/test/ref-wallclock.test.mjs` | Slow start/prepare/commit ref-transaction replies preserve success under load. | Three real 15.2-second responses, extracted by ENG-135 from ref-deadlines. |
| `test/pty-cache.test.mjs` | Unchanged native ownership code compiles once; fault variants and source changes get separate executable bytes. | Native compilation and real PTY sessions. |

| File moved to release | Behavior protected | Reason |
| --- | --- | --- |
| `acceptance/test/boundary.test.mjs` | Confined native adapter preserves socket identity, ownership, no-focus rules and explicit refusal attribution. | Native confinement, socket, focus, load or release cleanup integration. |
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
| `test/fleet.test.mjs` | first entry maps an existing record in place; a neighbouring repository gets its own record and routes; concurrent first entries publish one complete fleet with both projects; join is a byte and mtime no-op from a linked checkout; session limit changes only through join | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/pty.test.mjs` | Real PTYs retain arguments/status/TTY and independent native cleanup through timeouts, refusal and outer-runner death. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/release.test.mjs` | Legacy immutable tagged release switches/rollback/restore preserve launchers and legacy plugin links and refuse while the retired Brain LaunchAgent remains. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/settle-watch.test.mjs` | Retained settle-watch compatibility launcher keeps its flags, route arguments and acting-session record. | Process/transport, installed-product or lifecycle integration; merge invariants retain focused coverage. |
| `test/startup-deadlines.test.mjs` | Module startup handshakes receive measured-load allowances without starting real project background services. | Real elapsed response, watchdog or descendant-cleanup integration. |
| `test/test-hangs.test.mjs` | Native watchdog/ownership cleanup survives blocked event loops, cancellation, nested runners and detached descendants without touching replacements. | Real elapsed response, watchdog or descendant-cleanup integration. |

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
| `test/load-deadlines.test.mjs` | Measured-load calculations, native executor allowances and record-lock ownership. | The real response beyond the old deadline moved to `test/deadline-boundaries.test.mjs` and runs only in release. |
| `settle/test/ref-deadlines.test.mjs` | Exhausted/refused transactions, concurrent-ref CAS and foreign locks. | Three real 15.2-second start/prepare/commit responses moved to `settle/test/ref-wallclock.test.mjs` and run only in release. |
| `supervisor/test/delivery.test.mjs` | Captured composer/ANSI parsing, wrapping and placeholder ambiguity. | Quiet-read waits, fake Herdr transport, durable delivery/replay and inbox teardown run in release. |
| `housekeeping/test/housekeeping.test.mjs` | Interruption/composer parsing. | Native Git lifecycle, process/startup, schedule recovery and fake Herdr action scenarios run in release. |
| `supervisor/test/entry.test.mjs` | Repository hook policy. | Installed adapters, startup/recovery and durable pane/owner integrations run in release. |

The R-206 audit restores the following fast cases to the existing logic selector.
These use assertions, small file fixtures or injected operations; they launch no
real child process and wait for no elapsed deadline. All cases also remain in
the complete release inventory. See [the audit](reports/ENG-157-fast-ci-evidence-20261004/logic-audit-R-206.md)
for exact retained titles and the audit of every whole-file deferral.

| Partial file | Kept in promotion | Moved behavior and cost |
| --- | --- | --- |
| `acceptance/test/load-round2.test.mjs` | Both injected-load cutover aggregation classifications. | Real TAP children, delegated fixtures and elapsed receipt/queue deadlines. |
| `acceptance/test/cleanup.test.mjs` | Receipt ownership, failed inventory, unreceipted refusal, lost-reply recovery and malformed journals (six cases). | Native adapter reply/layout processes and signal cleanup children. |
| `acceptance/test/focus.test.mjs` | Owned-change failure and incomplete-monitor refusal. | Real socket monitor processes, native events and elapsed sampling/replay. |
| `acceptance/test/recovery.test.mjs` | Late inventory reconciliation and foreign-path authority refusal. | Signal/producer processes, elapsed producer drain and supervisor cleanup. |
| `dispatch/test/dispatch.test.mjs` | Both injected watcher receipt/journal PID reuse and retry ownership checks. | Real record/Git/dispatch/watch CLI lifecycles, waits and process recovery. |
| `housekeeping/test/auto-tidy.test.mjs` | Topology authority refusal and review-route/topic/verdict freshness. | CLI and fake-server tidy actions, current occupant/record rechecks and scheduling. |
| `watch/test/watch.test.mjs` | Distinct compact notices for every terminal condition. | Detached watchers, record/Herdr delivery, real file events and elapsed grace windows. |
