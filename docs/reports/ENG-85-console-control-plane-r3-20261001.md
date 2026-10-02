---
run: R-71
outcome: done
summary: |
  Fixed both round 2 findings. Confirming an unchanged configured route now closes
  without calling the write CLI, preserving omitted kind and ancestor inheritance.
  Suggested presets can still be adopted explicitly. The Routes screen, editor and
  review use the lane launch resolver for effective effort and arguments while
  retaining raw fields for partial writes. Added regression coverage and before/after
  print renders; the full offline and lane suites passed.
headline: Unchanged route saves preserve inheritance and the console shows the launch effort.
blockers: []
proposals: []
learnings:
  - Suggested preset adoption is the only intentional save without a changed route field.
  - resolveRoute returns declared metadata; resolveLaunchRoute also interprets legacy argument-encoded effort and adds always arguments.
artifacts:
  - 'Commit: Make unchanged route saves inert and show launch-resolved effort'
  - 'Commit: Report console route no-op and launch-resolution fixes'
  - lane/console-control
  - console/modern/routes.mjs
  - console/modern/session.mjs
  - console/modern/frame.mjs
  - console/test/control-plane.test.mjs
  - docs/reports/ENG-85-console-control-plane-r3-20261001.md
  - /tmp/eng85-r3-evidence
  - /tmp/eng85-r3-baseline.log
decisions:
  - text: Close an unchanged configured-route review without invoking the write CLI.
    category: design
    why: Equal displayed values must preserve dispatch-kind inheritance and leave ancestor routes in their source configuration; suggested preset adoption remains an explicit separate action.
  - text: Reuse lane launch resolution for effective effort and argument displays, keeping raw edit values for patch comparison.
    category: design
    why: Legacy route and dispatch arguments must display the same effort as a lane launch without becoming new stored overrides during another field edit.
questions: []
challenges: []
---

## Review result

Both Moderate findings are accepted and fixed. Rebased onto main before editing; Git reported
that this lane was already up to date. The review findings file remains outside the repository.

Implementation commit: **Make unchanged route saves inert and show launch-resolved effort**.
Report commit: **Report console route no-op and launch-resolution fixes**.

| Finding | Fix | Evidence |
| --- | --- | --- |
| Unchanged saves pinned inherited fields | A review with no changed raw fields performs no write unless it is adopting a suggested preset. Configured reviews say that closing writes nothing. | An omitted-kind route retains identical file bytes, inode and mtime, makes zero write-adapter calls, and follows a subsequent dispatch-kind change. An ancestor-only route makes zero calls, creates no missing project config, leaves an existing project config unchanged, and follows a subsequent ancestor model change. |
| Argument-encoded effort appeared as harness default | Defaults, named routes, editor previews and before/after review values resolve through `resolveLaunchRoute` from `lanes/routes.mjs`. Launch arguments are visible. The editor initializes its raw write baseline with `resolveRoute`; inferred effort never enters a patch unless explicitly changed. | Eight configuration cases cover Codex split and joined config arguments, Claude split and joined effort arguments, route and dispatch inheritance, an empty route args array suppressing dispatch args, and declared-effort precedence. The UI matches launch resolution in each case. Actual model-only CLI saves retain absent effort and original argument arrays; an explicit effort edit reviews xhigh → max and launches with max. |

No launch resolver or core record behavior was changed. The console still writes genuine edits only
through validating CLI argument arrays, including stale-revision checks and canonical project scope.

## Validation

- Final `npm test`: **426 passed, 0 failed, 2 skipped, 428 total**.
- `npm run test:lanes`: **146 passed, 0 failed, no skips**.
- Focused control-plane suite: **16 passed**. Against a scratch archive of the round 2 source, all
  four new tests fail and the existing 12 pass, proving that the tests detect the prior behavior.
- Suggested preset adoption is exercised through the actual CLI: the review writes nothing,
  confirmation materializes all 15 suggested routes, and an unchanged subsequent configured save
  makes no additional write call.
- Existing answer persistence, optional harness defaults, decision history, project isolation,
  stale review, canonical worktree, inherited lifecycle/args/env and print read-only checks pass.
- `git diff --check` passed. All mutation tests use scratch Git projects and records; topology is
  fake and no live panes, shared configuration, releases or foreign projects were changed.

The required pre-change `npm test` completed with two existing watcher timing failures
(unknown worker state and mismatched report; 420 passed / 2 failed / 2 skipped). No watcher code was
changed; the post-change full run passed both cases and every other test. The normal opt-in native
sandbox and uninstalled interactive-console dependency checks remain skipped.

The report is checked with `ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs check
<report-path>` and then committed. The last action is `node lanes/lane.mjs check`, with evidence in
`/tmp/eng85-r3-evidence/lane-check.log` and `.lane/gate.json`; its result is returned directly
without changing the report afterward.

## Before/after print renders

These are complete `--print 110x32` outputs. Fixture routing is unchanged between captures:
`dispatch.kind=codex`, a portable model, dispatch arguments encoding high, an engineer route
with no kind or effort and arguments encoding xhigh, and a review route inheriting dispatch arguments.
The actual herdr-brain record/configuration is read only. The fake Herdr executable returns empty
topology; print-mode write adapters stay disabled.

Capture command shape:

`HERDR_BIN_PATH=/tmp/eng85-r3-evidence/herdr node console/app.mjs --modern --config
/tmp/eng85-r3-evidence/<config>.json --print 110x32 --keys '<keys>'`

`setup.mjs`, `capture.mjs`, raw frames, regression logs and the pre-fix scratch source archive live
in `/tmp/eng85-r3-evidence`. Before captures use that archive's round 2 implementation; after
captures use the committed implementation. The regression tests establish actual persistence and
absence of writes; print renders establish the operator-visible behavior.

### Fixture routes · keys u

Before: Both argument-encoded efforts are incorrectly labeled harness default.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                                   Enter edit

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-r3-evidence/fixture/.lane.json
  Default: codex · portable-model · harness default
  Route → kind · model · effort
  engineer
    codex · portable-model · harness default
  review
    codex · portable-model · harness default

  Selection policy

  Edits save in /private/tmp/eng85-r3-evidence/fixture/.lane.json












 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

After: The default is high, engineer is xhigh, and review inherits high; the source arguments are visible.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                                   Enter edit

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-r3-evidence/fixture/.lane.json
  Default: codex · portable-model · high
  Default launch args: ["--config=model_reasoning_effort=high"]
  Route → kind · model · effort
  engineer
    codex · portable-model · xhigh
    Launch args: ["-c","model_reasoning_effort=xhigh"]
  review
    codex · portable-model · high
    Launch args: ["--config=model_reasoning_effort=high"]

  Selection policy

  Edits save in /private/tmp/eng85-r3-evidence/fixture/.lane.json









 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

### Fixture editor · keys u\n

Before: The absent raw effort is mistaken for a harness default.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                        Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Edit route · engineer
  Kind: codex▏
  Model: portable-model
  Effort: (harness default)

  Tab / ↑↓ field · Ctrl+U clears · Enter reviews
  Enter  Review change
  Cancel

















 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then saves · Esc cancels                Live · 0s ago
```

After: The editor shows xhigh from launch arguments, while its raw effort field remains absent for partial writes.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                     Enter reviews / confirms

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Edit route · engineer
  Kind: codex▏
  Model: portable-model
  Effort: xhigh (from launch arguments)
  Effective launch: codex · portable-model · xhigh
  Launch args: ["-c","model_reasoning_effort=xhigh"]

  Tab / ↑↓ field · Ctrl+U clears · Enter reviews
  Enter  Review change
  Cancel















 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then confirms · Esc cancels             Live · 0s ago
```

### Fixture unchanged review · keys u\n\n

Before: The review shows defaults and offers a save despite no field change.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                        Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Review route change · engineer
  kind: codex → codex
  model: portable-model → portable-model
  effort: (harness default) → (harness default)
  Save for Fresh project in /private/tmp/eng85-r3-evidence/fixture/.lane.json
  This applies to future launches.
  Enter  Save route
  Cancel

















 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then saves · Esc cancels                Live · 0s ago
```

After: The review shows xhigh → xhigh and offers to close without changing configuration.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                     Enter reviews / confirms

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Review route change · engineer
  kind: codex → codex
  model: portable-model → portable-model
  effort: xhigh → xhigh
  Launch args: ["-c","model_reasoning_effort=xhigh"]
  No changes. Closing this review writes nothing.
  Enter  Close without changes
  Cancel

















 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then confirms · Esc cancels             Live · 0s ago
```

### Fixture unchanged confirmation · keys u\n\n\n

Before: Print mode blocks the otherwise unintended write attempt.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                        Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Edit route · engineer
  Kind: codex▏
  Model: portable-model
  Effort: (harness default)

  Tab / ↑↓ field · Ctrl+U clears · Enter reviews
  Enter  Review change
  Cancel

















Route not saved: --print does not change routes
```

After: The editor closes with nothing written; no write adapter is invoked.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                                   Enter edit

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-r3-evidence/fixture/.lane.json
  Default: codex · portable-model · high
  Default launch args: ["--config=model_reasoning_effort=high"]
  Route → kind · model · effort
  engineer
    codex · portable-model · xhigh
    Launch args: ["-c","model_reasoning_effort=xhigh"]
  review
    codex · portable-model · high
    Launch args: ["--config=model_reasoning_effort=high"]

  Selection policy

  Edits save in /private/tmp/eng85-r3-evidence/fixture/.lane.json









No route changes; nothing written.
```

### Actual herdr-brain routes · keys u

Before: The configured route values remain readable.

```text
  herdr-brain ▾               ‹  Project / Routes                                                  r Refresh

  herdr-brain                                                                                     Enter edit

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /Users/rewt/development/rewt/.lane.json
  Default: codex · gpt-6.1-sol · high
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical, isolated changes: renames, doc sweeps, generated-file
    refreshes.
  engineer
    codex · gpt-6.1-sol · high · Default engineering lane: Sol at high effort.
  engineer-max
    codex · gpt-6.1-sol · max · Correctness-critical logic only.
  engineer-xhigh
    codex · gpt-6.1-sol · xhigh · Specific hard problems: cross-cutting features, tricky concurrency or
    protocol work.
  executive
    claude · opus · high · Act on operator answers and dispatch the next ready work. Judgment across the
    whole org.
  monitor
    codex · gpt-5.6-luna · low · One-shot read-only status from concise durable evidence; no repeated agent
    waits; exit after the answer.
  research
    claude · opus · high · Bounded evaluation or design research that needs the web and a hands-on trial in
    scratch; produces a recommendation and evidence, not product code.

 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

After: The same values remain readable alongside the launch resolver argument arrays.

```text
  herdr-brain ▾               ‹  Project / Routes                                                  r Refresh

  herdr-brain                                                                                     Enter edit

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /Users/rewt/development/rewt/.lane.json
  Default: codex · gpt-6.1-sol · high
  Default launch args: ["-p","claude-mem-rewt"]
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical, isolated changes: renames, doc sweeps, generated-file
    refreshes.
    Launch args: ["-p","claude-mem-rewt"]
  engineer
    codex · gpt-6.1-sol · high · Default engineering lane: Sol at high effort.
    Launch args: ["-p","claude-mem-rewt"]
  engineer-max
    codex · gpt-6.1-sol · max · Correctness-critical logic only.
    Launch args: ["-p","claude-mem-rewt"]
  engineer-xhigh
    codex · gpt-6.1-sol · xhigh · Specific hard problems: cross-cutting features, tricky concurrency or
    protocol work.
    Launch args: ["-p","claude-mem-rewt"]
  executive
    claude · opus · high · Act on operator answers and dispatch the next ready work. Judgment across the
    whole org.
    Launch args: ["--plugin-dir","/Users/rewt/development/claude-mem/adapters/claude-rewt"]

 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

