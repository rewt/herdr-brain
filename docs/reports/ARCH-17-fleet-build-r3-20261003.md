---
run: R-174
outcome: done
summary: |
  Fixed both round-two findings and the requested automatic-join behavior in implementation commit 745fd2e. Moved or re-cloned default-record projects can join independently while their old entries remain stale; explicit replacement remaps checkout-owned records or selects an existing restored record. Both console loaders retain example-configuration rejection with a fleet present. Five new regressions and the updated external-record regression failed before implementation; all 21 focused fleet tests now pass.
headline: Projects can rejoin the fleet after moving, and example console settings stay rejected.
blockers: []
proposals:
  - role: engineer
    title: Resolve the canonical checkout correctly for separate Git directories
    why: A scratch git clone --separate-git-dir fixture made gitProject identify the external Git directory as the canonical checkout, so join placed its native record there. fixture-before-correction-2.tap records the expected checkout versus actual Git-directory assertion. This existing discovery edge is outside the requested two-finding fix and needs its own regression and correction.
learnings:
  - Git identity is the canonical common-directory path; a normal re-clone at the same path retains that identity. Missing native records can be explicitly replaced with an existing restored record without changing identity.
  - A stale same-name entry is not ownership evidence. Automatic join leaves it unchanged and uses the entered checkout's Git identity, its own record, and an identity-suffixed fleet name.
  - Explicit replacement never initializes a missing record; the selected directory must already contain events.jsonl and cannot belong to another fleet project.
artifacts:
  - "commit 745fd2e: Fix fleet rejoin recovery and example config rejection"
  - "branch lane/fleet"
  - "lib/fleet.mjs"
  - "console/lib/config.mjs"
  - "test/fleet.test.mjs: five new regression tests and the updated external-record test"
  - "discovery/README.md: automatic join, explicit replacement, and example rejection contracts"
  - "docs/reports/evidence/ARCH-17-R174/regressions-red.tap: 15 passed, 6 failed before implementation"
  - "docs/reports/evidence/ARCH-17-R174/focused-green.tap: 21 passed, 0 failed"
  - "docs/reports/evidence/ARCH-17-R174/fixture-before-correction.tap"
  - "docs/reports/evidence/ARCH-17-R174/fixture-before-correction-2.tap"
  - "docs/reports/evidence/ARCH-17-R174/runner-sandbox-blocked.log"
  - "docs/reports/ARCH-17-fleet-build-r3-20261003.md"
decisions:
  - text: Automatic join registers a moved or re-cloned checkout independently and preserves the stale same-name entry unchanged.
    category: design
    why: A basename cannot prove that two Git identities own the same record; the new checkout's own record permits entry without guessing a replacement.
  - text: Explicit replacement remaps internal records by their checkout-relative path and allows an explicit existing record when the previous record is missing.
    category: design
    why: Entry and join remain the only fleet writers, and both moved native records and restored records after an in-place re-clone need a repair path without manual fleet edits.
questions: []
challenges: []
---

The round-two review at `docs/reviews/fleet/934f710-r2.md` is addressed in
`745fd2e`. Its committed contents were left unchanged.

Automatic join no longer searches for stale entries by checkout basename. The
moved and re-cloned regression cases use the same basename as the old checkout,
prove the old mapping remains byte-for-byte unchanged and visibly stale in the
console, and verify that the new mapping owns only the entered checkout's record.
A moved record retains its event bytes; a fresh clone gets its own initialized
record. Repeated joins preserve fleet bytes and mtime, and supervisor entry works
with the resulting mapping.

Explicit `join --replace NAME` carries an internal record to the same relative
path under the new checkout while retaining the fleet name, worktrees, temp,
and layers. The moved default-record test verifies missing-record refusal before
restoring its existing `.org`, successful repair, unchanged event bytes, and
idempotence. The ordinary in-place re-clone test restores the record to another
directory inside the checkout, verifies that the missing old `.org` is never
invented during replacement, and repairs the mapping with `--replace --record`.
It also proves another project's record cannot be selected. The updated
external-record test retains the live-mapping, unknown-name, missing-record,
record-ownership, event-preservation, and no-op checks.

Both `loadConfig` and `loadModernConfig` now reject the unedited exported
`EXAMPLE` when a fleet exists, with a `ConfigError` identifying the console file.
The regression verifies neither file is modified. Edited configurations continue
to merge joined and unjoined projects, as covered by the focused fleet tests.

Development verification used only:

```sh
node test/helpers/run.mjs test/fleet.test.mjs
```

The final pre-implementation run passed 15 and failed 6: all five new tests and
the updated external-record test failed on the reviewed implementation. The
post-fix run passed all 21 in 9.05 seconds. TAP evidence is committed under
`docs/reports/evidence/ARCH-17-R174/`, with trailing whitespace normalized.
The first runner attempt could not use `ps` inside the shell sandbox; the offline
runner was then authorized outside that sandbox to verify its owned processes.
Two exploratory separate-Git-directory fixtures exposed the existing discovery
edge recorded in proposals; the final re-clone regression uses an ordinary clone.

The final diff was reviewed against the brief, the review, and this fix-round
instruction. `git diff --cached --check` passed before the implementation commit.
No baseline, full suite, `npm test`, `test:promotion`, `test:lanes`, live acceptance
harness, live pane mutation, or housekeeping loop was run. Tests used isolated
scratch repositories, records, and fleet homes. The actual bch-cloak checkout and
record were not written.

This report is checked with the canonical record CLI before its own commit.
The requested final `node lanes/lane.mjs check` follows that commit; its result
is retained by the lane validator in `.lane/gate.json` and its validation log.
That command is the final work step. Merge validation remains the promotion step.
