# Supervisor

Discovery's explicit supervisor entry injects [PROTOCOL.md](PROTOCOL.md) and a
fresh cold start before the native harness launches. It works in unconfigured
projects and populated records, without a model or a background supervisor.
Workers receive only the existing worker policy. Entry starts no schedule and
makes no Herdr calls.

From a project checkout, or with `--repo PROJECT --org RECORD`:

```sh
node /path/to/monitor/supervisor/supervisor.mjs brief
node /path/to/monitor/supervisor/supervisor.mjs brief --json
node /path/to/monitor/supervisor/supervisor.mjs checkpoint --through 123 --role supervisor
node /path/to/monitor/supervisor/supervisor.mjs handle --notice 'COMPLETE WATCH NOTICE' --role supervisor
node /path/to/monitor/supervisor/supervisor.mjs promote R-123 --why 'Authority and readiness evidence' --to supervisor-project --role supervisor
node /path/to/monitor/supervisor/supervisor.mjs handle --notice 'COMPLETE PROMOTION NOTICE' --role supervisor
```

`brief` is read-only, including its reading checkpoint. It folds the same record
events as the CLI and adds pointers to settle and promotion receipts. It shows
operator priorities, runs and opaque routes/models/efforts, landed report files,
recorded reports awaiting settlement, fix rounds, promotion readiness and queue
acknowledgements, operator questions, held work, goals, decisions since the
checkpoint and suggested next actions. A file written by a running worker awaits
watch's final notice; its existence alone cannot authorize settlement.
Work belonging to another Git common-directory identity is excluded. Record-only
legacy runs and undispatched items have no repository binding and remain visible.
Missing checkouts retain their recorded runs using settle/dispatch identity
receipts. Without a receipt, the binding is explicitly unknown and needs
inspection; a missing directory never makes an open record run disappear.
Existing record advisory budget/stale/parallel/category signals are surfaced.

Text previews show six rows per section, full counts and retrieval pointers.
Titles and decision summaries are shortened; JSON has all rows and full decision
text, standing goal decisions and approvals. Structured report decisions join
the stream at their ingestion sequence, with run/item provenance, worker and
ingestion actors, category and rationale in JSON. Closing the item or removing
its lane does not remove those decisions; narrative is never mined for them.
The command prints characters and
an approximate token count (`ceil(characters/4)`, the record's existing estimate).
No tokenizer/model is called. `--since-seq N` retrieves decisions from any event
sequence, including across midnight; it does not use `today`'s date boundary.

After reading all new decisions (JSON when the preview is truncated), explicitly
checkpoint the printed sequence. The
bookmark lives under `ORG/supervisor/REPOSITORY_KEY/cursor.json`, keyed by canonical
Git common-directory identity. Concurrent checkpoints never move backward. A
crash before checkpointing repeats evidence instead of losing it. Checkpointing
does not retire plans or grant authority; store these with record decision notes,
and retrieve the relevant goal's standing authority when judging an action.

`handle` accepts a final `[org-report]` notice or an explicit run ID. It invokes
settle's foreground CLI once and returns its compact result. Project review/fix
routes and validation remain settle's responsibility. Manual runs may supply
`--brief FILE`; `--to NAME`, `--review-route`, `--fix-route`, `--review-round-cap`
and `--timeout` pass through. `--retry` and `--review-again` are explicit recovery choices after reading
settle's retained evidence. Intermediate watch notices return inspection advice
without launching settle. Report/notice strings never become commands or file
selection: the record supplies the run binding.
After promotion removes the lane, a late final report notice (or explicit run ID)
uses the acknowledged supervisor request and completed queue receipt instead of
opening the deleted checkout. It verifies the bound run/head and integrated tip,
then uses the same guarded record close as a queue notice. This can finish a
missed queue-notice handoff; duplicates write no new record events. Newer work or
blockers still require judgment.
An older run whose correction received promotion has no promotion request of its
own. If its checkout is gone and the record names a newer run, `handle` returns
`superseded` with that current run before invoking settle. This read-only result
claims no integration and closes nothing; completion still requires the current
run's bound promotion receipts and all the same guards.

Automatic settlement includes independent review judgment on the project review
route and settle's permitted fix dispatch. Non-done outcomes, blockers, incomplete
reviews, changed scope and other escalations remain supervisor judgments. There
is no automatic loop or resident executive model. A configured review-round cap
returns `promotable_with_findings` when only Moderate/Minor findings remain and
the full clean/green readiness gates pass. `handle` preserves its findings,
policy, reviewed source commit and head including the public review record, and
the cold start suggests `decide_findings`. Settle's [guide](../settle/README.md)
defines project defaults, recorded item overrides and round counting.

After inspecting capped findings, explicitly choose
`promote RUN --accept-findings --why REASON --role supervisor` to record their
acceptance and enqueue the bound head, or
`handle RUN --retry --fix-findings --role supervisor` to dispatch another fix
without repeating the review. Repeated correction requests adopt the existing
receipt. Follow-up items remain the supervisor's decision. Major/FAIL findings,
red validation and unresolved evidence keep their correction or handoff path.

`promote RUN --why REASON` is the supervisor's explicit authority judgment. It
requires an existing promotable settle receipt (including explicitly accepted
capped findings), rechecks readiness without a new
review, writes a record decision through argument arrays,
enqueues the exact settled head and authorized run through the promote CLI and
returns. The expected head includes the review-record commit; the receipt also
keeps the earlier reviewed source commit. The queue enforces both bindings under
the promotion lock, rechecks record readiness after validation while holding the
record lock across integration, and refuses a changed tip or required rebase.
The finite queue worker retains the lane clean/green/fast-forward checks. Its result
notice returns through `handle`: that command verifies the queue receipt and
integrated tip, then closes the item with `record close --if-current-run RUN`.
The record checks that precondition under its lock, including current done report,
newer runs, unresolved/declined blockers, open work and changed outcomes. Conditional
completion also refuses an item explicitly reopened after this report's prior
closure. It binds that closure to the report-ingestion sequence in the event log,
under the same record lock, including for older receipts. Duplicate queue and
final-report notices preserve the reopening and require supervisor judgment;
an unconditional close or a newer run's report can complete the work again. A failed
promotion stays an evidence handoff. No push, publication or release follows.

After a confirmed `refused` queue result and resolution of its cause, use
`promote RUN --retry --why REASON --role supervisor`. It rechecks saved settlement
and current readiness, binds a new queue job, and keeps all prior attempts and
refusal receipts. Late notices for prior attempts remain recognizable. Pending,
interrupted or uncertain attempts require inspection; they cannot be retried this
way. Repeating a successful promotion, including with `--retry`, returns the saved
acknowledgement even after lane closure.

Supervisor promotion receipts describe enqueue intent and acknowledgement, never
stored item status. Repeated commands return the same acknowledged request after
lane closure. An interrupted enqueue is deliberately uncertain: inspect the
supervisor receipt and `GIT_COMMON_DIR/promote/queue.json`, recover the existing
queue as its guide describes, and handle its actual result. If the acknowledgement
was lost, reconcile the exact queue job into the retained supervisor receipt only
after inspection; do not blindly re-enqueue a lane. Locks fail closed on crashes.

Mutation commands require explicit `--role supervisor` and a canonical checkout;
this is an invocation boundary, not a credential system. Workers are instructed
never to invoke them. STOP and a torn event-log tail refuse cycle mutations.
Only the canonical project supervisor starts default housekeeping, separately
with `housekeeping/housekeeping.mjs --start`. Cold entry never starts it.
Settle independently rechecks the canonical STOP immediately before correction
dispatch or incomplete-dispatch retry, including after a blocking review. It
returns `stopped` with a handoff and retains its resumable stage and review/fix
evidence. After STOP is cleared, `handle RUN --retry --role supervisor` resumes
without repeating review or an acknowledged correction launch.

Offline cases in `npm test` set their own actors, bound subprocesses and never
call a model or touch real panes. The release harness adds `supervisor-cycle`;
run it alone with `node acceptance/supervisor.mjs [CANDIDATE_DIRECTORY]`. It proves
fresh/history/restarted entry, a real watch notice, review finding, watched fix,
PASS, explicit supervisor promotion judgment, real queue gate/fast-forward/lane
close, guarded record completion and repeated original/correction final reports
after lane closure. Only Herdr/model
transport and reviewer work are scripted. This is mechanical acceptance; live
fresh-chat continuity remains a canary observation.

The generic protocol replaces this project's old handwritten kickoff. Its short
[KICKOFF.md](KICKOFF.md) retains project-specific purpose and workspace/release
boundaries. The old model-session launchers and [SETTLE.md](SETTLE.md) remain legacy
compatibility surfaces. `contrib/settle-watch.mjs` and bch-cloak's kit stay unchanged
until the release-gated switch. After that switch, the installed supervisor entry,
this protocol, settle and housekeeping cover the old session-start/SETTLE/work
pattern responsibilities; project authority/history belongs in record decisions,
validation in project config, machine paths/accounts in machine installation.
