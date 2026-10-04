---
run: R-207
outcome: done
summary: |
  Rebased lane/native-sandbox onto main at d3a636d, retaining ENG-135's async
  probe helper and load-aware timeout alongside native sandbox capability probes
  and short fleet-root fixtures. The only conflict was in
  discovery/test/helpers/probe-worker.cjs. Both offline acceptance cases covering
  that helper pass. No new implementation work or full suites were run.
headline: The native sandbox lane is rebased with both helper changes preserved
blockers: []
proposals: []
learnings:
  - "The probe-worker helper must stay async for main's dynamic deadline import; the native capability --help and --version exits belong before sandbox dispatch."
artifacts:
  - "Rebased implementation: 9b5387d, 91b758a, c2f8049 on lane/native-sandbox"
  - "Focused validation evidence commit: 7216802"
  - discovery/test/helpers/probe-worker.cjs
  - discovery/test/acceptance.test.mjs
  - test/helpers/offline-herdr.mjs
  - docs/reports/evidence/R-207/conflicted-helper.tap
  - docs/reports/ARCH-18-native-sandbox-rebase-20261004.md
decisions: []
questions: []
challenges: []
---

The seven existing lane commits replayed onto main. The single conflict combined
main's async exported function with this lane's early --help/--version return.
Main's loadTimeout(15000), the acceptance fixture's Promise handling, the native
sandbox implementation and the short resolved /tmp fleet paths remain intact.
The range-diff shows only that conflict adaptation and import-context changes;
the other lane patches retain their original content. Main is an ancestor of
the rebased lane, and git diff --check passed.

Focused validation:

```sh
node test/helpers/run.mjs discovery/test/acceptance.test.mjs
```

Result: two passes, zero failures or skips. Both Codex and Claude copied-product
tests exercise worker and routing changes, guards, validation and fast-forward
promotion with scripted native harnesses and disposable repositories. Tests are
offline and call no model. The approved host execution permits their macOS
sandbox-exec fixtures, which cannot nest inside the agent sandbox. Neither this
command nor the final fast-tier lane check acquires the host test slot; fixture
validation locks are confined to disposable project paths.

After record check and the report commit, the final action is:

```sh
node lanes/lane.mjs check --tier fast --cmd 'node test/helpers/run.mjs discovery/test/acceptance.test.mjs'
```

That command records the final clean commit and focused results in .lane/gate.json
and the shared Git lane-validation log. Full suites and release acceptance remain
with the promotion/release batch. No push, promotion or live pane mutation was
performed in this round.
