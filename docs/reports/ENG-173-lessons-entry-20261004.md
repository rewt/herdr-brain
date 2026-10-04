---
run: R-229
outcome: done
summary: |
  Installed Codex and Claude entry now share a bounded section of matching active lessons from the project's record, using the original entered directory even when entry allocates a lane. The MCP adapter exposes read-only record_lessons through CLI argument arrays. A release-gate case plants an area lesson and witnesses delivery at both fresh native UI boundaries; offline regressions exercise the real installed adapters with stand-ins. Implementation and report are committed in the lane; the final action is the focused lane check below. The live release gate remains for the canonical supervisor.
headline: Active lessons now reach both entry adapters and the record MCP tool
blockers: []
proposals: []
learnings:
  - Entry must retain the original project-relative directory before allocating a worker checkout; querying lessons without a target would include unrelated area lessons.
  - Native entry transports also receive sandbox capability probes; those calls must not overwrite the fresh session's policy receipt.
  - The fresh UI canary uses scratch homes and no model turn; native prompt arguments plus a rendered UI witness delivery, while a proposed lesson fails the same offline check.
artifacts:
  - "Implementation commit: 2e442d74258e77bee161ad70aa05893e05601e57"
  - "Branch: lane/lessons-entry"
  - discovery/lessons.mjs
  - discovery/test/lessons.test.mjs
  - mcp/server.mjs
  - acceptance/lessons.mjs
  - acceptance/test/lessons.test.mjs
  - docs/reports/ENG-173-lessons-entry-20261004.md
  - "Final lane check: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs discovery/test/lessons.test.mjs acceptance/test/lessons.test.mjs mcp/test/server.test.mjs'"
decisions: []
questions: []
challenges: []
---

The shared entry section reuses ENG-168's model-free selector and bounded renderer:
five lessons, bounded claims/applicability/evidence, and a count of remaining
matches. It defaults to active lessons, includes applicable scopes from this
project's selected record, excludes unrelated path/module selectors, and disappears
when no lessons match. No other records are searched. `enteredPath` is captured
relative to the original Git checkout, including nested linked-worktree entry.
The adapters' existing prompt transports carry the section unchanged.

`record_lessons` accepts optional `path`, `module`, `scope`, `state`, and `json`.
It advertises read-only/idempotent annotations and a strict schema, accepts an
omitted arguments object, and executes only `bin/org.mjs lessons` with argument
arrays. Tests compare CLI output, exercise lifecycle filters and literal shell
syntax, and verify that the event log does not change.

The stable release case `lessons-entry` requires the existing Herdr fixture and
both native CLIs. It installs candidate automatic entry into scratch machine bins,
plants an active path lesson through the record CLI, and opens fresh Codex and
Claude UIs from that area. The shared receipt helper captures the actual native
arguments and installed policy source; a screen must also show each native UI.
The kernel boundary denies network and writes outside scratch/terminal devices.
No task prompt, operator authentication, or model invocation is needed. Ownership,
producer registration, finite deadlines, and final cleanup use the existing gate
machinery. Missing tools or explicitly skipped live entry keep the gate pending.

Validation completed before committing:

- `npm --prefix mcp ci`: installed the pinned optional dependencies.
- `npm --prefix mcp test`: 8/8 passed, offline.
- `node --test discovery/test/entry.test.mjs discovery/test/lessons.test.mjs`:
  8/8 passed, offline.
- `npm run test:acceptance`: 61/61 passed in its declared offline tier.
- `node test/helpers/run.mjs acceptance/test/boundary.test.mjs acceptance/test/lessons.test.mjs acceptance/test/native-transport.test.mjs acceptance/test/verification.test.mjs acceptance/test/cleanup.test.mjs`:
  39/39 passed, including actual scratch kernel boundaries, native stand-ins,
  negative delivery, copied imports, launch ownership, and cleanup.
- `git diff --check`: passed.

macOS kernel regressions ran outside the enclosing agent sandbox because nested
`sandbox-exec` is denied there. They remained offline and used only scratch PTYs
and fake native executables. No live acceptance harness or `--skip-live` harness
pass ran in this lane. No changes were made to the core, supervisor, or brain.

After checking and committing this report, run the recorded focused lane check
last and stop. It validates the committed report tree; promotion and the live
release gate belong to the supervisor.
