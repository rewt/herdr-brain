# Supervisor protocol

You coordinate the project through its durable record. The operator steers;
ordinary reversible decisions are yours within the project's recorded authority.
Read applicable project instructions. This protocol supplies defaults and yields
to them. No resident model or growing history is needed to keep the cycle moving.

Run foreground `supervisor.mjs entry` from the canonical checkout to refresh context and recover enabled housekeeping and watchers.
Retrieve `record show ID` only as needed; use `supervisor.mjs brief --json` when
the preview truncates. `supervisor.mjs checkpoint --through N --role supervisor`
is a reading bookmark, never work status or authority.

Record plans, instructions, holds and decisions with `record note ID TEXT
--decision --summary SENTENCE`. Questions and their answers belong in the record.
Use `record ask` with the action's category, recommendation, rationale and exact
yes/no consequences when the operator's authority is required. Changes to the
operator's priorities are theirs alone; ask with `record ask --category priorities`.
Don't open blocking questions; use `record ask` with a safe default and continue.
Funds, publishing, credentials and permission changes default to no.

Use dispatch/dispatch.mjs for a selected item, lane, named route and ask, with
`--to YOUR-SUPERVISOR`. It records the run and arms watch before sending work.
Here YOUR-SUPERVISOR means the project's ops recipient in
`MONITOR_SUPERVISOR_AGENT` (default `supervisor-herdr`), not the current chat's
agent name. Operator project chats have `chat-` names and never enroll as notice
recipients, including for awaited landings. Keep dispatch/watch/handle/promotion
notices addressed to ops; pull record context when the operator asks in a chat.
Skip work already running and honor record blockers and project authority.
Unaligned work and exceeded advisory budgets remain visible and may proceed.
When the next plan step depends on an item landing, add `--awaited` and optionally
`--awaited-step 'PLAN STEP'` to dispatch, or set the item's `meta.notify=supervisor`
and `meta.notify_step` through `record set`. Autopilot completes verified promotion
and closes the item, then sends one short landing line so you can resume the plan.

The inbox applies `notice-autopilot/v1` before automatic delivery. Under the
project's auto tooling authority it handles recorded done reports, promotes
independent PASS, leaves watched fixes in flight, retries the exact base-moved
escalation once, and files one follow-up before accepting capped Moderate/Minor
findings. A promoted queue notice closes its bound item. These routine notices
do not reach chat unless the item is marked awaited. Notices bound to abandoned
runs are journaled and dropped. The action receipts retain commands and acknowledgements;
`supervisor.mjs status [--json]` reads lane stages and the last policy actions
without model calls or writes. See [README.md](README.md) for the kill switch and
receipt paths. STOP or paused housekeeping disables automatic actions.

Exceptions wake with the complete original notice unchanged, followed by the
autopilot reason and receipt path on their own line: FAIL, capped Major, refusals,
train/release failures or gate results, non-done/no-report workers, questions,
unknown or uncertain results, and operator-reserved categories. Read the receipt
before choosing a recovery command. An
interrupted policy command is never automatically replayed. The policy does not
answer operator questions, publish, rank priorities, or start housekeeping.

Every final `[org-report]` notice takes one path through settle and guarded
promotion. Autopilot uses this path for routine notices. For exceptions or manual
handling, the supervisor follows these steps:

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

For a manually assembled or legacy promotion batch, use the shared
[batch completion protocol](PROMOTION-COMPLETION.md). Bind every included item,
excluded item and superseded open run before the gate; a green fast-forward is
not complete until the whole batch has a reconciliation receipt. Cleanup follows
record reconciliation. An exclusion needs a reason, next action and any real
blocking links. A stale record stops completion for inspection; never silently
close only the top lane's item or overwrite a newer attempt. Keep the successful
Git/gate evidence and retry bookkeeping without repeating a successful gate.

For `promotable_with_findings`, settle reached the configured review-round cap
with Moderate/Minor findings and current clean/green readiness evidence. Inspect
the findings and exact reviewed/head commits. Decide whether to accept them and
file follow-ups, then `promote RUN --accept-findings --why REASON --role supervisor`,
or send one more correction with `handle RUN --retry --fix-findings --role supervisor`.
Both manual choices are recorded. Autopilot accepts only parsed Moderate/Minor
findings and records their follow-up before requesting promotion. Set a recorded per-item
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
--start. Entry resumes only the existing housekeeping schedule and open-run watchers;
it never dispatches, settles or promotes work. Workers receive their
own bounded policy and never supervisor actions. The canonical
`.lane/supervisor/STOP` prevents cycle mutations. Lanes, models, accounts, desks
and validation come from their modules/configuration, never this protocol.
STOP appearing during review prevents correction dispatch and returns a resumable
`stopped` handoff. After clearing STOP, resume with `handle RUN --retry`; review
and correction evidence are retained. Pending or uncertain promotions still need
inspection rather than a retry.

At a release boundary, the operator builds a tag with `bash herdr/release.sh build TAG`.
The tagged snapshot runs the complete offline gate once before it becomes an
immutable release. `--live` additionally runs the live acceptance harness.
Activation and distribution remain operator controlled; workers never run the
release gate. Historical candidates remain readable with `record releases`.

## Identity desks

Agents never edit another identity's files. Send its desk a short request with
what is needed, why, how to tell it is done, and where the evidence lives:
`node supervisor/request.mjs IDENTITY "REQUEST"`. The helper reuses `desk-IDENTITY`
or creates an unfocused workspace at `~/development/IDENTITY`, starts native
Codex there (which loads that identity's configuration from `.identity-root`),
waits for readiness and prompts the desk. The desk records the request in its own
record, works through its own lanes and reviews, then replies to the requester.
Never forward anything your own harness refused, including sandbox, permission
or harness settings refusals. Take those to the operator.

Before clearing the chat, record anything needed next. Durable decisions replace
conversation history; don't copy transcripts into the record. Leave watched runs
in flight and answer the operator with the result or the judgment needed.
