---
run: R-167
outcome: done
summary: |
  Rebased lane/fleet onto main and fixed the major discovery hang, both moderate entry and console regressions, and both requested minor issues. Added one regression test per finding, observed all five fail before implementation, and passed 52 focused offline tests after the fixes. Preserved the supervisor's review unchanged in its own commit; implementation and test evidence are committed and ready for review and promotion validation.
headline: The fleet now preserves project records, entry settings, and console visibility.
blockers: []
proposals: []
learnings:
  - Entry worktree-root selections are session overrides; the fleet stores the project default and only explicit join adoption maps a different default.
  - Disposable entry fixtures need separate fleet homes because deleting a checkout intentionally leaves a stale mapping that automatic join must not guess around.
  - The default fleet home must resolve a symlinked HOME before atomic writes with no-follow directory traversal.
  - Entry must verify Git identity, HEAD, and the checkout's configured integration branch before joining or creating a record.
artifacts:
  - "commit 95ecab6: Add fleet independent review record"
  - "commit 772db9e: Fix fleet discovery boundaries, entry overrides, and adoption"
  - "branch lane/fleet, rebased onto main at 61be51b"
  - "docs/reviews/fleet/80c2cd4-r1.md, committed unchanged"
  - "test/fleet.test.mjs, five new regression tests"
  - "docs/reports/evidence/ARCH-17-R167/regressions-red.tap: 11 passed, 5 failed before implementation"
  - "docs/reports/evidence/ARCH-17-R167/focused-green.tap: 52 passed, 0 failed"
  - "docs/reports/evidence/ARCH-17-R167/focused-before-isolation.tap"
  - "docs/reports/evidence/ARCH-17-R167/focused-before-eligibility.tap"
  - "discovery/README.md, session override, merged console, and replacement contracts"
  - "docs/reports/ARCH-17-fleet-build-r2-20261003.md"
decisions:
  - text: Entry overrides select only that session's worktree directory, while entries without overrides use the fleet's mapped default.
    category: design
    why: The first invocation must not freeze future operator selections or change the durable project mapping.
  - text: Explicit join --replace NAME repairs a stale mapping while preserving its existing record and mapped paths.
    category: design
    why: Entry and join remain the sole fleet writers; a moved checkout can recover its external record without guessing a replacement or requiring manual JSON edits.
questions: []
challenges: []
---

All requested findings are addressed in implementation commit 772db9e:

- The fleet-present, unjoined record search walks only when the real cwd is inside
  the selected Git checkout, and also stops when a directory is its own parent.
  The regression probe runs outside GIT_WORK_TREE with a two-second bound, both
  with and without an outside record. It terminates, ignores the outside record,
  and resolves only the selected project's record. Normal nested discovery is
  also checked.
- Entry passes worktree-root overrides only to worktreeDirectory. The regression
  opens the first and second entries with different roots, then opens an entry
  without an override. Each uses the expected directory, and subsequent entries
  preserve the fleet bytes and mtime. The lifecycle test now asserts the fleet
  default and still checks symlinked HOME and override prefixes.
- Both console configurations merge fleet rows with configured projects that
  have not joined, retaining their explicit records and preferences. The test's
  scratch bch-cloak remains visible in the catalog and across refresh, without
  being joined or acquiring a checkout record. Later explicit adoption replaces
  its configured row without duplication. Console reads preserve fleet and
  record bytes.
- ORG_DIR now validates the fleet with readFleet and returns directly. A fake
  Git executable proves a record status command never launches Git; malformed
  fleet data still fails closed. projectFleet also reuses its fresh Git facts
  instead of performing a second identity lookup.
- Automatic join refuses a stale mapping with the same checkout basename and
  names the explicit repair command. join --replace retains the external record,
  worktrees, temp, layers, and fleet name while updating checkout and Git identity.
  Tests prove refusal for a live mapping, an unknown name, and a missing record;
  failed attempts leave fleet bytes unchanged. Repaired and ordinary repeated
  joins preserve bytes and mtime, and the record remains byte-identical.

The focused discovery run also exposed eligibility checks that occurred after
join had created a record. Entry now checks Git author/committer identity, HEAD,
and the canonical checkout's configured integration branch first. Existing
native-fallback and invalid-settings tests pass without leaving records behind.
The legacy nested-record test retains its absent-fleet assertion and now checks
the canonical binding after join, including an explicit nested ORG_DIR override.
Disposable discovery fixtures use isolated fleet homes so stale entries from
earlier deleted fixtures cannot affect later tests.

Final development verification:

```sh
node test/helpers/run.mjs test/fleet.test.mjs discovery/test/lifecycle.test.mjs discovery/test/review.test.mjs discovery/test/settings.test.mjs
```

52 passed, 0 failed, 0 skipped in 34.98 seconds. The five new tests were written
before implementation and all failed on the reviewed implementation; the eleven
existing fleet tests passed in that initial red run. Intermediate focused
failures and the final green output are retained under
docs/reports/evidence/ARCH-17-R167/. The final diff was reviewed against the brief
and review findings, and git diff --check passed before the implementation commit.

Per the brief, no baseline, npm test, test:promotion, test:lanes, full suite, or live
acceptance harness was run. Fixtures used owned scratch projects, records, and
fleet homes. No actual bch-cloak checkout or record was written, no shared Git
configuration or exclude file was edited, and no live pane or housekeeping
mutation was performed.

This report is checked with the canonical record CLI before its own commit.
The final requested node lanes/lane.mjs check follows that commit; its fast-tier
receipt is .lane/gate.json. Full merge validation remains the promotion step.
No further lane work follows that check.
