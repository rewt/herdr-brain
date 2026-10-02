---
run: R-96
outcome: done
summary: |
  Added a dependency-free foreground supervisor module and generic protocol, injected by discovery's explicit supervisor entry with a read-only cold start from the record.
  Final watch notices use settle; permitted corrections remain watched; promotion follows explicit supervisor judgment, the existing queue, and guarded record completion.
  Fresh, populated and restarted entry and the complete scripted cycle pass offline. The repository cold start is approximately 1290 tokens; no live release or bch-cloak switch was performed.
headline: Supervisor sessions now recover durable context and follow one report-to-promotion protocol
blockers: []
proposals:
  - role: planner
    title: Reconcile historical promoted runs and their missing record completion
    why: The record still shows R-70 and R-71 open although their checkouts are gone and promotion decision notes exist; 21 latest recorded reports also lack module settlement receipts. The project supervisor should recover report/disposition evidence and reconcile through the CLI without inferring acceptance from prose or changing history blindly.
learnings:
  - Entry and brief are read-only; an explicit event-sequence checkpoint records what the supervisor has read, with full history retrievable across midnight.
  - Missing checkouts retain their recorded runs through exact dispatch or settle Git common-directory receipts; missing legacy bindings are displayed as unknown rather than guessed from paths or names.
  - A report file alone does not prove the worker stopped; only a final watch notice or an explicit supervisor action enters settlement.
  - A promotable receipt proves readiness, while promotion authority remains an explicit supervisor judgment; acknowledged enqueue receipts survive lane closure and uncertain enqueue attempts require inspection.
artifacts:
  - "Commit: Add record-backed supervisor cold starts and notice protocol"
  - "Commit: Report supervisor module delivery for run R-96"
  - supervisor/supervisor.mjs
  - supervisor/context.mjs
  - supervisor/PROTOCOL.md
  - supervisor/README.md
  - supervisor/KICKOFF.md
  - discovery/policy.mjs
  - acceptance/supervisor.mjs
  - supervisor/test/supervisor.test.mjs
  - docs/reports/evidence/ENG-94-supervisor/cold-start.txt
  - docs/reports/evidence/ENG-94-supervisor/supervisor-cycle.json
  - "Validation: npm test before changes and after implementation; offline acceptance tests; standalone supervisor harness; record check this report; lane check after the report commit"
decisions:
  - text: Use a thin foreground module around the existing record, discovery, settle and promote implementations.
    category: design
    why: Discovery already establishes the supervisor role and the modules already own execution; the missing work is compact continuity, notice routing and durable mechanical receipts, not another scheduler or resident executive.
  - text: Route final report notices into settle and leave intermediate notices, substantive escalations and promotion authority to supervisor judgment.
    category: design
    why: Independent review belongs on the project review route; valid fix rounds are already dispatched by settle. A worker outcome or report-file existence cannot grant promotion or determine scope.
  - text: Complete promoted work through a current-run guard checked inside the record transaction.
    category: design
    why: A delayed promotion outcome must not close a newer run, unresolved or declined blocker, waiting outcome or concurrent work. Status remains derived from existing events.
  - text: Replace the handwritten kickoff with the generic protocol and retain only project purpose, source pointers and project scope.
    category: design
    why: Phases, routes, operator instructions, priorities and plans belong in durable record or configuration sources. The legacy launchers, contrib watcher and bch-cloak kit remain compatibility surfaces pending their existing migration gate.
questions: []
challenges:
  - Snapshot and today already provide much of orientation, but neither tracks settlement or queue receipts nor decisions since an explicit session checkpoint across midnight; the new module adds only that missing layer and protocol glue.
  - Automatically settling every watch notice would treat blocked or still-working workers as finished; only final reports enter settle, whose review is an independent judgment step and whose non-done outcomes remain substantive handoffs.
  - The live record cannot substantiate historical settlement solely from promoted decision prose; the cold start marks missing receipts and checkouts for inspection instead of declaring them awaiting a new review or silently hiding them.
  - One intermediate full test run and a targeted retry exposed the existing asynchronous total-Herdr-call-count race in settle/test/receipts.test.mjs; the final complete suite passed with that test unchanged. Test stability work is already tracked on ENG-88.
---

The module supplies `brief`, `checkpoint`, `handle` and `promote`. Discovery injects
the shared protocol and current compact brief only for explicit supervisor entry;
worker policy receives no supervisor commands. Mutations require an explicit
supervisor invocation in the canonical checkout. STOP and a torn event-log tail
refuse those mutations. No dependency, event type, stored item status, core model
call or background core process was added. Default housekeeping remains a separate
canonical-supervisor action.

The scripted acceptance case begins with no record or project configuration.
Entry bootstraps the record and pending routing question without a model or Herdr
call. A second entry recovers a running route and durable decision. Actual watch
delivers a report; settle's scripted independent reviewer finds incorrect content;
dispatch and watch carry the correction; the next settle returns PASS/readiness.
An explicit supervisor promotion judgment then invokes the real queue's validation,
fast-forward and lane closure. Handling its actual receipt completes the record,
and a restarted entry shows no running or unsettled work. Duplicate final notices,
enqueue commands and promotion outcomes repeat neither review nor promotion.

Additional cases cover decision recovery across midnight, operator priority and
opaque run metadata, read-only entry, overflow with complete JSON retrieval,
worker/canonical/STOP restrictions, intermediate notices, substantive blocked
handoffs, uncertain enqueue preservation, missing checkout identity and completion
guards for new runs and unresolved or declined blockers.

The captured repository brief at event sequence 1131 has **5160 characters,
approximately 1290 tokens** using the record's existing `ceil(characters / 4)`
estimate; this is not an exact model tokenizer count. It includes six record-open
runs (R-70, R-71, R-93 through R-96), one waiting operator question (HUM-19), no
operator priority ranks, 21 latest reports with unconfirmed module settlement,
126 decisions before any checkpoint and 13 advisory signals. Its running and
waiting IDs were compared with `record status --json`. The six-row previews retain
counts and pointers; JSON carries every row and unabridged decisions. R-70/R-71
are explicitly shown with missing checkouts. Historical settlement is uncertain,
not inferred from the promotion notes.

Validation:

- Baseline `npm test`: 508 passed, five explicitly skipped, zero failed.
- Final complete `npm test`: 515 passed, five explicitly skipped, zero failed.
- `node --test acceptance/test/*.test.mjs`: all 59 passed. The outer sandbox's
  local-socket/nested-sandbox refusals required running these offline scratch tests
  outside that outer sandbox; no live pane or model was used.
- Standalone `node acceptance/supervisor.mjs`: complete fresh/history/fix/promote/
  completion cycle passed; retained proof is in the evidence directory.
- `git diff --check` passed. The report is checked and committed separately;
  `node lanes/lane.mjs check` is the final operational command after that commit.

Live model behavior and actual operator chat clearing remain canary observations.
This run proves the requested scripted mechanical path, not a bch-cloak cutover.
The release, shared lane configuration, launchd, machine launchers, live panes and
`contrib/settle-watch.mjs` were not changed.
