# Supervisor

The [Brain steward](../brain/README.md#model-free-steward-routing) routes fleet-wide
blocked worker captures through this same inbox and input gate. A blocked
supervisor escalates to the steward journal and a local operator alert, because
it cannot consume its own inbox. Aged pending notices and legacy parked outboxes
use the same alert channel. This observer starts no project schedule or model.

Project chats pull catch-up on demand with `record digest --since 2h` (default:
the last day), or `record digest --since 09:00 --width 48`. The view combines the
selected record's reports and decisions with durable promotion/watch facts from
`ORG/supervisor/inbox.log`. It never starts a model, reads a live pane, sends a
notice, initializes a record, or writes state. A done report alone does not mean
the lane landed. Missing journal evidence is stated; report checks without a
matching watch notice are `unknown`. Checks mean report validation, not review
or promotion validation. Journal promotion facts retain their reason and evidence
paths in JSON; they describe recorded producer outcomes, not a fresh Git check.

For a chat's next conversation, read `record digest --json`, keep its opaque
`cursor` in that chat's own state, then call `record digest --after CURSOR --json`.
Save the new cursor only after reading the result. Offsets include late and
same-timestamp appends in both logs. A cursor belongs to the canonical record
path, and rotated/truncated sources require a fresh `--since` read. Time windows
are inclusive and accept the same forms as `record log`; cursor windows begin
after the previous snapshots. Open operator questions and currently unresolved
blocked sessions appear regardless of window, until record/watch evidence
resolves or supersedes them. They are recorded evidence, not live session status.

Text defaults to 72 columns and eight entries per section, with explicit omitted
counts and bounded headlines. Decisions show their explicit summary or first
sentence; routine autopilot settlement and promotion authorization notes are
counted by action, leaving individual judgments visible. JSON retains full
decision text and any explicit summary. Record-sourced blocked sessions require
a current blocked or needs-human report, rather than dependency-only item status.
Watch prompt blocks show the recorded notice time in UTC, not a live claim.
`--width` accepts 32–240 columns and `--limit`
changes the text section cap. JSON always includes all facts and the next cursor;
read it before advancing past a truncated text view. The cursor is never written
to the record and grants no authority to act.

All automatic supervisor notices use `prompt-supervisor.mjs`, including watch's
intermediate/final notices, promotion outcomes, and settle/dispatch's correction
watchers. Before delivery, [autopilot.mjs](autopilot.mjs) applies the model-free
`notice-autopilot/v1` policy to notices bound to the canonical Git identity and
record. Routine notices complete without prompting or notifying the supervisor.
Policy processing at enqueue does not wait behind a busy chat or an older
exception; the existing delivery FIFO still orders exceptions. Restored inbox
workers recover pending policy through the same durable action receipts.

| Evidence | Policy action |
| --- | --- |
| Run-bound `[org-report]` done | Preflight the immutable report or worker file, then `supervisor handle RUN` for conditional intake and the project's review route |
| `promotable`, independent PASS | `promote RUN --why 'notice-autopilot/v1: PASS promotes …'` |
| `fix_round` | Leave the dispatched, watched correction in flight |
| Exact settle "base branch moved" escalation | One `handle RUN --retry` using the saved request, without `--to`; a second escalation wakes |
| Capped `promotable_with_findings`, parsed Moderate/Minor only | One engineer follow-up containing all findings, then `promote --accept-findings` with the follow-up and policy in its reason |
| `[promote-queue]` promoted | `handle --notice TEXT` closes the bound item; an awaited item then wakes with one landing line |
| Verified notice for an abandoned run | Journal and drop without waking or mutating the record |
| Anything else | Wake with a bounded one-line reason and the action receipt path |

FAIL, Major findings at the review cap, refusals, train failures, release gate
notices, non-done/no-report workers, questions, uncertain or interrupted results,
and unknown notices/results wake unless bound to an abandoned run. Settle retains responsibility for review
and correction dispatch: a FAIL or capped Major can already have dispatched a fix
when its result arrives; autopilot wakes with that evidence and does not promote.
Only fixed notice prefixes route actions. Headline and report narrative are never
commands. CLIs receive argument arrays; all record writes go through the record
CLI. Autopilot starts no project schedule and calls no supervisor model. The
independent reviewer still runs through the project's configured review route.

STOP, paused housekeeping (`enabled: false`), malformed configuration, and record
damage disable automatic actions. The project kill switch is a canonical
`.supervisor.json` containing `{"autopilot":{"enabled":false}}`; absence means
enabled. The schema accepts only `autopilot.enabled` as a boolean. Tooling must be
`auto` in the record's approvals config. Operator-reserved/human items,
publish/priorities categories, other categories routed to `ask`, report questions,
blockers, unclassified decisions and category warnings wake for judgment. No
operator question is answered, and no publish, priority or other reserved action
is executed by this policy. Authority, STOP and pause are re-read before each CLI
command; settle/promotion retain their existing lifecycle safety checks.
On the first done notice, the worker file at the record's report path must parse
and name that run, with the same outcome, question, blocker and category guards
as an immutable report. Autopilot does not ingest it: `handle` performs conditional
intake. Retry, follow-up and promotion require the immutable report afterward.

Mark an item the supervisor is waiting for with
`record set ENG-185 meta.notify=supervisor 'meta.notify_step=Cut RC-11'`, or add
`--awaited --awaited-step 'Cut RC-11'` to dispatch. The plan step is optional.
After verified promotion and recorded closure, the autopilot delivers
`[autopilot] ENG-185 landed; unblocks: Cut RC-11` through the normal input gate.
Unmarked landings stay silent. Notification receipts in `autopilot/landings/`
deduplicate by landed run across promotion and delayed report notices; the inbox
retains delivery/retry ownership. Clear the request with `meta.notify=none`.
The marker expresses supervisor intent and grants no promotion authority.

Action receipts live under `ORG/supervisor/REPOSITORY_KEY/autopilot/`. Report keys
remain per run so different delivery IDs cannot create duplicate follow-ups.
Promotion receipts use the producer's notice ID: `promote:JOB` and
`promote:JOB:complete` are separate receipts after an interruption. Legacy receipts
remain intact and uncertain commands still require inspection. Each command's
argv, intent and acknowledged result are retained. Runless promotion receipts
wake with an explicit missing-binding diagnostic; no item is inferred from a lane name.
Native command receipts also retain exit status, stderr and signal evidence.
The exact structured base-movement refusal can be acknowledged despite exit one
only when its run and journal match the retained project-bound settlement and
error. Every other nonzero exit wakes with its evidence and cannot authorize retry.
A lost reply or interrupted sequence wakes instead of replaying commands. The
inbox retains the complete original notice and records its handled/wake disposition
and receipt. Exceptions deliver the complete original notice unchanged for
foreground `handle`, followed by the autopilot reason and receipt on their own line.
Legacy/custom inbox entries without a project binding keep their delivery path.

For exceptions, the helper aligns with bch-cloak's `prompt-supervisor.sh` and
`box-empty.py`: append the notice to `inbox.log` first, read the input box twice
three seconds apart, then call `herdr agent prompt`. Both reads also require an
idle/done agent and the same live occupant. Busy or unreadable input raises a
non-focusing `herdr notification show` and waits. Nothing focuses or creates a
pane. Ordinary worker work prompts and operator-directed console input are
separate from automatic supervisor notices.

`SUPERVISOR_INPUT_WAIT_SECONDS` retains bch-cloak's name and default of 7200.
At the cap the notice stays pending with an acknowledged inbox worker that keeps
checking after watch, promotion or the foreground caller exits. The worker exits
when the inbox empties; it starts no project housekeeping schedule. The existing
canonical housekeeping tick and every sender also restart a dead inbox worker.
`SUPERVISOR_INPUT_CONFIRM_SECONDS` defaults to 3; offline fakes shorten it while
one test exercises the actual default. `SUPERVISOR_INPUT_POLL_SECONDS` defaults
to 10, matching bch-cloak's busy-input poll interval.

Harness parsing lives in [composer.mjs](composer.mjs), outside the record core.
Claude uses the last two horizontal rules of its footer, ignoring the prompt
glyph and dim/neutral grey placeholder text. Codex requires the complete shaded
box and its blank padding above the model/cwd status bar. Its first input row
contains the prompt; every continuation row counts, including rows starting with
`›`. Truncated boxes and unknown layouts stay busy.

Claude's rule-based parser shares a known limit with bch-cloak's reference: a
draft continuation row beginning with four `─` box-drawing characters can be
mistaken for a footer boundary. If the remaining draft is only `❯`, it is
stripped as the prompt glyph and the populated composer can be classified as
empty. The supervisor accepts this boundary-impersonation limit; the parser
retains the reference's last-two-rules behaviour.

The inbox is an append-only, fsynced JSONL transport journal at
`ORG/supervisor/inbox.log`, or `GIT_COMMON_DIR/supervisor/inbox.log` without a
record. Watch and promotion discover the same record; linked checkouts share
the journal. `--inbox FILE` selects another journal explicitly. This adds no
record events or stored item status. Enqueue and drain locks serialize writers
and prompts in FIFO order. Stable watch/promotion IDs adopt existing notices
on retries, including final watch notices after a process restart.

```sh
node supervisor/prompt-supervisor.mjs supervisor-herdr 'NOTICE' --org /record --id stable-notice-id
node supervisor/prompt-supervisor.mjs --org /record --drain
```

Every prompt ends with `notice-id=ID`. The journal records that same ID and
complete delivered text before the attempt and after its acknowledgement.
Delivery is at-least-once: a crash or lost acknowledgement replays that ID through
the input gate, so the supervisor can recognise a duplicate. Acknowledged notices
are not replayed, and newer notices wait for the oldest notice's acknowledgement.
The helper exits 0 for acknowledged delivery or a handled policy result, 3 when pending with an owner, and
1 for a journal or startup failure. Its JSON receipt includes `owner_pid` while
pending. Delivery that waited is logged in the journal and caller output; the
worker's diagnostic output goes to `inbox.log.worker.log`.

The final check reads agent status/identity first, then the composer immediately
before `herdr agent prompt`. Intent and wait logs are written before that final
read. Screen-based gating cannot prevent typing or occupant replacement in the
remaining read-to-input window. This is the same inherent race as bch-cloak's
reference; atomic input remains a separate Herdr capability.

Notice locks recover confirmed dead PIDs automatically, including a crash after
the prompt effect. Live or unidentified owners and torn journal tails still fail
closed for inspection; promotion locks retain their existing safety policy.
The legacy `--resolve ID --sent|--resend` remains available for old uncertain
entries, but delivery no longer requires manual resolution after a lost reply.
Do not reuse bch-cloak's existing plain-text inbox as this JSONL journal; select
a new file when switching and retain the old inbox as evidence.

For an existing project, use the activated release's
`supervisor/arm-watch.sh RUN --org RECORD --cwd PROJECT --to SUPERVISOR --detach --log LOG`.
The helper discovers from the caller's project when record/cwd are omitted;
pass the named recipient explicitly in a project wrapper. Set `PROJECT` to
the adopting checkout, `RECORD` to its record directory and `LOG` to the run's
watcher log path. bch-cloak uses `supervisor-opus` with `--idle-grace 900`;
its concrete bindings belong to the ENG-64 cutover rehearsal.
The journal belongs to that record, and the action receipts
use that project's canonical Git identity. Tooling must already be `auto` in
that record's approvals for routine autopilot actions; otherwise exceptions
wake the named supervisor with the policy reason.

bch-cloak owns its switch after a release ships this path. At a quiet point,
account for every pending `.lane/supervisor/outbox` message, retain the old
plain-text inbox/outbox and launcher settings for rollback, then stop
`com.rewt.bch-cloak.supervisor-events` before enabling the new dispatch wrapper.
Retire every `notify-watch.sh` caller and stop using its outbox for reports.
The watch and its durable inbox worker deliver without a separate notice daemon.
Do not replay old notices automatically into the new journal: verify each run's
recorded intake/settlement first. Verify a canary's record inbox, project binding,
policy receipt and named exception delivery before retiring the backup.
Rollback likewise requires draining the new journal and stopping its owned
senders before restoring and re-arming the old consumer, so both paths never
deliver together. [The scratch cutover](../acceptance/cutover.mjs) rehearses the
wrapper and notice contract; the compatibility `contrib/settle-watch.mjs` stays
until bch-cloak has completed its release-gated switch.

Discovery's explicit supervisor entry injects [PROTOCOL.md](PROTOCOL.md) and a
fresh cold start before the native harness launches. It works in unconfigured
projects and populated records, without a model or a background supervisor.
Workers receive only the existing worker policy. The native session hook performs
the recovery described below; policy-only entry stays read-only.

Operator project conversations use `monitor chat PROJECT` or the console's
**C** key ([chat command](../discovery/README.md#fleet)). One tab per canonical
fleet identity lives in the shared control workspace. The chat's registered
`chat-` name is separate from `MONITOR_SUPERVISOR_AGENT`, which names ops for
watch recovery, dispatch and cycle notices. Supply `--to OPS` for a project's
non-default recipient. Chats never enroll as notice recipients or receive
awaited landing messages. The launcher only reads project files and retains
its machine receipts in the fleet home, separate from native entry receipts.

Native `SessionStart` uses [session-start.mjs](session-start.mjs) for startup,
resume (including Herdr restore), clear and compact. Both installed launch adapters
bind an explicit supervisor role to the canonical checkout, Git common directory
and record. When `HERDR_PANE_ID` is present, opening the native supervisor also
writes that binding and its notice recipient atomically to
`.lane/supervisor/panes/<sha256-of-pane-id>.json` in the canonical checkout.
The hook matches this explicit launch receipt using the pane id and canonical
Git identity, then falls back to the adapter environment. Herdr preserves pane
ids across restore, so resume, clear and compact work after the launch variables
are lost, even when the native chat/session id changes. Record paths are retained
in the receipt; discovery in the restored environment cannot select another record.
This is a launch binding, separate from display-only session metadata.

This repository wires Claude's persistent hook in `.claude/settings.json` alongside
the canary hook. The Claude adapter reuses it when it covers all four sources,
avoiding a second entry from launch arguments. Codex receives its hook through
the supervisor adapter's `hooks.SessionStart` launch argument; workers receive none.
The repository must not track `.codex/hooks.json`: its interactive project-hook
trust dialog stops unattended workers before they receive their task. Projects
without a persistent native hook get the adapter hook for that launched process;
a direct native restore that loses launch arguments requires manual entry.
When a hook runs without adapter environment, it uses the durable pane receipt.
Outside Herdr, resume without a pane id or adapter bindings cannot recognize a supervisor.
Previously launched, unmarked panes need one explicit supervisor adapter launch
to create the receipt. An agent name or pane label never grants the role. Worker
roles and `MONITOR_ENTRY_BYPASS=1` take precedence over receipts; explicitly
opening a worker in a previously bound pane revokes its supervisor receipt.
Automatic adapters suppress entry in utility and headless passthrough children,
including children launched from a supervisor shell; they retain the interactive
pane's receipt for later resume.

Entry prints `supervisor.mjs brief`, resumes housekeeping only when both enabled
and resume are true, and re-arms watchers only for open, unabandoned runs without a recorded
report with a verified project checkout and a dead, reused or absent watcher owner.
Housekeeping and watcher liveness compare the PID and recorded kernel start-time
identity using the non-setuid process source. A different birth means the old
owner is gone. Unreadable identities and present legacy PIDs without a birth are
reported for inspection; they never authorize recovery. A missing legacy PID is
recoverable. Entry uses watch's exclusive per-run lock, then records the new PID
and `watcher_identity` through the record CLI.
Recovered watchers use the `to` field from the run's `dispatch_journal` receipt.
When that receipt is absent or its recipient is null, they fall back to the supervisor recipient
and then `supervisor-herdr`. Adapters export `MONITOR_SUPERVISOR_AGENT` from their
known agent identity, an explicit setting, or `HERDR_AGENT_NAME` when supplied;
the durable pane receipt retains it across restore. Invalid receipts print a
diagnostic instead of silently rerouting a notice. Unknown/deleted checkout bindings
and invalid PID evidence need inspection. STOP or a torn record permits reading
and lock inspection only. There are no model calls, promotion/settle/release
mutations, checkpoints, new loops or pane creation in entry.

The known promotion queue, supervisor receipt and settle lock locations are
scoped by Git common-directory identity. A confirmed dead owner is reported with
its path; entry never removes those locks. Live, inaccessible and unidentified
owners are not called stale. Each command is bounded and the recovery commands
share a 20-second deadline; failures print their reasons and do not reject session
startup. A later entry can finish interrupted recovery. Repeating successful entry
only refreshes the brief; it does not add record events or start duplicate owners.

Codex CLI 0.160.0 supports the native equivalent for all four sources, including
mid-turn compaction. Non-managed hooks require review through `/hooks`; new or
changed definitions are skipped until trusted. This change does not bypass that
trust. Older Codex builds without SessionStart, disabled/untrusted hooks, and
cloud orchestration without local command hooks cannot automatically run this
entry. Use the manual command below in those environments.
See [official Codex hook documentation](https://learn.chatgpt.com/docs/hooks) for
supported sources, project trust and surface limitations (checked 2026-10-03).

```sh
node /path/to/monitor/supervisor/supervisor.mjs entry --repo PROJECT --org RECORD --role supervisor --to YOUR-SUPERVISOR
```

`status` renders active lanes and the ten most recent landed lanes with run, item,
lane, stage (engineering, review, fix, train, landed), provider/model, start time
and elapsed time, followed by the last ten policy receipts and their actions.
[status.mjs](status.mjs) exports the same read-only JSON projection for a future
minimal console profile. Stage comes from the event fold, verified settle receipts
and promotion queue; Herdr's agent list and optional lane session receipts supply
display fields only. Provider/model metadata never authorizes work. A correction's
own settlement overrides the earlier fix ancestry; review displays the active
reviewer's provider, model and session timing. Elapsed time stops at integration
for landed lanes. Missing Herdr data or damaged receipts
produce warnings rather than fabricated live status. This path does not render a
cold start, inspect transcripts, run a model, or write record/checkpoint events.
Action receipts must have an actions array, valid action fields and valid start,
finish and action timestamps before they enter the table. Damaged rows are omitted
with a warning and the source files remain untouched.

From a project checkout, or with `--repo PROJECT --org RECORD`:

```sh
node /path/to/monitor/supervisor/supervisor.mjs brief
node /path/to/monitor/supervisor/supervisor.mjs brief --json
node /path/to/monitor/supervisor/supervisor.mjs status
node /path/to/monitor/supervisor/supervisor.mjs status --json
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

For a manual exception, after inspecting capped findings, explicitly choose
`promote RUN --accept-findings --why REASON --role supervisor` to record their
acceptance and enqueue the bound head, or
`handle RUN --retry --fix-findings --role supervisor` to dispatch another fix
without repeating the review. Repeated correction requests adopt the existing
receipt. Autopilot files one follow-up only for the parsed Moderate/Minor case
above; other follow-ups remain the supervisor's decision. Major/FAIL findings,
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
with `housekeeping/housekeeping.mjs --start`. Native session entry resumes it
when enabled and resume are true; generating policy or a brief stays read-only.
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

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Cold-start briefs show [host memory pressure and process usage](../docs/reference/memory-gate.md),
including the largest memory and CPU consumers, as read-only diagnostic evidence.

The cold-start brief also prints four storage advisory lines: the record,
release candidates/evidence, lane validation, and promote batches. Paths use the
project's canonical Git common directory, including when read from a lane.
`brief --json` exposes allocated and apparent bytes and measurement warnings.
Measurements deduplicate hardlinks, exclude symlink targets, and stop at 100,000
entries or one second per area; incomplete measurements are labeled as lower
bounds. Storage size never refuses work or changes record status.

A PASS review containing only scoped `Test evidence not re-executed` entries can
use the normal bound promotion path when the promotion test plan covers every
named file. Autopilot then queues and closes it through the existing verified
landing path. Reviewers still execute no commands and must report missing code,
incomplete acceptance and other uncertainty separately.

If the plan cannot cover those files, the supervisor may execute them in full
and record the evidence before `promote RUN --why REASON`. Run a clean lane check
with a direct `node --test FILE...` or `node test/helpers/run.mjs FILE...` command,
then add a decision note to that run with the exact text
`Test re-execution evidence: /absolute/GIT_COMMON_DIR/lane-validation/KEY.json`.
Promotion resolves only the saved test-only PASS escalation, verifies the green
receipt's exact lane head/tree, full-file command and immutable log hash, and
rechecks all normal record, clean-tree, STOP and replay guards. Missing, stale,
filtered, red or unrecorded evidence cannot discharge it. The resulting request
retains the run binding and closes through the usual autopilot landing path.
