---
run: R-189
outcome: done
summary: |
  Rebased the accepted entry-identity lane onto main at eb710c0. Resolved the
  supervisor/context.mjs conflict by retaining main's host memory/process evidence
  and argv filtering alongside this lane's process-identity reader. No new work
  was added. All 17 selected offline tests covering the conflicted context passed.
  Supervisor review remains pending; promotion is reserved for the shared batch.
  The final focused lane check runs after this checked report is committed.
headline: The entry identity lane is rebased and ready for supervisor review
blockers: []
proposals: []
learnings:
  - coldStart must preserve both memory/process evidence options and the readProcess option used by housekeeping identity recovery.
artifacts:
  - branch lane/entry-identity
  - base eb710c0
  - commit 74defa0 Bind supervisor recovery to process birth identities
  - commit 1486533 Report supervisor entry identity recovery for R-182
  - supervisor/context.mjs
  - docs/reports/ENG-136-entry-identity-rebase-20261003.md
  - .lane/gate.json produced by the final lane check
decisions: []
questions: []
challenges: []
---

The only conflict was the `coldStart` parameter list and main's process-row
projection. The resolution preserves `memory = readMemory()`,
`processes = processUsage()`, and the projection that excludes process argv,
while accepting `readProcess` and forwarding it to `housekeepingSnapshot`.
Watcher birth identities remain visible in run facts. The original implementation
and report were replayed as the two commits above; no additional implementation
changes were made.

Focused validation:

```sh
node --test --test-name-pattern='cold[ -]start|housekeeping snapshot|watch recovery|entry twice|ingested report decisions|full JSON|disappeared checkout' supervisor/test/supervisor.test.mjs supervisor/test/entry.test.mjs
```

Result: 17 passed, zero failed, 52 deliberately excluded by the name filter.
These cover host pressure, process argv filtering, read-only cold-start context,
record scoping and continuity, housekeeping birth diagnostics, watcher identity
recovery, and nonblocking entry failures. `git diff --check` passed, and main's
requested base is an ancestor of the rebased lane.

The report is checked with `record check` before its commit. The last operation
is `node lanes/lane.mjs check --cmd` with the focused command above; its result is
retained in `.lane/gate.json` and the shared validation receipt. No promotion,
push, report ingestion, full suite, live acceptance harness, or project-wide
housekeeping loop is part of this rebase round.
