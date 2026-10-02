---
run: R-131
outcome: done
summary: |
  Fixed both round-one recovery gaps. Every workspace-producing Herdr call now
  persists a baseline and confined destination intent before execution, including
  workspace create and worktree create/open with either --cwd or --workspace.
  Cleanup establishes a shared stop barrier and awaits workers, adapters, their
  command children, and recorded watchers before taking recovery snapshots. It
  reconciles again after closing to recover newly visible workspaces.
  Baseline and post-change npm test passed with 725 passes and 11 skips each;
  all 107 offline acceptance tests passed. Live acceptance remains release-only.
headline: Workspace recovery now waits for active acceptance producers to stop.
blockers: []
proposals: []
learnings:
  - 'A workspace creation intent must exist before the native call, independently of whether its reply arrives.'
  - 'Worker command children must be recorded and awaited; stopping adapter admission alone does not finish an active supervisor dispatch.'
  - 'Native workspace path metadata can be absent: a unique generated recovery label or native pane identity and exact cwd proof can recover the new ID safely.'
artifacts:
  - 'Implementation commit subject: Recover every workspace creation after draining acceptance producers'
  - 'Report commit subject: Report Herdr workspace recovery fixes for run R-131'
  - 'Retained prior implementation commit subject: Isolate offline tests and close every acceptance workspace'
  - 'Branch: lane/herdr-leaks; rebased onto main before changes, through Amend ENG-103/ENG-105 briefs: release gate per release, not per lane'
  - 'Recovery and barrier: acceptance/herdr.mjs, acceptance/receipts.mjs, acceptance/producers.mjs, acceptance/cleanup.mjs, acceptance/run.mjs, acceptance/worker.mjs, acceptance/live-worker.mjs'
  - 'Offline regressions: acceptance/test/recovery.test.mjs and acceptance/test/boundary.test.mjs; module contract: acceptance/README.md'
  - 'Baseline npm test log: /tmp/eng107-r131-baseline.log; 725 passed, 11 skipped, zero failed; 484.3 seconds'
  - 'Post-change npm test log: /tmp/eng107-r131-postchange.log; 725 passed, 11 skipped, zero failed; 425.9 seconds'
  - 'Final offline acceptance log: /tmp/eng107-r131-acceptance-verified.log; 107 passed, zero failed; 37.4 seconds'
  - 'Final lane gate command: node lanes/lane.mjs check --cmd "npm test -- --file-timeout=480000 --suite-timeout=540000"; log /tmp/eng107-r131-lane-check.log; authoritative committed-head receipt .lane/gate.json'
  - 'Pre-existing untracked public review preserved unchanged at /private/tmp/eng107-r131-preexisting-review-23n8sy1s/91c134c-r1.md; SHA256 fc5d4420fee5c555925755f8335fd50b89bdb871be2bef293995df594bf64187'
decisions:
  - text: Recover only new native workspace IDs with confined path proof or the unique generated recovery label.
    category: security
    why: Baseline IDs and contradictory foreign paths must never acquire cleanup authority; caller-supplied labels alone are insufficient.
  - text: Record producer registrations before checking the stop marker and await registered command children before cleanup snapshots.
    category: tooling
    why: This closes the admission race and lets an active supervisor finish its dispatch journals before watcher collection and workspace recovery.
  - text: Use the existing bounded test runner with 480000 ms file and 540000 ms suite limits.
    category: prover
    why: The passing baseline exceeds the default suite duration under host load; the shared validation configuration and test scope were not changed.
questions: []
challenges:
  - 'The original brief asks for a live harness inventory comparison. The operator update and AGENTS.md explicitly reserve that harness for release candidates, so no live harness or --skip-live pass was run in this lane.'
  - 'No lanes/ files changed in this round, so npm run test:lanes was not rerun, as directed by the operator update. The inherited offline isolation remains in place.'
  - 'The pre-existing untracked public review made the lane dirty. It was moved unchanged to the named scratch location so the final gate can validate a clean committed worktree; private review findings were not copied into the repository.'
---

Recovery intents now cover all five forms: workspace create, worktree create
with --cwd, worktree open with --cwd, worktree create with --workspace, and
worktree open with --workspace. The synced intent contains the original native
inventory IDs, canonical destination paths, and label. When no label was supplied,
the adapter adds a unique recovery label. Existing caller labels remain intact.
Lost-reply recovery excludes baseline IDs, refuses contradictory foreign paths,
and verifies native pane membership and exact cwd when caller-labelled workspace
metadata has not arrived. Recovered IDs receive durable creation receipts.

The shared marker prevents new adapter and worker commands. Registrations track
native CLI and scripted command children; workers stop after active commands
finish, and the live worker stops and awaits its owned child. The runner drains
these producers before reading dispatch journals, then stops and awaits the
receipt-owned watchers. Cleanup subsequently reads ownership and receipts,
reconciles native inventory, closes owned IDs, reconciles again, closes newly
visible creations, and audits the final raw inventory. A drain timeout refuses
the snapshot and retains scratch rather than claiming successful cleanup.

The 15 new offline regressions include ten active lost-reply interruptions:
SIGINT and SIGTERM across all five creation forms. The fake native executable
checks that the intent already exists, commits after receiving the signal, and
returns no creation reply. Cleanup inventories must occur after producer
completion and drain; new workspaces close while baseline and foreign IDs remain.
Additional controls cover a held producer, refused late admission, delayed
inventory visibility, a misleading foreign label/path, SIGTERM during an actual
scripted supervisor dispatch with a receipted child, and isolated idle-worker
shutdown without stopping other workers.

Both full core runs used `npm test -- --file-timeout=480000 --suite-timeout=540000`.
The final offline acceptance command was `npm run test:acceptance`. An initial
offline run exposed an obsolete assertion that creation was the first workspace
call; it now selects the creation verb after the required baseline read. An early
supervisor control also assumed the parent's exit notification preceded its exit
acknowledgement; the final control checks the durable drain and awaits process
exit. The final suites have no failures. Tests use scoped scratch fixtures,
fixture actors, fake/refusal Herdr executables and absent scratch sockets; no
model or operator-workspace mutation was invoked.

The prevention scope, including the retained prior offline-isolation fix, covers
the brief's 245 documented leaked creations: 212 plugin-test workspaces and 33
acceptance workspaces. Those are historical brief counts, not a newly measured
live delta. Historical receipts are unavailable to attribute individual leaks
to either round-two gap. Existing operator leaks were left to the supervisor.
Release-only live acceptance still needs to verify the final candidate's native
inventory preservation.

This report is record-checked and committed before the final lane check. The
gate runs last against that report commit; its result and exact committed head
are recorded in `.lane/gate.json` and the named scratch log, outside this report.
