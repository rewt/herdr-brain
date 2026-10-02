---
run: R-61
outcome: done
summary: |
  Added Decided, Asked, Waiting on you and effective routes to the modern console, with a Control view and complete evidence readers. Existing answer flows use record answer; the new route editor reviews and saves through record routes set into the canonical project's .lane.json, preserving inherited routes and lifecycle configuration and rejecting stale reviews. Existing records now appear when opening an unconfigured project. Implementation is committed on lane/console-control and the report contains real-record and fixture screen evidence.
headline: The modern console now shows decisions and questions and lets you answer and change project routes.
blockers: []
proposals: []
learnings:
  - Project route layers replace individual routes rather than merging their fields; editing an inherited route must preserve its environment and argument arrays.
  - Structured report decisions and questions currently live in report.extra; the console projects those fields directly and deduplicates questions with existing record IDs.
  - Saving the first override in a project without routing config must materialize the portable preset or the other suggestions and selection policy disappear.
artifacts:
  - "Commit: Add modern console steering views and validated project route edits"
  - "Commit: Report modern console control plane and validation evidence"
  - lane/console-control
  - console/modern/model.mjs
  - console/modern/frame.mjs
  - console/modern/session.mjs
  - console/test/control-plane.test.mjs
  - lanes/routes-command.mjs
  - /tmp/eng85-evidence
  - "npm test after rebase: 413 passed, 2 skipped, 0 failed"
  - "Console control and modern regression tests after rebase: 52 passed"
  - "npm run test:lanes: 146 passed, 0 failed, 0 skipped"
decisions:
  - text: Keep the operator's existing modern console and add a Control view plus linked complete histories.
    category: design
    why: The overview gets immediate counts and the latest decision; existing sessions, goals, tasks, Activity, input and answer workflows remain reachable. The category-review flags newly landed on main remain visible in the overview, Waiting and Control.
  - text: Save routing through the record CLI into the canonical project's tracked configuration, leaving inherited config alone.
    category: design
    why: The CLI owns validation, locking, atomic replacement and stale-review detection. The console uses argument arrays and never writes configuration or events itself.
  - text: Show structured questions and decisions across the record's entire history, including automatic answers and run decision notes.
    category: design
    why: Daily Activity is a chronology, but durable steering facts must remain available after midnight or a context reset.
questions: []
challenges:
  - premise: Opening a project without a console catalog entry should hide its existing record until the user configures it.
    verdict: wrong
    evidence: The brief requires adoption without special user configuration. The modern catalog now discovers existing records through the same canonical and legacy lookup as the record CLI, without creating one merely by browsing.
---

## Delivered

`c` opens Control; `d` opens Decided; `f` opens Asked; `!` opens Waiting on you; `u` opens Routes. The overview shows the three counts, its latest recorded decision and route provenance. Decisions retain actor, timestamp, source item/run and complete reasoning, including structured decisions from ingested reports. Asked includes structured report questions; existing record IDs are deduplicated, while report-only questions remain readable evidence rather than invented answer targets. Asked retains recommendation, category, author and answer attribution; open record questions lead into the existing answer page.

Routes displays dispatch defaults, effective named routes, sources, primary pool, selection policy and always arguments. Enter edits kind/model/effort; Tab changes fields, Ctrl+U clears, Enter reviews, and a second Enter saves. Esc or Cancel cancels. Only `record routes set` writes `.lane.json`; its first edit adopts the full suggested preset, preserves project lifecycle keys and inherited route fields, refuses redirected targets and locks conflicting writers. The revision includes effective routing and project-file bytes, so a stale editor cannot overwrite a newer route/config edit. Model, kind and effort remain opaque strings.

The command intentionally ignores an inherited `LANE_CONFIG` launch override and reads the project's discovered layers. It writes only the canonical project's own `.lane.json`, ready to add and commit in Git. It never changes the shared ancestor config. Existing projects can browse a missing config without creating one; non-Git folders can inspect suggestions but cannot save project routes.

## Validation

- `npm test` before edits: an existing interactive launcher assertion timed out and the initial process later stalled; it was interrupted. The first post-change concurrent run had one watcher delivery timeout. Both unrelated files passed their isolated serial rerun (32/32). The complete serial application suite passed (404 passed, 2 skipped), then the final ordinary `npm test` passed (405 passed, 2 skipped, 0 failed, 407 total). The two skips are the existing dependency/native-sandbox checks. After rebasing onto category discernment, the final ordinary `npm test` passed again (413 passed, 2 skipped, 0 failed, 415 total).
- `node --test console/test/control-plane.test.mjs console/test/modern.test.mjs`: 52 passed after rebase. The new tests use actual child-process record commands in scratch Git projects: a human answer lands in events, a route lands in a commit of `.lane.json`, and defaults, inherited env/args, policy and lifecycle fields survive. They also check stale rejection, cancel/input ownership, canonical worktree targeting, symlink refusal, literal shell-looking model text, old/automatic/run decisions, structured ingested report fields, category flags from the new main and read-only `--print` even with confirmation keys.
- Layout and navigation are exercised at 80, 100 and 140 columns. Existing modern regression coverage still verifies session control/release, renaming, compose, scope isolation, exact-pane readers, Back/Forward, folded results and answer choices.
- `npm run test:lanes`: 146 passed, 0 failed, 0 skipped. Its existing synchronous review fixtures took about six minutes; the native-terminal option fixture also passed in isolation. The diagnostic run without PTY completed separately (145 passed, 1 explicit skip), but the final ordinary run includes the PTY test.
- `git diff --check` passes. Main advanced during validation; this lane is rebased onto the new main before its final gate.

Raw logs, configs, scratch record/config and the executable fixture harness are under `/tmp/eng85-evidence`. `setup.mjs` seeds an ordinary project and record via the CLI; `steer.mjs` uses the actual modern session and its default record/route adapters, with fake empty Herdr topology. Its receipt shows `answer=yes`, `answered_by=human`, and engineer changing from `gpt-6.1-sol/high` to the opaque test string `portable-model/xhigh`. No model is called.

## Screens

The overview and Control screens are actual `console/app.mjs --modern --print` outputs. The route review uses the same renderer in the CLI persistence harness. Record screens use this project's live record (`/Users/rewt/development/rewt/.org`) read-only; the source routes shown are the existing shared config, which remains untouched. Both record and fixture renders use an empty fake Herdr topology so the comparison isolates the durable control surface; the zero session counts do not claim that the live project has no sessions. No live pane was opened or changed. Empty tail rows are omitted below; all nonempty lines are retained. Raw files retain the full requested geometry.

The record was live during the run; decision counts reflect capture time. Initial fixture screens have one waiting question and one earlier answer; after steering the waiting answer is recorded as human and the route is a project override.

### Fixture before · 100×40

HERDR_BIN_PATH=/tmp/eng85-evidence/herdr ORG_NOW=2026-10-01T22:00:00Z node console/app.mjs --modern --config /tmp/eng85-evidence/fixture.json --print 100x40

```text
  Fresh project ▾             ‹  Project / Overview                                      r Refresh

  Fresh project                                                                            n Start

  Overview   Goals   Tasks   Activity   Needs you 1                               w Checkouts
──━━━━━━━━──────────────────────────────────────────────────────────────────────────────────────────
   0 sessions   0 working   0 blocked   0 idle   0 done
   quiet 5h19m · nothing working, nothing recorded since 17:00

   now · no work block · goals ›

   needs you · 1                                                                     open queue ›
    HUM-1     Publish the project?                                                         y / n

  No sessions here yet. Write below to start one.






















  ────────────────────────────────────────────────────────────────────────────────────────────────

  ────────────────────────────────────────────────────────────────────────────────────────────────
  › write a task or a message…  n                                                  task → no goal
 1-9 open session · click a name to rename · n write · p project · g goals…   Live · 0s ago
```

### Fixture overview after · 100×40

Same --print command, after implementation and before steering.

```text
  Fresh project ▾             ‹  Project / Overview                                      r Refresh

  Fresh project                                                                            n Start

  Overview   Goals   Tasks   Activity   Waiting 1   Control                       w Checkouts
──━━━━━━━━──────────────────────────────────────────────────────────────────────────────────────────
   0 sessions   0 working   0 blocked   0 idle   0 done
   quiet 5h31m · nothing working, nothing recorded since 17:00

   Decided 2   Asked 2   Waiting on you 1
   Last: Use the portable route defaults? → yes
   Routes · suggested defaults · confirmation pending · u open

   now · no work block · goals ›

   Waiting on you · 1                                                                open queue ›
    HUM-1     Publish the project?                                                         y / n

  No sessions here yet. Write below to start one.


















  ────────────────────────────────────────────────────────────────────────────────────────────────

  ────────────────────────────────────────────────────────────────────────────────────────────────
  › write a task or a message…  n                                                  task → no goal
 1-9 open session · click a name to rename · n write · p project · g goals…   Live · 0s ago
```

### Fixture Control before steering · 100×40

Same --print command with --keys c.

```text
  Fresh project ▾             ‹  Project / Control                                       r Refresh

  Fresh project                                                                          c Control

  Overview   Goals   Tasks   Activity   Waiting 1   Control                       w Checkouts
────────────────────────────────────────────────────━━━━━━━─────────────────────────────────────────
  Waiting on you · 1
  HUM-1            Publish the project?
  ! Open waiting queue ›

  Decided · 2
  HUM-2 · worker · 2026-10-01 22:00
    Use the portable route defaults? → yes
  G-1 · worker · 2026-10-01 22:00
    Agents own routine decisions.
  d All decisions ›

  Asked · 2
  HUM-2 · tooling · yes · worker
    Use the portable route defaults?
    recommended: yes · by worker
  HUM-1 · publish · Waiting on you
    Publish the project?
    recommended: yes · by worker
  f All questions ›

  Routes in effect
  Suggested defaults · confirmation pending. Saving an edit adopts them for this project.
  Default: codex · gpt-6.1-sol · high
  Primary pool: codex
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical changes
  engineer
    codex · gpt-6.1-sol · high · Default implementation
  u All routes / edit ›



 p scope  Tab pane  ↑↓ rows  ←→ views  Enter open  Esc back  n start          Live · 0s ago
```

### Live record before · 140×40

HERDR_BIN_PATH=/tmp/eng85-evidence/herdr node console/app.mjs --modern --config /tmp/eng85-evidence/record.json --print 140x40

```text
  herdr-brain ▾               ‹  Project / Overview                                                                              r Refresh

  herdr-brain                                                                                                                      n Start

  Overview   Goals   Tasks   Activity   Needs you 0                                                                       w Checkouts
──━━━━━━━━──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   0 sessions   0 working   0 blocked   0 idle   0 done

   now · no work block · goals ›

  No sessions here yet. Write below to start one.


























  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  › write a task or a message…  n                                                                                          task → no goal
 1-9 open session · click a name to rename · n write · p project · g goals · t tasks · ! needs                        Live · 0s ago
```

### Live record overview after · 140×40

Same --print command, after implementation.

```text
  herdr-brain ▾               ‹  Project / Overview                                                                              r Refresh

  herdr-brain                                                                                                                      n Start

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                                               w Checkouts
──━━━━━━━━──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   0 sessions   0 working   0 blocked   0 idle   0 done

   Decided 219   Asked 19   Waiting on you 0
   Last: Add entry.enabled, entry.mode and entry.policy to the existing project .lane.json; retain main as the integration branch declara…
   Routes · project configuration · u open

   now · no work block · goals ›

  No sessions here yet. Write below to start one.






















  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  › write a task or a message…  n                                                                                          task → no goal
 1-9 open session · click a name to rename · n write · p project · g goals · t tasks · ! needs                        Live · 0s ago
```

### Live record Control after · 140×40

Same --print command with --keys c.

```text
  herdr-brain ▾               ‹  Project / Control                                                                               r Refresh

  herdr-brain                                                                                                                    c Control

  Overview   Goals   Tasks   Activity   Waiting 0   Control                                                               w Checkouts
────────────────────────────────────────────────────━━━━━━━─────────────────────────────────────────────────────────────────────────────────
  Waiting on you · 0
  Nothing waiting on you.
  ! Open waiting queue ›

  Decided · 219
  R-58 · lane-entry-setting-390a4d-474cf5 · 2026-10-02 03:46
    Add entry.enabled, entry.mode and entry.policy to the existing project .lane.json; retain main as the integration branch declaration.
  R-58 · lane-entry-setting-390a4d-474cf5 · 2026-10-02 03:46
    Check project opt-out before Git execution configuration, record initialization, exclusions, worktree creation or stale-entry
    recovery.
  d All decisions ›

  Asked · 19
  HUM-18 · design · no · claude-herdr-brain
    Is there a specific tool you want this project's work to show up in soon (Linear, GitHub Issues, a Beads viewer)? If not, portability…
    recommended: no · by claude-herdr-brain
  R-26 · design · In report · no record question
    Is there a specific tool you want this project's work to show up in soon (Linear, GitHub Issues, a Beads viewer), or is portability a…
    recommended: A principle for now. Build the neutral export and the MCP server, and add a target only when someone needs one. · by lan…
  f All questions ›

  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /Users/rewt/development/rewt/.lane.json
  Default: codex · gpt-6.1-sol · high
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical, isolated changes: renames, doc sweeps, generated-file refreshes.
  engineer
    codex · gpt-6.1-sol · high · Default engineering lane: Sol at high effort.
  u All routes / edit ›



 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc back                                      Live · 0s ago
```

### Fixture route review · 100×24

The same renderer, captured by steer.mjs after typing the new model and effort; still before saving.

```text
  Fresh project ▾             ‹  Project / Routes                                        r Refresh

  Fresh project                                                              Enter reviews / saves

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────────────────────────────────────────────────────
  Review route change · engineer
  kind: codex → codex
  model: gpt-6.1-sol → portable-model
  effort: high → xhigh
  Save for Fresh project in /private/tmp/eng85-evidence/fixture/.lane.json
  This applies to future launches.
  Enter  Save route
  Cancel



 Tab / ↑↓ field · Ctrl+U clears · Enter reviews then saves · Esc cancels      Live · 0s ago
```

### Fixture Control after answering and saving · 100×40

HERDR_BIN_PATH=/tmp/eng85-evidence/herdr node console/app.mjs --modern --config /tmp/eng85-evidence/fixture.json --print 100x40 --keys c

```text
  Fresh project ▾             ‹  Project / Control                                       r Refresh

  Fresh project                                                                          c Control

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────━━━━━━━─────────────────────────────────────────
  Waiting on you · 0
  Nothing waiting on you.
  ! Open waiting queue ›

  Decided · 3
  HUM-1 · human · 2026-10-02 03:35
    Publish the project? → yes
  HUM-2 · worker · 2026-10-01 22:00
    Use the portable route defaults? → yes
  d All decisions ›

  Asked · 2
  HUM-2 · tooling · yes · worker
    Use the portable route defaults?
    recommended: yes · by worker
  HUM-1 · publish · yes · human
    Publish the project?
    recommended: yes · by worker
  f All questions ›

  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-evidence/fixture/.lane.json
  Default: codex · gpt-6.1-sol · high
  Primary pool: codex
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical changes
  engineer
    codex · portable-model · xhigh · Default implementation
  u All routes / edit ›



 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc…  Live · 0s ago
```

### The project with no console config · 100×40

HERDR_BIN_PATH=/tmp/eng85-evidence/herdr node console/app.mjs --modern --config /tmp/eng85-evidence/no-console-config.json --folder /tmp/eng85-evidence/fixture --print 100x40 --keys c

```text
  fixture ▾                   ‹  Project / Control                                       r Refresh

  fixture                                                                                c Control

  Overview   Goals   Tasks   Activity   Waiting 0   Control                       w Checkouts
────────────────────────────────────────────────────━━━━━━━─────────────────────────────────────────
  Waiting on you · 0
  Nothing waiting on you.
  ! Open waiting queue ›

  Decided · 3
  HUM-1 · human · 2026-10-02 03:35
    Publish the project? → yes
  HUM-2 · worker · 2026-10-01 22:00
    Use the portable route defaults? → yes
  d All decisions ›

  Asked · 2
  HUM-2 · tooling · yes · worker
    Use the portable route defaults?
    recommended: yes · by worker
  HUM-1 · publish · yes · human
    Publish the project?
    recommended: yes · by worker
  f All questions ›

  Routes in effect
  Project routes · Enter a route to change its kind, model or effort.
  Source: /private/tmp/eng85-evidence/fixture/.lane.json
  Default: codex · gpt-6.1-sol · high
  Primary pool: codex
  Route → kind · model · effort
  chore
    codex · gpt-5.6-terra · medium · Mechanical changes
  engineer
    codex · portable-model · xhigh · Default implementation
  u All routes / edit ›



 c Control · d Decided · f Asked · ! Waiting · u Routes · Enter opens · Esc…  Live · 0s ago
```

## Limits and boundaries

This is the first control-plane slice. Route creation, route removal, selection-policy/pool editing, priorities and desk configuration remain outside it. This run validates terminal rendering and real CLI persistence offline; it does not claim a physical Herdr operator trial. All writes were confined to this lane and scratch projects. No bch-cloak files/record/workspaces, shared `.lane.json`, installed release, launchd or user binaries were modified. `contrib/settle-watch.mjs` is unchanged; there is no push or publication.

The report is checked against R-61, committed separately, and `lane check` runs last on the final committed tree; its gate is `.lane/gate.json` and its output is retained at `/tmp/eng85-evidence/lane-check.log`.
