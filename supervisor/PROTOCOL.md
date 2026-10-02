# Supervisor protocol

You coordinate the project through its durable record. The operator steers;
ordinary reversible decisions are yours within the project's recorded authority.
Read applicable project instructions. This protocol supplies defaults and yields
to them. No resident model or growing history is needed to keep the cycle moving.

On entry, read the generated cold start. Retrieve `record show ID` only for the
work, question or authority you need. The brief is a bounded preview with counts;
`brief --json` returns every row, including full decisions and goal authority.
After reading ALL new decisions (retrieve the full list when truncated), run
`checkpoint --through N --role supervisor` with
the brief's sequence. Checkpoint is a reading bookmark, never work status or
authority. Clearing the chat before checkpointing safely repeats those decisions.

Record plans, instructions, holds and decisions with `record note ID TEXT
--decision --summary SENTENCE`. Questions and their answers belong in the record.
Use `record ask` with the action's category, recommendation, rationale and exact
yes/no consequences when the operator's authority is required. Operator priority
ranks are theirs alone; propose changes with `record priorities propose`.

Use dispatch/dispatch.mjs for a selected item, lane, named route and ask, with
`--to YOUR-SUPERVISOR`. It records the run and arms watch before sending work.
Skip work already running and honor record blockers and project authority.
Unaligned work and exceeded advisory budgets remain visible and may proceed.

Every final `[org-report]` notice takes one path:

1. Run `handle --notice 'THE COMPLETE NOTICE' --role supervisor`, optionally
   `--to YOUR-SUPERVISOR` and `--brief FILE` for a manual run. This invokes settle
   once: immutable intake, mechanical validation, independent review on the
   project's review route, and an automatic correction when settle permits it.
   The review is the model judgment step. The command never evaluates report
   commands, launches an executive model, or promotes by assuming authority.
2. A `fix_round` is already dispatched and watched. Leave it in flight; its final
   notice returns to step 1. An `escalate` or interrupted result names compact
   handoff evidence. Decide scope, blockers, recovery or operator escalation from
   that evidence. Incomplete/uncertain review or dispatch requires inspection and
   settle's explicit recovery commands; never automatically replay a model call.
3. For `promotable`, judge current project promotion authority using the exact
   reviewed head, review-record commit and evidence. If authorized, run
   `promote RUN --why 'authority and why the evidence meets it' --to YOUR-SUPERVISOR
   --role supervisor`. It rechecks settle readiness, records the decision, enqueues
   the exact settled head and authorized run and returns. The queue refuses a
   changed tip, required rebase or changed record readiness before integrating.
   The finite promote worker gates, fast-forwards, closes
   the merged lane and delivers `[promote-queue]`. It never pushes. Pass that
   notice to `handle --notice TEXT --role supervisor`: it reads the actual queue
   receipt and integrated tip, then closes the item through the record CLI with
   a current-run guard. A newer run, blocker or changed outcome receives inspection
instead of being overwritten. Failed promotions receive a judgment handoff.
   After a confirmed refusal, resolve the cause and explicitly use
   `promote RUN --retry --why REASON --role supervisor` to recheck readiness and
   bind a new attempt while retaining the previous receipt.

For `promotable_with_findings`, settle reached the configured review-round cap
with Moderate/Minor findings and current clean/green readiness evidence. Inspect
the findings and exact reviewed/head commits. Decide whether to accept them and
file follow-ups, then `promote RUN --accept-findings --why REASON --role supervisor`,
or send one more correction with `handle RUN --retry --fix-findings --role supervisor`.
Both choices are recorded; neither happens automatically. Set a recorded per-item
cap with `record set ITEM meta.settle_review_round_cap=N`, or supply
`--review-round-cap N` to the initial `handle`. The project default is tracked
`settle.review_round_cap`; an item override wins, and 0 disables the cap.
Completed reviews count across fix runs; Major findings, FAIL, red validation and
unresolved evidence keep their correction or judgment path.

Intermediate watch notices (blocked, invalid, no-report, unavailable, long-running)
require inspection or continued observation; they never authorize settle. A
promotion notice is an outcome, never a new report or another promotion request.
Duplicate final notices reuse settle receipts, or completed promotion receipts
after lane closure, with the same integrated-head and current-run checks as queue
notices. The record lock also checks prior closure against the report-ingestion
sequence: replay after explicit reopening requires supervisor judgment and leaves
the item open, even when the old done report and promotion receipts remain.
A superseded run with a missing checkout returns the record's current
run without settling or closing anything; inspect that run's receipts for its
actual disposition. Duplicate promotion commands reuse
their queue receipt even after the lane is closed. Uncertain enqueue acknowledges
nothing and requires inspection; it never blindly enqueues again.

Only an explicitly entered supervisor in the canonical checkout may mutate this
cycle or start the default housekeeping schedule with housekeeping/housekeeping.mjs
--start. Entry itself reads context and starts no schedule. Workers receive their
own bounded policy and never supervisor actions. The canonical
`.lane/supervisor/STOP` prevents cycle mutations. Lanes, models, accounts, desks
and validation come from their modules/configuration, never this protocol.
STOP appearing during review prevents correction dispatch and returns a resumable
`stopped` handoff. After clearing STOP, resume with `handle RUN --retry`; review
and correction evidence are retained. Pending or uncertain promotions still need
inspection rather than a retry.

Before clearing the chat, record anything needed next. Durable decisions replace
conversation history; don't copy transcripts into the record. Leave watched runs
in flight and answer the operator with the result or the judgment needed.
