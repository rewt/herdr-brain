---
run: R-213
outcome: done
summary: |
  Explicit fleet replacement now repairs a moved checkout with its existing external record and consolidates an older empty automatic hash entry. Automatic entry encountering a missing same-directory checkout with an external record stops before creating a record and prints the exact repair command. Unknown names, live mappings and records, populated duplicate records, and overlapping checkout roots are refused. All 26 fleet tests pass; the implementation is committed and awaits review and promotion.
headline: Moved checkouts can recover their external records through fleet repair.
blockers: []
proposals: []
learnings:
  - Fleet entries store checkout paths but no remote metadata; repair suggestions use the checkout directory name and never establish ownership.
  - An older automatic hash entry can be consolidated only when its Git identity and checkout match and its default local record has an empty event log; the record files are preserved.
artifacts:
  - "commit 69bb6cb: fleet repair and regression tests"
  - "branch lane/fleet-repair"
  - "lib/fleet.mjs"
  - "test/fleet.test.mjs"
  - "docs/reports/ENG-138-fleet-repair-20261003.md"
  - "node test/helpers/run.mjs test/fleet.test.mjs: 26 passed, zero failed or skipped"
decisions: []
questions: []
challenges: []
---

Read the task brief, run context, item history, fleet design memo, fleet
implementation and CLI options. The CLI already accepts `--replace` together
with `--record`, so no CLI change or fleet field was needed.

On the original lane base, `ef661cfe8ea8d2e26ae48d15e53c20f1d75a7d8d`,
the new acceptance tests were run before modifying product code:

```sh
node test/helpers/run.mjs --test-name-pattern='^fleet repair:' test/fleet.test.mjs
```

All four selected tests failed: automatic entry did not stop for either a move
or a re-clone, explicit repair refused the pre-existing hash entry, and a nested
replacement checkout was accepted. The other 21 tests were excluded by the
pattern; no baseline or broad suite was run.

`lib/fleet.mjs` now suggests each plausible stale external-record mapping
without changing it, initializing a record, or binding it to the entered
checkout. Suggestions identify the stale root and include shell-quoted
`monitor fleet join --replace NAME --record PATH` commands. The move and
re-clone tests use names and paths containing spaces and apostrophes and execute
the printed command to prove it works. Repair retains the project name,
external record, worktree and temp mappings, and layers without creating a
local `.org`.

An explicit repair also removes an older automatic hash entry from the fleet
mapping when it refers to the same checkout and Git identity and has an empty
default local record. Its record files remain on disk. A populated event log
or an unrelated live mapping is refused. The tests verify that refusals leave
fleet and record bytes unchanged, and that multiple stale candidates produce
suggestions without choosing one. Checkout containment is checked before a
new join or replacement, so overlapping project roots are refused.

The final development validation was:

```sh
node test/helpers/run.mjs test/fleet.test.mjs
```

All 26 tests passed, with zero failures or skips, in 14.6 seconds.
`git diff --check` also passed. No dependencies, acceptance files, or test
helpers changed.

After checking and committing this report, the requested final action is:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/fleet.test.mjs'
```

The final check result will be retained in `.lane/gate.json` and the Git
validation store. This report does not preclaim that final gate result.
