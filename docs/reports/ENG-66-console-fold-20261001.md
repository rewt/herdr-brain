---
run: R-33
outcome: done
summary: |
  The modern console now carries the standalone items pane's useful missing ideas: a read-only Activity view for item creation, run starts, reports, decisions and closes, plus the recorded proposer and reason on item pages. The standalone pane and its private implementation are retired. Every former contrib file now has an explicit home or retirement: settle-watch remains for its live callers, tab housekeeping moved to supervisor, the dated pilot kit moved to docs/archive, and two superseded tools were removed.
headline: The modern console now shows why items exist and what happened to them
blockers: []
proposals: []
learnings:
  - "The modern console already had current typed items, linked sessions, direct question handling and a quiet-state warning; the missing item idea was chronology and provenance, not another work frame."
  - "The live herdr-brain record produced 138 useful lifecycle moments in the 36-hour Activity window without reading a supervisor transcript."
  - "Only settle-watch still belongs in contrib today; it has live supervisor callers and its later retirement is already ENG-64's concern."
artifacts:
  - "7240b3c Fold item activity into the modern console"
  - "console/modern/model.mjs, console/modern/frame.mjs, console/modern/session.mjs"
  - "console/test/modern.test.mjs"
  - "node console/app.mjs --modern --project herdr-brain --print 100x34 --keys a"
  - "npm test: 267 passed, 0 failed, 1 dependency-gated skip"
decisions:
  - decision: "Keep projects as scope and goals/work blocks as optional context; make typed items and their lifecycle the work shown inside that frame."
    why: "A project answers where work belongs, while the record's items answer what agents created and what needs attention. Replacing one with the other would discard useful context; making a human-maintained goal list authoritative would violate the operating model."
  - decision: "Carry lifecycle activity and item provenance into the modern console, but not transcript indexing, aliases, state filters or supervisor-message actions."
    why: "The modern console already shows current state, sessions and decisions from durable sources. The omitted features made chat text a second index of work or routed action indirectly through the supervisor, duplicating the record and Brain paths."
  - decision: "Reduce contrib to settle-watch and give every other file a named home or retirement."
    why: "contrib had become a mixture of live compatibility code, supervisor housekeeping, stale prototypes and historical evidence."
questions: []
challenges:
  - premise: "The items pane has ideas worth carrying over."
    verdict: partly
    evidence: "Activity chronology and recorded creation reasons were absent and now appear in the modern screen. Typed IDs, status, linked workers, reports/decisions and operator questions were already present, so their standalone versions were duplicates."
  - premise: "The operator wants items, not goals, as the frame."
    verdict: partly
    evidence: "The resulting screen uses projects as scope, items as the live work, and a declared goal/work block only as optional context. The fixture and live renders show item IDs and lifecycle events without asking the operator to maintain a parallel goal list."
  - premise: "contrib should exist."
    verdict: partly
    evidence: "It remains only for settle-watch, whose current supervisor callers require the stable path. Housekeeping has a supervisor home, pilot files are evidence, and the other scripts had been superseded."
  - premise: "The standalone pane must remain to preserve its operational features."
    verdict: wrong
    evidence: "The modern console already answers and opens sessions through its validated CLI/Brain paths. After adding chronology and provenance, removing console/items and its tests lost no unique durable operation."
---

## Result

There is one operator-facing item screen: the modern console. `a` opens **Activity**, a chronological view built from `record log --since 36h --json`. It includes:

- agent-created items, who or which run proposed them, their parent and their recorded reason;
- runs starting, with run/session/harness/model metadata;
- report headlines and proposal counts;
- decision notes, answers, closes, drops and abandoned runs.

Every line opens the durable item. The item page now repeats its origin and `Why:` before sessions and success criteria, so the reason is available after an event scrolls out of the 36-hour window.

The console still writes only through argument-array CLI calls. Activity adds one read through the existing `orgLog` wrapper; it never reads or appends `events.jsonl` itself.

## Screen evidence

These are plain-text frames from the console's own render path. The live record was read only.

### Before: split knowledge

Captured before the edit with:

```sh
node console/app.mjs --modern --project herdr-brain --print 100x34
node console/items.mjs --project herdr-brain --print 60x40
```

The modern screen had current work but no lifecycle entry point:

```text
Overview   Goals   Tasks   Needs you 0
0 sessions   0 working   0 blocked   0 idle   0 done
now · no work block · goals ›
```

The second screen separately held the useful chronology:

```text
SESSIONS · 2 live
  ENG-67  Watch module ... R-34 · started 15:25
  ENG-66  Fold the standalone items pane ... R-33 · started 15:25

activity · 55 new today
15:25 ▶ ENG-67 started ...
15:25 ▶ ENG-66 started ...
15:24 ◆ ENG-65 decided ...
```

### After: live herdr-brain record

Command:

```sh
node console/app.mjs --modern --project herdr-brain --print 100x34 --keys a
```

```text
Overview   Goals   Tasks   Activity   Needs you 0
─────────────────────────────━━━━━━━━──────────────────────────────────────────
Activity · 138 moments in the last 36 hours
15:29  ◆ ENG-67  decided   Watch module, started early ...
        “supervisor-herdr: promoted to main 529068d ...”
15:28  ✓ ENG-67  reported  Watch module, started early ...
        R-34
        “Blocked workers remain watched until they actually finish”
15:25  ▶ ENG-66  started   Fold the standalone items pane's ideas ...
        R-33 · codex · gpt-5.6-sol
```

The same live render at `80x24` kept all five central tabs readable and showed R-33 without horizontal overflow. Herdr topology was unavailable inside the sandbox during `--print`; the retained connection warning is unrelated to the record-backed Activity data and demonstrates that source failures remain distinct.

### After: deterministic fixture

The fixture uses the same `createModernSession().frame()` path as the application and supplies record/Herdr readers in memory, as `console/test/modern.test.mjs` does:

```text
Overview   Goals   Tasks   Activity   Needs you 0
─────────────────────────────━━━━━━━━──────────────────────────────────────────
Activity · 3 moments in the last 36 hours
09:20  ✓ ENG-2  reported  Build the missing adapter
        R-2
        “The adapter passes its contract.”
09:05  ▶ ENG-2  started   Build the missing adapter
        R-2 · worker · codex · gpt-fixture
09:00  + ENG-2  created   Build the missing adapter
        by R-1 · under G-1
        “The worker found the integration had no adapter.”
```

The test also opens ENG-2 and asserts that its page says `proposed by R-1` and `Why: The worker found the integration had no adapter.` Existing exact-cell checks continue to cover 80, 100 and 140 columns.

## What joined, and what did not

Kept:

- the recent event feed, reduced to durable lifecycle facts;
- an agent's recorded creation reason and provenance;
- direct item drill-down from every activity row.

Already in the modern console, so not reimplemented:

- typed item IDs and derived status;
- who is working each item and the exact live session;
- reports, recorded questions, decisions and closes;
- a quiet/no-session warning and source-specific failure states.

Left out deliberately:

- supervisor transcript indexing, plan-label aliases and “also in chat” tracking: conversation is ephemeral and should not become a competing work index;
- sending an answer or dispatch request as prose to the supervisor: the modern console already uses `record answer`, the Brain CLI and explicit task/chat actions;
- the standalone pane's duplicated state filters and narrow visual shell: Tasks, Needs you, Sessions and item detail already provide those current-state views in the chosen design.

## contrib verdicts

Every file that was under `contrib/` at the start has a verdict:

| File | Verdict | Reason |
| --- | --- | --- |
| `contrib/settle-watch.mjs` | Kept in place | `supervisor/continue.sh` and `supervisor/arm-watch.sh` still call it; ENG-64 owns its eventual retirement. |
| `contrib/tidy-tabs.mjs` | Moved to `supervisor/tidy-tabs.mjs` | It is supervisor housekeeping, is invoked by `supervisor/SETTLE.md`, and has no general contribution role. Tests and the prompt now use its owned path. |
| `contrib/console-pane.sh` | Retired | The tracked Herdr plugin and `herdr/console.sh` open the accepted modern console; the script was an older second launcher with no caller beyond its own test/docs. |
| `contrib/org-map.mjs` | Retired | Its stage/question model was already documented as stale, while `record today`, `record status` and the modern console provide the maintained projections. Nothing called it. |
| `contrib/bch-cloak-pilot-2026-09-16/README.md` | Moved to `docs/archive/bch-cloak-pilot-2026-09-16/README.md` | It describes a dated pilot snapshot, not executable product code. |
| `contrib/bch-cloak-pilot-2026-09-16/SETTLE.md` | Moved to `docs/archive/bch-cloak-pilot-2026-09-16/SETTLE.md` | It is the historical pilot prompt; the active prompt is `supervisor/SETTLE.md`. |
| `contrib/bch-cloak-pilot-2026-09-16/arm-watch.sh` | Moved to `docs/archive/bch-cloak-pilot-2026-09-16/arm-watch.sh` | It preserves exact pilot evidence with absolute historical paths and is explicitly marked non-active. |
| `contrib/bch-cloak-pilot-2026-09-16/continue.sh` | Moved to `docs/archive/bch-cloak-pilot-2026-09-16/continue.sh` | It preserves exact pilot evidence with absolute historical paths and is explicitly marked non-active. |

`contrib/` therefore contains only the one compatibility watcher still used today.

## Validation

- Baseline `npm test`: 286 passed, 0 failed, 1 skipped.
- Focused `node --test console/test/modern.test.mjs test/tidy-tabs.test.mjs`: 50 passed.
- Final `npm test`: 267 passed, 0 failed, 1 skipped. The lower total is the intentional removal of the retired standalone-pane and launcher tests.
- `git diff --check`: clean.
- Live `--print` frames: `100x34` and `80x24`, read-only against `/Users/rewt/development/rewt/.org`.
- Fixture frame: `100x30` through the modern console render path; automated frames remain cell-exact at `80x24`, `100x34` and `140x42`.
