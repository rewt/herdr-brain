---
run: R-30
outcome: done
summary: |
  The record-name review findings are fixed. Release snapshots now learn the prior state of each
  launcher independently, so an installation with an older before directory records that record
  was missing and restore removes it. Both installed command names point directly to bin/org.mjs,
  successful record/org workflows have end-to-end parity coverage, and the remaining generated
  "whole organization" wording now says "whole record." All release lifecycle tests used temporary
  directories; the live Herdr Monitor installation was not activated or restored.
headline: Record is now a reversible exact alias, including upgrades from older release snapshots.
blockers: []
proposals: []
learnings:
  - A release snapshot must be idempotent per managed launcher, not per snapshot directory, because later releases can add launcher names.
  - Two installed names should target the same implementation file directly; a copied relative-import wrapper is neither standalone nor an exact alias.
  - Parse-error parity is useful breadth, but one successful stateful workflow is needed to prove that an alias reaches the real store correctly.
artifacts:
  - herdr/release.sh and test/release.test.mjs (per-launcher snapshots and the legacy-before-directory restore regression)
  - package.json, bin/org.mjs, and README.md (record and org both target bin/org.mjs; symlink-only manual installation guidance)
  - test/name-alias.test.mjs (successful init, add, status, and show workflow parity)
  - lib/render.mjs (generated snapshot wording says whole record)
  - docs/reports/ENG-65-record-name-20261001.md (corrected implementation and restore account)
  - "npm test: 285 passed, 1 skipped, 0 failed"
  - "git diff --check: clean"
decisions:
  - decision: Remove the separate bin/record.mjs wrapper and install both record and org as aliases of bin/org.mjs.
    why: The wrapper's relative import only worked in its source tree, so copying it onto PATH created a broken command. Direct aliases make behavior structural and retain the unchanged internal implementation path.
  - decision: Extend an existing release before directory one launcher at a time.
    why: Older snapshots legitimately lack entries for launcher names introduced by later releases; saving each previously unseen launcher's state preserves exact restore without overwriting prior evidence.
questions: []
challenges:
  - premise: The copied record.mjs behavior only needed another test.
    verdict: wrong
    evidence: A relative-import wrapper cannot be a self-contained copied executable. Removing it and mapping both installed names directly to bin/org.mjs eliminates that unsupported intermediate artifact; README now explicitly instructs manual users to symlink rather than copy.
  - premise: An existing before directory is a complete release snapshot forever.
    verdict: wrong
    evidence: test/release.test.mjs constructs an older snapshot with org, lane, and plist but no record entry, then activates and restores entirely inside temporary directories. Activation adds record.missing and restore removes the new record link while restoring the prior launchers.
---

# Review findings

1. **Restore from an older snapshot:** `remember` now checks each managed launcher independently.
   If neither a saved target nor a missing marker exists, it records that launcher's current state.
   The regression test starts with a legacy-shaped `before` directory, activates a temporary
   release, restores it, and verifies that `record` is gone.
2. **R-27 report claim:** the earlier report now describes the fixed per-launcher restore behavior
   and the direct alias implementation. Its canary statement is true after this change, including
   for installations whose snapshot predates the `record` launcher.
3. **Successful alias coverage:** the alias test creates separate temporary records and runs
   `init`, `add`, `status --json`, and `show --json` through command links named `record` and `org`.
   It compares normalized command results and the resulting event logs.
4. **Generated wording:** worker briefs now call a snapshot the current state of the whole record.
5. **Copied-wrapper note:** `bin/record.mjs` was removed. Package and release command links both
   target `bin/org.mjs`, while manual installation documentation requires a symlink and warns
   against copying the implementation away from its sibling `lib` directory.

# Verification

`npm test` passed 285 tests, skipped one optional-dependency test, and failed none. Focused alias,
release, and flow tests also passed 20 of 20. `git diff --check` reported no errors. No activation or
restore command was run against `~/.local/share/herdr-monitor`; release lifecycle coverage used
test-created temporary directories only.
