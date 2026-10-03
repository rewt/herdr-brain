---
run: R-162
outcome: done
summary: |
  Built the minimal fleet registry, automatic entry and idempotent join, project-bounded record and settings discovery, console reads and stale checkout display, and an adjustable advisory session limit defaulting to six. Existing records are mapped in place; agents can use the installed monitor command when bypassing entry. The eleven offline acceptance tests pass, the diff was reviewed against the brief, and implementation commit 564e81e is ready for promotion validation.
headline: The fleet now joins projects automatically and keeps their discovery separate.
blockers: []
proposals: []
learnings:
  - HERDR_MONITOR_FLEET selects the fleet home directory, whose registry is fleet.json.
  - Existing console checkout-to-record mappings supply explicit adoption evidence; an ancestor record alone does not prove ownership.
  - The monitor launcher must be included in entry installation and recovery allowlists, as well as the stable runtime snapshot.
  - Offline fixtures now pin a separate fleet home per test file so entry cannot register projects in the operator's fleet.
artifacts:
  - "commit 564e81e: Add the project fleet registry and bounded discovery"
  - "branch lane/fleet"
  - "lib/fleet.mjs"
  - "test/fleet.test.mjs"
  - "discovery/README.md#fleet"
  - "node test/helpers/run.mjs test/fleet.test.mjs: 11 passed, 0 failed"
  - "docs/reports/ARCH-17-fleet-build-20261003.md"
decisions:
  - text: New projects retain the native checkout .org record while their default worktree and temp locations are keyed by Git identity under the fleet home.
    category: design
    why: The minimal brief requires independent records and location mapping, so retaining the existing record layout avoids changing native bootstrap and existing entry contracts; no existing record moves.
questions: []
challenges: []
---

Implemented the ask and the HUM-24 through HUM-27 decisions. The machine boundary
is called the fleet; Herdr keeps workspace for its tab groups. Only entry/join
writes the versioned registry. A short atomic directory lock and atomic file
replacement serialize simultaneous first joins, reusing the existing entry lock
implementation. Project ownership is its canonical Git common directory.

Entry maps an existing checkout record or the entered checkout's explicit legacy
console record mapping. The herdr-brain mapping therefore retains rewt/.org;
bch-cloak can retain bastian/.org through its existing mapping or explicit join.
Unmapped neighbours get their own checkout record. Parent settings are read only
from explicitly mapped layers. Explicit ORG_DIR and LANE_CONFIG selections remain
available, and absent-fleet discovery retains its previous behaviour.

The installed `monitor fleet join` command is available without an entry session.
`monitor fleet join --session-limit N` changes the workload limit through the same
writer; `monitor fleet show` reads it. Entry policy and both console views surface
the advisory limit. Console refresh reads new joins and limit changes. Fresh Git
checks mark moved or replaced checkouts stale and remove usable record bindings.

Acceptance evidence from the tests written before implementation:

- Initial red run: seven tests, six failures and one pass. Entry created no fleet,
  join was unavailable, and malformed fleet input did not raise an error. The
  existing absent-fleet discovery test passed.
- Final development run: eleven tests, eleven passes, zero failures in 5.10 s,
  using `node test/helpers/run.mjs test/fleet.test.mjs`.
- A scratch herdr-brain adopts its ancestor record and owned parent routes; its
  neighbouring repository gets a different record and suggested default routes.
  The first project's event log remains byte-identical.
- Two simultaneous first entries retain both complete project mappings and
  distinct records in one valid fleet file.
- Repeated join from a linked checkout preserves registry bytes and mtime.
  Joining also leaves Git clean. A limit of one still permits two worker entries.
- A moved checkout stays stale in show, console loading and an existing console
  catalog; reads leave registry bytes unchanged.
- Invalid JSON, a zero limit and an incomplete project schema all fail before
  entry, join, record add or record init can touch records or project runtime.
- Explicit adoption preserves the chosen record, worktree, temp and settings
  paths, and refuses assigning the same record to another project.
- Lower-level and stable snapshot installation supply a working monitor launcher;
  recovery restores its prior bytes and removal removes it.
- The project view visibly includes the advisory limit and stale checkout notice;
  an already-open console sees a later join and limit adjustment on refresh.
- Without a fleet file, ancestor record/routes discovery and console project
  configuration remain unchanged, and reads create no fleet home.

Reviewed the complete diff against the brief before committing. No leases, fleet
record, fleet supervisor or sandbox grants were added. No model or live acceptance
harness was called, no project housekeeping was started, and no bch-cloak checkout
or record was written. All installation and entry probes used owned scratch data.
The bounded test runner required process inspection outside the lane sandbox;
the initial sandboxed attempt failed at ps before executing tests, then the
authorized offline test runs completed normally.

Per the brief, there was no baseline, npm test, test:promotion or test:lanes run.
The required final `node lanes/lane.mjs check` follows checking and committing this
report; its fast gate receipt is `.lane/gate.json`, and full merge validation
remains the promotion step.
