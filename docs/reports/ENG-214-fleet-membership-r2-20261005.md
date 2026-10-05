---
run: R-261
outcome: done
summary: |
  Resolved all three independent review findings. Excluded joined projects keep their external record, parent settings and mapped worktrees for readers and record writes, while entry and native sandbox generation still pass through. Existing external records selected by ORG_DIR retain their discovered settings and worktrees until explicit adoption. Neighbors with distinct records cannot inherit another project's mapped parent layer without explicit sharing. Focused offline validation passed 61 tests with one optional native boundary probe skipped.
headline: Fleet exclusions preserve records and project settings stay isolated.
blockers: []
proposals: []
learnings:
  - Fleet exclusion is entry policy; joined project metadata must remain available to record and configuration readers while excluded.
  - An existing external ORG_DIR can preserve an unjoined discovery layout but cannot prove ownership for automatic adoption; the printed command must select --record explicitly.
  - Compatibility discovery must check canonical ownership of both the discovered record and nearest parent settings layer, including symlink aliases.
artifacts:
  - "commit 79b4215: Fix excluded fleet readers and compatibility ownership"
  - branch lane/fleet-membership
  - lib/fleet.mjs
  - discovery/native-sandbox.mjs
  - discovery/README.md
  - test/fleet.test.mjs
  - discovery/test/entry.test.mjs
  - docs/reports/evidence/ENG-214-R261-validation.txt
  - docs/reports/ENG-214-fleet-membership-r2-20261005.md
  - ".lane/gate.json: final lane check receipt after this report commit"
decisions:
  - text: Keep compatibility discovery and explicit adoption for external ORG_DIR layouts.
    category: design
    why: An inherited environment variable does not prove project ownership. Preserving the existing routes, trusted profile and worktree root avoids silent changes, while the printed command names every path to adopt explicitly.
  - text: Keep joined mappings readable while exclusions gate entry and generated native sandboxes.
    category: security
    why: The authorized exclusion behavior is native passthrough. Discarding the mapping for readers instead creates a second record and changes lane configuration, so exclusion must remain a separate entry policy flag.
  - text: Require explicit --layer adoption to share another project's mapped parent settings.
    category: security
    why: A neighbor's own local record does not authorize importing another project's routes, memory profile or lifecycle configuration. Canonical path comparison also prevents sharing through a settings symlink without adoption.
questions: []
challenges: []
---

The independent review of `ebbfa14` identified three findings; all are corrected.
The inherited validation log had no failures (54 passes and one optional skip).
The prior report and review were left unchanged.

`projectFleet` now returns the joined mapping together with an exclusion flag.
Record lookup and lane/configuration readers retain the mapped external record,
settings layers and worktrees. Entry already checks exclusions before mutations;
native session context now checks the flag separately before generating sandbox
settings. Regression coverage writes work through the record CLI while canonical
or linked checkouts are excluded, checks status, and verifies inclusion retains
the same event log without creating a second local record.

Compatibility discovery now considers an existing record selected by `ORG_DIR`
without requiring an ancestor `.org`. Moved and unmoved projects keep identical
route and lane configuration before and after another project creates the fleet.
Reads and entry do not change fleet membership or record bytes; bare join refuses
implicit adoption. The tests execute the printed shell-quoted adoption command,
including a checkout containing spaces and an apostrophe, and verify the selected
record, layer and worktree root. First join elsewhere never adopts the inherited
external record.

The nearest parent settings layer is checked against every joined project's
canonical layer paths. A neighbor with a distinct local record keeps that record
but uses independent settings until it explicitly adopts the shared layer. Tests
cover ordinary parent settings and a `.lane.json` symlink to a mapped layer,
automatic independent entry, and successful explicit sharing.

The five new regression cases failed before implementation and passed afterward.
Final focused integration ran:

```sh
node --test test/fleet.test.mjs discovery/test/entry.test.mjs discovery/test/native-sandbox.test.mjs
```

Result: 61 passed, zero failed, one optional native boundary probe skipped; exit 0.
The adapter matrix checks both Codex and Claude, explicit and interactive entry,
and unjoined/joined excluded repositories plus linked worktrees: one calm line,
unchanged arguments and native temp, native exit propagation, no sandbox probes
or duplicate launch, and no record/runtime creation. All product calls isolate
`HERDR_MONITOR_FLEET` in-process to scratch. Evidence is committed under
`docs/reports/evidence/ENG-214-R261-validation.txt`.

After checking and committing this report, the required final operation is:

```sh
node lanes/lane.mjs check --cmd 'node --test test/fleet.test.mjs discovery/test/entry.test.mjs discovery/test/native-sandbox.test.mjs'
```

Its `.lane/gate.json` receipt covers the final committed tree. Promotion and
release validation remain with their designated gates.
