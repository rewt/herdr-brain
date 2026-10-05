---
run: R-263
outcome: done
summary: |
  Enforced the exclusion invariant by removing exclusion handling from projectFleet readers. Record discovery, settings layers, lane worktree roots and resolved routes now remain identical with or without exclusion, including stale-mapping refusals. Entry and native sandbox paths check entered and canonical exclusions before mapping resolution, so excluded stale mappings launch natively without adoption notices. One table-driven regression covers seven layouts and both canonical and linked checkouts; focused offline validation passed 73 tests with one optional native boundary probe skipped.
headline: Fleet exclusions preserve record and configuration discovery.
blockers: []
proposals: []
learnings:
  - Exclusion is session policy and must not change projectFleet reader results or bypass ownership and stale-mapping checks.
  - Both entry and native session context must check entered and canonical exclusions before resolving mappings or printing compatibility adoption notices.
  - Explicit ORG_DIR retains its record override even when configuration readers reject a stale mapping; exclusion changes neither behavior.
artifacts:
  - "commit 3145666: Keep fleet exclusions out of record and configuration discovery"
  - branch lane/fleet-membership
  - lib/fleet.mjs
  - discovery/native-sandbox.mjs
  - discovery/README.md
  - test/fleet.test.mjs
  - discovery/test/entry.test.mjs
  - docs/reports/evidence/ENG-214-R263/regressions-red.tap
  - docs/reports/evidence/ENG-214-R263/regressions-green.tap
  - docs/reports/evidence/ENG-214-R263/focused-green.tap
  - docs/reports/ENG-214-fleet-membership-r3-20261005.md
  - ".lane/gate.json: final lane check receipt after this report commit"
decisions:
  - text: Keep exclusion checks in session entry, native sandbox setup and explicit join eligibility, outside record and configuration discovery.
    category: security
    why: The supervisor explicitly requires exclusion to affect only Monitor entry and generated native sandboxes. Reader results must retain the same ownership checks, record history and configuration, while excluded native launch bypasses stale mapping resolution before any notices or sandbox generation.
questions: []
challenges: []
---

Both findings in the independent review of `cc18b9b` are resolved. The inherited
validation log had no failures: 61 passed, one optional native probe skipped.
Previous reports and review records were left unchanged.

`projectFleet` no longer reads exclusion policy or returns an exclusion flag.
Record, route and lane readers therefore use one discovery path whether or not
the entered or canonical root is excluded. Ownership checks and stale-mapping
refusals remain intact. Existing compatibility layouts still require explicit
adoption, as in the previous runs; exclusion never discards their history or
configuration.

`nativeSessionContext` now checks the entered root before Git discovery and the
canonical root before resolving the fleet mapping. Entry already checks both
roots in that order. Excluded native launches avoid stale-mapping errors and
compatibility adoption notices, then retain the native executable's arguments,
checkout, permissions, temp environment and exit code.

One table-driven test compares `findOrgDir`, discovered settings and layer files,
the actual `lane config` output and worktree root, and `resolveLaunchRoute` before
exclusion, during exclusion and after inclusion. Its seven rows are joined
checkout and external records, unjoined checkout and ancestor compatibility
records, unjoined external `ORG_DIR`, a stale mapping with the same Git identity,
and that stale mapping with explicit `ORG_DIR`. Each row covers canonical and
linked checkouts with canonical-root and linked-root exclusions. Successful
layouts write through the record CLI before, during and after exclusion, retain
all work in the original event log and status, and never create a shadow record.
Stale rows compare the same reader failures in every phase; explicit `ORG_DIR`
continues selecting its record while configuration readers continue refusing.

The adapter matrix covers Codex and Claude through explicit and interactive
automatic entry, for unjoined, joined, compatibility and stale layouts. It checks
both canonical exclusions inherited by linked worktrees and entered linked-root
exclusions: exactly one calm line, unchanged arguments and native temp, propagated
exit 7, no sandbox probes, no duplicate launch, no record/runtime creation and no
record changes. Stale fixtures deliberately change only the checkout field in a
scratch mapping and assert that the current Git identity still matches it.

The regression-only run failed before implementation in all three unjoined
compatibility rows and both stale rows, plus explicit and automatic stale native
launch. After implementation it passed 16 checks (including table subtests),
with zero failures. The full focused command was:

```sh
node --test test/fleet.test.mjs discovery/test/entry.test.mjs discovery/test/native-sandbox.test.mjs
```

Result: 73 passed, zero failed, one optional native boundary probe skipped; exit 0.
All fleet product calls isolate `HERDR_MONITOR_FLEET` in-process to scratch.
Evidence is committed under `docs/reports/evidence/ENG-214-R263/`.

After checking and committing this report, the final required operation is:

```sh
node lanes/lane.mjs check --cmd 'node --test test/fleet.test.mjs discovery/test/entry.test.mjs discovery/test/native-sandbox.test.mjs'
```

Its `.lane/gate.json` receipt covers the final committed tree. Promotion and
release validation remain with their designated gates.
