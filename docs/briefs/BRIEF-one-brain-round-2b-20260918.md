# Brief: round two b of "One brain" (ENG-21), the rules

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file, then `README.md`'s "Where things live" section,
then `supervisor/SETTLE.md` as it stands.

## What you are doing, in one paragraph

Settle sessions today follow a checklist that says the operator approves every
decision, names a model directly, and knows nothing about the goals. Rewrite
that checklist so a settle session takes what it may decide alone, and the
promotion policy, from the decision notes on the goal its item belongs to;
refers to routes only by name; runs tidy-tabs as its last step; and sets the
actor on every session it opens. Also stop `org sync` from ingesting a late
report on an abandoned run. The exact acceptance, including the checked-in
permission settings, is recorded on the item by the operator: read
`org show ENG-21` and treat its notes as the specification. Another lane
(round-two-visibility) is editing `brain/` capture and queue code and
`contrib/tidy-tabs.mjs` at the same time; do not touch those files.

## Where things are

- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-org/lane-round-two-rules`,
  branch `lane/round-two-rules`. Work only there.
- The checklist: `supervisor/SETTLE.md`. Its scripts: `supervisor/arm-watch.sh`, `continue.sh`.
- The watcher that opens settle sessions: `contrib/settle-watch.mjs` (already sets `ORG_ACTOR`
  at line ~302; keep that). brain's session opener: `brain/lib/start.mjs` (does not set it yet).
- The org core: `bin/org.mjs` (`sync` and `abandon` commands), `lib/state.mjs`, `lib/store.mjs`,
  tests under `test/`.
- The goal notes a settle session will read: `ORG_DIR=/Users/rewt/development/rewt/.org`, then
  `node bin/org.mjs show G-2`. Read-only for you. The three decision notes there (priorities,
  gates, promotion policy) are the text your checklist must teach a session to find and obey.
- Do not read or write under `/Users/rewt/development/bastian`, `~/Library`, or `~/.config`.

## The changes

1. **SETTLE.md reads the goal.** After orienting, the session finds the goal above its item
   (`org show <ID>` gives "within: G-n"), reads `org show G-n`, and takes from its decision
   notes: what it may decide alone, the send-back round cap, and the promotion policy. The
   sentence "The operator approves every decision for now" goes away. Where the checklist
   today names Claude Opus or any model, it names a route from `lane routes` instead
   (engineer, review, settle). Its last step runs
   `node contrib/tidy-tabs.mjs --cwd <checkout> --org <org> --ledger-dir <ledger>`.
2. **Promotion under the policy.** When the policy's five conditions hold, the session runs
   `lane promote` itself and records, in one `org note <ID> --decision`, which conditions it
   checked and how. When any condition fails, it asks, as today. Rule 4 means a lane that
   touches `supervisor/`, `.claude/` or `.lane.json` always asks. This lane does.
3. **Actor on every opened session.** `brain start` passes `ORG_ACTOR=<the agent name it
   chose>` into the session it opens, the way settle-watch does. Test it.
4. **No late ingest of abandoned runs.** `org sync` skips a report at an abandoned run's path
   and says so in its output; `org abandon` prints that a later report will not be ingested.
   A test covers both. (Today's behaviour re-created eight retired items at 13:45; see
   G-2's dropped children for the evidence.)
5. **Permission settings**, exactly as the operator's note on ENG-21 specifies (acceptance 6).
   Nothing beyond what that note says.

## Rules

`bin/` and `lib/` gain no dependency; nothing but the org CLI writes `events.jsonl`; no
push; no writes to any live organization; small commits, one per change, each with a test
where code changed. `npm test` and `npm --prefix console test` pass.

## The report

`docs/reports/one-brain-round-2b.md` in the worktree, committed on the branch, same front
matter as earlier rounds, then **Commits**, **Cutover** (expected: the operator's arm and
continue habits are unchanged; say if anything else), and a section **What a settle session
now reads**, listing the exact commands the new checklist tells it to run to find its gates.
