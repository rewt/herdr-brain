---
run: R-66
outcome: done
summary: |
  Fixed all three independent review findings: record-only selections cannot read or
  save another project's routes, optional model and effort fields retain their
  harness or dispatch defaults, and Decided retains every answer note through
  overrule and reopen with its original sequence, timestamp and attribution.
  Added regression tests and before/after print renders. The full offline suite and
  lane suite passed; implementation and report are committed on lane/console-control.
headline: Console route edits stay with their project and answer history survives changes.
blockers: []
proposals: []
learnings:
  - An org directory identifies a record but does not establish its project's working directory.
  - Partial named-route edits must preserve absent fields so future dispatch defaults still apply.
  - The answer CLI writes an answer note, metadata update and close in one batch; the note sequence is two before the close sequence.
artifacts:
  - 'Commit: Keep console routes scoped and preserve defaults and answer history'
  - 'Commit: Report console control review fixes and screen evidence'
  - lane/console-control
  - console/test/control-plane.test.mjs
  - console/lib/cli.mjs
  - console/modern/model.mjs
  - console/modern/session.mjs
  - console/modern/frame.mjs
  - lanes/routes-command.mjs
  - docs/reports/ENG-85-console-control-plane-r2-20261001.md
  - /tmp/eng85-r2-evidence
  - /tmp/eng85-r2-baseline.log
decisions:
  - text: Refuse route reads and writes when the selected project has no resolved directory.
    category: security
    why: The requested review fix closes accidental writes across project boundaries; a record path cannot authorize use of the console launch directory.
  - text: Send changed route fields through the CLI and preserve absent named-route fields.
    category: design
    why: Model-only and effort-only edits must retain harness defaults and continue inheriting future dispatch defaults.
  - text: Project every answer decision note by its own provenance and suppress only its corresponding current summary.
    category: design
    why: Overrule and reopen change current question state but must preserve the complete decision history; legacy summaries remain readable.
questions: []
challenges: []
---

## Review result

All three findings are accepted and fixed. No finding is disputed. Rebased onto main before editing,
including **Resolve background supervisor workspaces through native Git identity** and its report/review.
Main had no additional commits at implementation finalization.

Implementation commit: **Keep console routes scoped and preserve defaults and answer history**.
Report commit: **Report console control review fixes and screen evidence**.

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Project without cwd inherited the launch repository | Both route adapters require an explicit, absolute, existing project directory before spawning the CLI. The Routes screen explains the missing directory, advertises Read only, and cannot open an editor. | A real child console launched inside a different Git repository selects a separate org-only record. Reads and writes refuse, no foreign model appears, no editor opens, and both project config files remain unchanged. The write request uses the foreign repository's valid revision so stale-review rejection cannot mask the defect. |
| Empty optional route fields prevented edits | Model and effort may remain absent. The editor submits a partial patch, the adapter omits unspecified flags, and the validating CLI copies the named route without pinning resolved dispatch defaults. Clearing an existing explicit value still asks for a replacement; removal is outside this editor. | Real console-to-CLI model-only and effort-only edits persist, with the opposite optional key still absent on disk. A separate CLI test changes dispatch defaults afterward and confirms that omitted named-route fields still inherit them. Existing stale-review, inherited args/env, policy, lifecycle and canonical-worktree tests remain green. |
| Answer history disappeared after overrule/reopen | Every structured answer decision note enters Decided using its own seq/at/by and full text. Only the matching current answer summary is deduplicated. Legacy summaries remain when no corresponding note exists. The reader shows the question and full note once. | Actual CLI answer, overrule, reopen and re-answer produce counts 1, 2, 2 and 3. Every projected seq/at/by/text equals the original note. Older answers remain openable after reopen. Automatic answers retain the note writer's attribution and explicit automatic-answer text; Asked keeps its current auto attribution. A legacy fixture retains both an earlier note and unmatched current summary. |

## Validation

- Before changes: `npm test` passed, 417 passed / 2 skipped / 419 total.
- Final implementation: `npm test` passed, 422 passed / 2 skipped / 424 total.
  Skips are the existing opt-in native sandbox check and uninstalled interactive console dependencies.
- `npm run test:lanes` passed, all 146 tests, no skips.
- Focused control-plane suite passed all 12 tests. The new tests were also run against a scratch
  archive of the pre-fix implementation: 7 failures, including each reported regression and dispatch
  default pinning, demonstrate that the tests detect the prior behavior.
- `git diff --check` passed. Tests and renders used fake topology and scratch records/configuration;
  the real record was read only. All console mutations continue through child CLI argument arrays.

The first full validation attempt exposed an incorrectly configured automatic-answer test fixture
and three watcher timing failures under concurrent test load. The fixture now explicitly sets its
scratch approval policy. Only its stalled scratch watcher was stopped; watcher code was unchanged.
The subsequent full run and the final full run both passed. Logs are retained in the scratch evidence.

The report is checked with `ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs check
<report-path>` before its commit. The final action is `node lanes/lane.mjs check`, with its log at
`/tmp/eng85-r2-evidence/lane-check.log` and the gate at `.lane/gate.json`; the outcome of that last
check is returned directly rather than editing the committed report afterward.

## Before/after print renders

These are complete `--print 110x32` outputs. Each before/after pair uses the same fixture state;
only the console implementation differs. The fixture has a model-only engineer route, an effort-only
review route, and a question answered yes, overruled to no, then reopened. The org-only configuration
has a project name and org path but no directory, and the console is launched from the fixture Git
repository. Reads and print-mode confirmations do not write files.

Capture command shape:

`HERDR_BIN_PATH=/tmp/eng85-r2-evidence/herdr node console/app.mjs --modern --config
/tmp/eng85-r2-evidence/<config>.json --print 110x32 --keys '<keys>'`

`capture.mjs` records the three fixture screens. Before captures were made before source changes;
`capture-record-answer.mjs` renders the actual HUM-17 answer through the scratch pre-fix archive and
current implementation, computing the navigation keys from structured record facts. Both programs
and all raw frames are retained in `/tmp/eng85-r2-evidence`. Herdr topology is a fake empty listing;
no live pane is focused or changed.

### Record-only project · Routes · config unknown.json · keys u

Before: the selected name incorrectly labels the launch repository's editable routes.

```text
  Record-only project ▾       ‹  Project / Routes                                                  r Refresh

  Record-only project                                                                             Enter edit

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-r2-evidence/fixture/.lane.json
  Default: claude · harness default · harness default
  Route → kind · model · effort
  engineer
    opaque-harness · model-only · harness default
  review
    opaque-harness · harness default · effort-only

  Selection policy

  Edits save in /private/tmp/eng85-r2-evidence/fixture/.lane.json












 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

After: the directory must be supplied before routes can be inspected or edited.

```text
  Record-only project ▾       ‹  Project / Routes                                                  r Refresh

  Record-only project                                                                              Read only
  Connection issue · routes · r to retry
  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Routes in effect
  Routes unavailable: Project directory unknown. Open its folder to inspect or edit routes.























routes: Project directory unknown. Open its folder to inspect or edit routes.
```

### Optional effort · Route review · config fixture.json · keys u\n\n

Before: a legitimate model-only route cannot reach review.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                        Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Edit route · engineer
  Kind: opaque-harness▏
  Model: model-only
  Effort:

  Tab / ↑↓ field · Ctrl+U clears · Enter reviews
  Enter  Review change
  Cancel

















Kind, model and effort are required.
```

After: review preserves the harness effort default. Real model-only and effort-only writes are covered by the CLI persistence test.

```text
  Fresh project ▾             ‹  Project / Routes                                                  r Refresh

  Fresh project                                                                        Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Review route change · engineer
  kind: opaque-harness → opaque-harness
  model: model-only → model-only
  effort: (harness default) → (harness default)
  Save for Fresh project in /private/tmp/eng85-r2-evidence/fixture/.lane.json
  This applies to future launches.
  Enter  Save route
  Cancel

















 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then saves · Esc cancels                Live · 0s ago
```

### Reopened question · Decided · config fixture.json · keys d

Before: both recorded answers have vanished from Decided.

```text
  Fresh project ▾             ‹  Project / Decided                                                 r Refresh

  Fresh project                                                                                    Read only

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Decided · 1 recorded decisions
  G-1 · worker · 2026-10-01 23:00
    Agents own routine decisions.






















 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

After: both historical answers remain, newest first, with their original writers and times.

```text
  Fresh project ▾             ‹  Project / Decided                                                 r Refresh

  Fresh project                                                                                    Read only

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Decided · 3 recorded decisions
  HUM-1 · operator-two · 2026-10-01 23:02
    Publish the project? → Answered no (overruling yes): Changed direction
  HUM-1 · human · 2026-10-01 23:01
    Publish the project? → Answered yes: First answer
  G-1 · worker · 2026-10-01 23:00
    Agents own routine decisions.


















 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 0s ago
```

### Actual herdr-brain record · HUM-17 answer reader · config record.json

This existing answer has the same writer and time in its answer note and closing event. The fixed reader
uses the note itself and retains all its evidence. The complete fixture history above demonstrates the
overrule/reopen difference. Historical text below is evidence already in the record, not an action
performed by this run. Navigation key files are before-record-answer-keys.txt and after-record-answer-keys.txt.

Before:

```text
  herdr-brain ▾               ‹  Project / Decision                                                r Refresh

  herdr-brain                                                                                      Read only

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  HUM-17 · claude-herdr-brain
  2026-10-01T19:17:09.928Z
  Keep only security, funds-and-chain, publish and delete-data as ask, and set every other category to auto?
  → yes

  Answered yes: Decided by claude-herdr-brain on the operator's behalf; operator approved the review, chat
  2026-10-01: 'approve both, go ahead'. Applied with three changes to the original recommendation: auto =
  design (herdr-brain only), prover, tooling, goals; ask = security, funds-and-chain, publish, licensing,
  delete-data, priorities, other; design stays ask in bch-cloak because its AGENTS.md reserves library
  crypto, relations, frozen contracts and vector corpora (until ARCH-12 can separate them). Written to both
  records' config.json (backups config.json.bak-20261001-approvals). Only categorized questions are
  affected; 39 of bch-cloak's 66 answered questions and all 8 open ones have no category. Guard: a weekly
  glance at auto answers in the console's Decided list; a category the operator overrules goes back to ask.
  Open HUM-17 ›











 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 1s ago
```

After:

```text
  herdr-brain ▾               ‹  Project / Decision                                                r Refresh

  herdr-brain                                                                                      Read only

  Overview   Goals   Tasks   Activity   Waiting 1   Control                                 w Checkouts
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  HUM-17 · claude-herdr-brain
  2026-10-01T19:17:09.928Z
  Keep only security, funds-and-chain, publish and delete-data as ask, and set every other category to auto?

  Answered yes: Decided by claude-herdr-brain on the operator's behalf; operator approved the review, chat
  2026-10-01: 'approve both, go ahead'. Applied with three changes to the original recommendation: auto =
  design (herdr-brain only), prover, tooling, goals; ask = security, funds-and-chain, publish, licensing,
  delete-data, priorities, other; design stays ask in bch-cloak because its AGENTS.md reserves library
  crypto, relations, frozen contracts and vector corpora (until ARCH-12 can separate them). Written to both
  records' config.json (backups config.json.bak-20261001-approvals). Only categorized questions are
  affected; 39 of bch-cloak's 66 answered questions and all 8 open ones have no category. Guard: a weekly
  glance at auto answers in the console's Decided list; a category the operator overrules goes back to ask.
  Open HUM-17 ›












 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back        Live · 1s ago
```
