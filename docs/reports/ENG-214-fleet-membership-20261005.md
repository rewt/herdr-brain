---
run: R-258
outcome: done
summary: |
  Preserved existing unjoined projects' record, parent settings and lane worktree discovery when another project creates the fleet. Reads and entry show an explicit adoption command and keep native behavior until adoption; joined neighbors' records remain isolated. Added persistent fleet exclude/include commands and quiet native passthrough for non-Git and excluded directories, covering both Codex and Claude. Focused offline checks pass, including the five native validation cases rerun outside the outer macOS sandbox.
headline: Existing projects retain discovery and excluded directories launch quietly.
blockers: []
proposals: []
learnings:
  - Compatibility discovery may retain an unclaimed legacy ancestor record, but never an ancestor record already assigned to a joined fleet project.
  - Fleet exclusions are stored as optional excluded_roots in version 1; include removes the named root, while other ancestor exclusions still apply.
  - All fleet fixtures isolate HERDR_MONITOR_FLEET in the process calling product code, including native entry and exclusion tests.
artifacts:
  - "commit d1a3931: Preserve existing fleet discovery and add explicit exclusions"
  - branch lane/fleet-membership
  - lib/fleet.mjs
  - lib/store.mjs
  - lanes/routes.mjs
  - lanes/lane.mjs
  - discovery/README.md
  - discovery/test/entry.test.mjs
  - test/fleet.test.mjs
  - docs/reports/evidence/ENG-214-R258-validation.txt
  - ".lane/gate.json: final lane check receipt"
decisions:
  - text: Preserve legacy discovery and print explicit adoption rather than auto-joining an existing unjoined layout.
    category: design
    why: Ancestor discovery alone cannot establish exclusive record ownership. Keeping reads and native entry working avoids silent layout changes; the printed join command names the existing record, worktree root and parent layer. A bare join refuses to discard an ancestor layout.
  - text: Excluded roots bypass Monitor entry and generated project sandboxes, while retaining joined mappings and records for later inclusion.
    category: security
    why: The ask explicitly requires native passthrough and persistent exclusions even after Git initialization. Checking both the entered path and canonical checkout also covers linked worktrees without deleting their mappings.
questions: []
challenges: []
---

The compatibility path preserves the pre-fleet record lookup and nearest parent
settings layer when the record is still unclaimed. Route merging and lane
worktree selection use that layout without registering membership. Both moved
and unmoved projects retain identical `lane config` output before and after a
different project joins. The printed shell-quoted adoption command is executed
in the tests, including a checkout name containing spaces and an apostrophe.
After adoption, linked worktrees resolve the mapped record and settings.
Symlinked records retain their discovery path; malformed parent settings still
fail in route readers without breaking record lookup.

`monitor fleet exclude PATH` and `monitor fleet include PATH` use the fleet lock
and atomic writer. Exclusions cover descendants, symlink aliases and future Git
repositories. Duplicate exclusions do not rewrite the registry. Inclusion of a
child does not override an excluded ancestor. Explicit join names the exclusion
that must be included first. Exclusion of an already joined canonical checkout
also covers its linked worktrees and preserves its stored mapping.

Explicit and interactive automatic Codex/Claude launches pass non-Git and
excluded directories through with exactly one calm Monitor line. Tests verify
unchanged native arguments, checkout and temporary directory, native exit code
propagation, no record/runtime creation, and no sandbox probes or duplicate
launches. The neighboring-project isolation and stale-mapping repair tests
continue to pass.

Validation evidence is summarized in `evidence/ENG-214-R258-validation.txt`.
The core focused run passed 53 tests with one explicitly optional native-boundary
probe skipped. A final compatibility selection passed four tests after the last
changes. The five-file integration run's five failures were all the outer
macOS sandbox refusing nested `sandbox-exec`; rerunning precisely those cases
outside the outer sandbox passed all five. Fixtures remained offline and used
scratch fleet state. No promotion/release suite, live acceptance harness,
housekeeping loop, activation or operator fleet mutation was performed.

After checking and committing this report, the final required operation is:

```sh
node lanes/lane.mjs check --cmd 'node --test test/fleet.test.mjs discovery/test/entry.test.mjs discovery/test/native-sandbox.test.mjs'
```

Its receipt covers the final committed tree, including this report. The lane
awaits supervisor review and promotion.
