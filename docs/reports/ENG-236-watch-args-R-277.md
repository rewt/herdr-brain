---
run: R-277
outcome: done
summary: |
  Watcher children now carry each frozen org, cwd and recipient once, replacing supplied values in place and appending only missing options. Discovery and adapter defaults still cross both process and pane boundaries. The required offline suite passed 75/75 with no surviving fixture, and the offline acceptance cycle passed 1/1 with its existing watcher receipt. The implementation is committed; this checked report and evidence precede the final focused lane check.
headline: Detached watchers keep their frozen arguments once and are reaped correctly
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 198213c727ccfac2115a6e89926c2e0d9093a228"
  - "Branch: lane/watch-args"
  - watch/watch.mjs
  - watch/test/args.test.mjs
  - docs/reports/ENG-236-watch-args-R-277.md
  - docs/reports/evidence/ENG-236-R277/focused-host.tap
  - docs/reports/evidence/ENG-236-R277/focused-sandbox.tap
  - docs/reports/evidence/ENG-236-R277/args.tap
  - docs/reports/evidence/ENG-236-R277/default-cycle.tap
  - ".lane/gate.json binds the final focused check to the report-inclusive commit"
decisions: []
questions: []
challenges: []
---

`watcherArgs` uses Node's parsed argument tokens to replace every supplied
`--org`, `--cwd` and `--to` with its resolved value at the first occurrence and
remove later occurrences. Missing options are appended before any positional
terminator. Other arguments retain their original spelling and order; only the
launch mode option is removed. The latest supplied value still wins, as in the
parent parser. Paths are resolved before the child changes cwd.

Six new tests verify supplied relative paths, repeated split/equals options,
and omitted bindings frozen from the caller cwd, ORG_DIR and adapter recipient.
They inspect both the generated pane command and the actual detached child's
argv. Unrelated options with values resembling launch flags stay intact. The
detached fixtures acknowledge initialization and then stop on an abandoned run;
receipt-based cleanup and the suite survivor audit remain enabled.

The command-receipt audit found real watcher receipts in
`dispatch/test/dispatch.test.mjs:77` and
`acceptance/test/default-cycle.test.mjs:88,155`. They all expect
`R-n --org X --to T --cwd R --log L`. Replacing bindings in place preserves that
order and removes the appended duplicate suffix, so no existing receipt or test
needed modification. The dispatch real-detached-watcher case passes and its
suite audit reports no surviving fixture. The acceptance cycle independently
asserts receipt registration, reaps the watcher, and waits for its owner to die.

Validation:

```
node test/helpers/run.mjs dispatch/test/dispatch.test.mjs watch/test/*.test.mjs test/one-watcher.test.mjs
node test/helpers/run.mjs watch/test/args.test.mjs
node test/helpers/run.mjs acceptance/test/default-cycle.test.mjs
```

The required suite's initial sandbox run reported 64 passes, seven EMFILE
filesystem-notification failures, one explicit filesystem-notification skip,
and no surviving fixture. Re-running the entire required suite with host
permissions passed all 75 cases with zero failures, skips, or survivors
(`focused-host.tap`). The isolated argv suite passed all six cases, and the
additional offline acceptance case passed with no surviving fixture.
`git diff --check` passed. No baseline, full project test/promotion/lane suite,
live acceptance harness, model call, or housekeeping loop was run.

This report is copied to the requested record path, checked with `record check`,
and committed with the evidence. The final command after that commit is run
with host permissions so the filesystem-notification checks can execute:

```
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs dispatch/test/dispatch.test.mjs watch/test/*.test.mjs test/one-watcher.test.mjs acceptance/test/default-cycle.test.mjs'
```

Its gate and content-checked log record the final result against the clean
report-inclusive commit. No subsequent lane mutation is planned.
