# Supervisor

## Weekly project cycle time

The supervisor runs this foreground report when publishing the weekly project
measurement. The plain command prints Markdown; `--json` prints the same data as
JSON. Only `--publish` writes files, using the summary publisher's shared lock and
atomic generation switch into the selected record's `published/` directory. It
creates a content-addressed Markdown and JSON pair and prints their paths on
stderr. Each publisher carries the other's latest pair forward, so summary
refreshes preserve cycle-time files. A new cycle-time publication replaces the
previous cycle-time pair in `published/`; readers can pin the resolved generation
to read a pair from one refresh. There is no scheduler, model call,
record event, validation, promotion or live pane mutation.

```sh
node supervisor/cycle-time.mjs --project CHECKOUT --org RECORD
node supervisor/cycle-time.mjs --project CHECKOUT --org RECORD --json
node supervisor/cycle-time.mjs --project CHECKOUT --org RECORD --publish
node supervisor/cycle-time.mjs --project CHECKOUT --org RECORD --since 2026-10-17T19:30:00-05:00 --until 2026-10-18T11:00:00-05:00
```

The default window is the last seven days ending now (or at `--until`). Bounds
are **lower inclusive, upper exclusive**. Selection uses integration time, so a
long-running item dispatched before the window is still included when it lands.
A reconciliation event can select a landing whose integration clock is missing;
its main clock stays null. Landings with neither clock are excluded and counted.
Git common-directory identity and the exact record path bind promotion receipts;
foreign receipts never contribute clocks. A torn record refuses the report.

Each landed item cycle starts at its first run after its previous landed run,
including correction runs. Train receipts and reconciliations both establish
that boundary, even when reconciliation arrives after the next dispatch. The
report/review/queue clocks describe the
landed run. Adjacent intervals, dispatch-to-main and dispatch-to-usable have
median, nearest-rank p90, sample and missing counts, both overall and separately
for historical autopilot cohort **in**, **out** and **unknown**. Scope eligibility
comes from bound autopilot receipts; current configuration does not reconstruct
historical membership or prove that autopilot performed a promotion. Median
averages the two middle values when the sample count is even.

The report joins `dispatch/metrics.mjs`, `promote/metrics.mjs`, settle receipts,
reconciliation events and retained `Fast path timing:` clocks. Dispatch waits,
promotion queue/slot/lock/preparation/gate time, retained gate failures and causes,
review rounds, base recaptures, exceptions and scoped hold notes remain named.
Shared gate costs are shown in full for each item and must not be summed across
items. Uninstrumented hold durations and overwritten history stay unknown.
Report availability is a retained timing snapshot or current report-file mtime,
an observation distinct from the ingestion event. Missing/reversed clocks and
intervals stay null and are counted; they are never replaced with zero.

Brain currently has no durable installed/usable clock. Reconciliation and release
cut/gate evidence do not prove usability. A project adapter may supply explicit
observations through `--usable FILE.json`, a JSON array of
`{"identity":"/canonical/git/common-dir","run":"R-1","item":"ENG-1","at":"2026-10-18T17:00:00Z","evidence":"adapter receipt path"}`.
Only exact identity/run/item matches with an evidence reference and a clock at
or after main contribute. This file is measurement input, never authority to
install, release or promote.

## Slot handoffs and safe-point observations

```sh
node bin/org.mjs handoffs template > /tmp/handoff.md
# Fill in the draft, then record a fresh immutable copy:
node bin/org.mjs handoffs check --file /tmp/handoff.md
ORG_ACTOR=supervisor-name node bin/org.mjs handoffs write --workspace w34E --slot supervisor --file /tmp/handoff.md
node bin/org.mjs handoffs latest --workspace w34E --slot supervisor --json
node supervisor/supervisor.mjs brief --repo CHECKOUT --org RECORD --workspace w34E
node supervisor/supervisor.mjs safe-point --repo CHECKOUT --org RECORD --pane w34E:p1 --json
```

Workspace and slot are explicit single identifiers, not checkout paths. `ORG_DIR`
selects the record as usual. Each write stores the draft's exact bytes at
`ORG/handoffs/WORKSPACE/SLOT/UTC-TIMESTAMP.md` and appends one `handoff.recorded`
event with its relative path, SHA-256, workspace, slot and author (`ORG_ACTOR`,
otherwise the usual record writer). Files are created exclusively, read-only,
and synced before the event. A repeated write, collision or backward clock uses
a new timestamp; old copies and crash-left unrecorded files are never replaced.
Readers select by record order, ignore unrecorded files, and refuse missing,
changed, redirected or nonregular recorded files. No latest pointer or status
is stored; older folds ignore the new event. This is separate from the existing
`record handoff R-old --to R-new` retained-run command.

The template/check covers in-flight work, background jobs with re-arm commands,
decisions not yet recorded, peers and addresses, and first steps. The check
recognizes the template's Markdown headings, case-insensitively, outside fenced
examples. Missing headings are advisory and never prevent writing or reading.
The brief includes one verified line for each workspace's latest `supervisor`
slot handoff; `--workspace` selects one workspace. A damaged latest handoff is
recovery evidence, with no silent fallback to an older file. Brief generation
does not create handoffs or advance a reading cursor.

`safe-point` is a foreground read-only observation, returning exit 0 for SAFE
and 1 for HOLD or uncertainty. It uses pane/agent reads and the complete OS
process source to find live descendants below the foreground harness root,
including background jobs and grandchildren. It excludes only the checker’s
own process ancestry and observation helpers, keeping sibling jobs visible. It uses no provider or
harness allowlist: an opaque nested harness child is conservatively reported
for inspection too. An ambiguous/missing root or unavailable process source
reports uncertainty. The pane's named agent binding is checked again at the end.

Any present record lock holds, including one whose owner is unknown or stale;
the check never acquires or recovers it. It reads the existing
`ORG/supervisor/inbox.log` without its locks and reports pending/uncertain
notices addressed to the observed agent name. `sent` is Herdr's delivery
acknowledgement; it does not prove model consumption. `handled` has an existing
model-free disposition. Neither is reported as undelivered. Unreadable or torn
notice evidence holds. Notice formats and transport behavior are unchanged.
SAFE is a point-in-time observation, not permission or a reset controller:
the command never clears, closes, renames, prompts or re-arms anything.

## Read-only lanes view

```sh
node supervisor/retire.mjs status --repo CHECKOUT --org RECORD
node supervisor/retire.mjs status --repo CHECKOUT --org RECORD --json
node supervisor/retire.mjs status --repo CHECKOUT --org RECORD --out LANES-TODAY.md
node supervisor/retire.mjs status --repo CHECKOUT --org RECORD --source project=/absolute/rows.mjs
```

`status` observes through `createRetirement().observe()` and uses the same
`planRetirement()` as apply. It never applies a plan, closes a tab or workspace,
removes a lane, records a callback, consumes a request or writes the record.
Git reads disable optional index refresh locks. The only output-file write is
`--out`: a temporary file beside the destination, published by rename. Its parent
directory must already exist. The supervisor's existing daily routine can run
this command for its daily list; the command starts no daemon or schedule.

There is one row for every observed tab and each of its panes. Pane rows show
the enclosing tab's planner decision because closing a tab affects all its
panes. Workspace, tab, pane, agent kind/status, matched run, item and lane sit
beside the class, reason and next action. Run identity uses the shared
`matchingRun`, including workspace, cwd and recorded terminal/native session;
a matching pane id alone is insufficient. Classes are derived display labels,
never stored status or permission to close.

| Planner result / view fact | Class | Next action |
| --- | --- | --- |
| Release | TERMINAL | Terminal; retire through the guarded executor |
| Working/blocked occupant, un-ingested report or known live reference | ACTIVE | Names the worker, report, resource owner or job being awaited |
| Open chain with this item's latest run or latest review | WAITING | Names the fix owner, reviewer, supervisor, or operator for an open human question |
| Older idle/done run in an open chain | IDLE-NONTERMINAL | Release candidate; supervisor/Astra decision via `record pane-release` (ENG-369) |
| Unknown identity/process/topology, unreadable evidence, or an unmapped reason | UNKNOWN | Keep, with the concrete reason |
| Standard slot, persistent/operator/lab workspace, or focus | PROTECTED | Keep |

The **Held** column is separate from the underlying class. When a hold exists,
the view also plans an in-memory copy with `retirementHold` omitted solely to
explain what is underneath. That copy never reaches an executor, and the real
hold and all containments remain in force. Counts count classified rows (both
tabs and panes, plus promotion/diagnostic rows), not unique sessions.

Worktree inventory rows include every worktree registered to the canonical Git
common directory, even with zero panes: branch, short head, containment in
`main`, clean/dirty, `archive/lane/TOPIC` tag and whether it matches HEAD,
untracked/ignored file counts, and pane count. These facts do not classify a
worktree as releasable: lane removal still requires its own fresh guarded plan,
terminal-chain disposition and preservation checks. An inventory read failure
appears as UNKNOWN. Releasing a pane never implies deleting its worktree.

The built-in [board source](../board/brain.mjs) shows active Brain promotion
queue rows, using the already observed record. Repeat `--source NAME=SCRIPT`
for a project's read-only `board-rows/v1` adapter; these scripts run through
[board/source.mjs](../board/source.mjs), with the board's environment, timeout,
size limit and row validation. Source rows are presentation only and never
change retirement decisions. Completed/failed/interrupted promotions are omitted;
source failures remain visible as UNKNOWN. Scripts run from the canonical
checkout with the selected `--org` in `ORG_DIR`; relative script paths resolve
against `--repo`.

Projects with an external dispatcher must call
[`dispatch/record-worker.mjs`](../dispatch/README.md#external-dispatchers) after
launch, recording the worker workspace and terminal/native session identity.
Otherwise a live worker remains UNKNOWN. The view names missing
`worker_workspace`, `terminal_id` and `agent_session_id` fields on the newest
candidate run, together with the launcher correction. Background-process keeps
list extra kernel process names only, with no argv; the view does not relax
those keeps. The operator line points to `record today` for reserved decisions;
neither item titles nor a `needs_human` outcome decide operator authority.

## Safe retirement

`node supervisor/retire.mjs plan --repo CHECKOUT --org RECORD` is a read-only
adoption preview, including keep reasons and expired-reference diagnostics.
`apply` observes again before each close and acts only on a matching plan.
`--lane PATH` scopes actions to one lane; `--verify-state-dir DIR` declares a
nondefault trusted verification store. Neither command starts a schedule or
calls a model. Use reviewed installed code for live application. Startup/shift
entry consumes pending requests through a fresh plan and guarded apply; this
change starts no new schedule.

To keep all worker/session/watcher tabs, panes and lane worktrees, create
`<canonical>/.lane/supervisor/HOLD-WORKER-TAB-CLOSE`, next to the `STOP` convention.
The canonical checkout comes from the Git common-directory identity, including
when invoked from a linked lane. Any entry holds retirement: file, directory,
symlink or dangling symlink. Only `ENOENT` means absent; other lookup errors
hold. Contents are never read. The planner keeps every tab with reason
`retirement held: .lane/supervisor/HOLD-WORKER-TAB-CLOSE`; apply logs `held`,
preserves callback receipts and rechecks immediately before each tab/workspace
close. This applies to tidy, both housekeeping paths, retirement CLI, watcher
and settle-watch retirement, failed dispatch tab cleanup and promotion cleanup.
`lane close` in any mode refuses before lifecycle changes. Promotion still
reports `promoted`, retaining the lane and branch with cleanup pending and
outcome `held`; its existing bounded, revision-checked retry can finish only
after the hold is removed. Drain catch-up still acknowledges ready first and
leaves retirement hints pending without writing `handled.json`. Removing the
entry restores normal fresh observation and guarded cleanup; it grants no
additional retirement authority.

The one pure policy is [lib/retire.mjs](../lib/retire.mjs). Its snapshots contain
the record fold, canonical Git common directory and lane head, Herdr topology,
all occupants, foreground processes and native process trees with kernel birth
identities, and current resource references. The
executor rechecks them before each action. It preserves working, blocked and
unknown occupants, operator focus, persistent/operator workspaces, and lab-owned
workspaces. A recorded report needs its ingestion sequence and a terminal
review/correction/integration chain; a file or verdict notification cannot
release a pane. Git must be clean and integrated (or a verified archived tip).
Historical report/evidence links are retained but do not create live holds.

An explicit closed item disposition (including `dropped`) supersedes its runs'
latest blocked, needs-human or failed outcome; an open item still keeps. A closed
blocker reached through a dependency link is checked itself without expanding
its children or blockers. Open blockers still expand, as does the root's own
subtree, and reviewer roots still climb to their engineer's chain. All other
retirement guards remain in force.

An idle recorded native agent whose extra processes all descend from its single
foreground process may receive an `exit` decision when every ordinary occupant
guard passes. Exit commands are launch-route data (`/quit` or `/exit`); unknown
kinds stay kept. A complete, healthy process tree is required; shell background
jobs, stopped/zombie processes and live references still keep the tab. Working
agents with their own helpers remain ACTIVE. The guarded executor serializes
each tab, re-observes the same token, checks native identity and an empty ready
composer, and sends the command with `herdr agent prompt`. It waits at most 60
seconds for the unchanged shell, then re-observes and requires an ordinary
`release` decision before closing. Failure keeps the tab with a concrete reason;
there is no process kill or force fallback. Lane removal still requires zero panes.
Descendancy proves ownership, not that a tool job has finished: it authorizes only
the agent's normal exit command, and never authorizes closing a surviving job.

Adopted standard slots add a KEEP input from canonical
`<git-common-dir>/sessions/standard-slots.json`, independent of manifests,
tab labels and `.lane/sessions.json.d`. The history binds common directory,
server, workspace, checkout, tab and every declared pane. Chat/supervisor have
one primary pane; logs has viewer and triage. These tabs and their enclosing
workspace/lane stay until explicit recorded withdrawal, even after their panes
disappear. Unknown or unreadable protection evidence keeps the project. No
receipt preserves prior behavior. The [sessions guide](../sessions/README.md)
defines the schema and offline `recordStandardSlot` adopt/withdraw helper;
this stage performs no live enrollment. Withdrawal preserves history and
removes only this KEEP input, leaving every other guard intact.

Warm work-item sessions also stay while their review/correction/integration
chain remains open, **including with a confirmed successor**, unless an explicit
`record pane-release` binds that idle session under the checks below. Ingested reports,
failed reviews, correction gaps and needs-human outcomes remain protected until
the record supplies terminal evidence/disposition under the ordinary checks.
The shared executor re-reads both the record chain and canonical slot receipts
immediately before each tab/workspace/lane action. These inputs only add KEEP;
they never authorize closing or changing a session.

Shared record, Git, native-process and Herdr IO lives in
[lib/retire-runtime.mjs](../lib/retire-runtime.mjs). All close-path consumers,
including standalone contrib, import that library. `supervisor/retire.mjs` retains
the installed CLI and compatibility exports. After guarded Git removal, empty
workspaces close only through `herdr workspace close`; Herdr worktree removal is
never used because it moves operator focus to the parent.

Promotion references follow each request's latest durable queue checkpoint.
Pending, interrupted and current work still keep their targets; a completed
reconciliation supersedes that request's older pending results, which remain
in the append-only history. A different request's hold is never superseded.

Explicit continuation between different panes uses
`record handoff R-old --to R-new --confirm --why TEXT`. The append-only event
names a newer run on the same item with a different launch identity. At
execution the successor must still occupy its recorded pane. It is reserved while
the predecessor pane exists, including when its own report is ingested; a later
observation can release it after the predecessor is gone and its chain is terminal.
An open review/correction chain keeps the predecessor too; a handoff cannot
release parked warm context before record disposition. Reusing the same session
for a new run always keeps that session. Handoff never
overrides an active process, unknown identity, or pending live reference. Reports
are immutable; the fold's shape and exports are unchanged and older folds ignore
the handoff event. A live native session needs its recorded launch session id;
a terminal-only legacy receipt cannot authorize a later native session. Labels, ledgers and session display metadata never authorize
retirement, so unrecorded reviewer, session and watcher tabs stay.

`record pane-release` records an authority-bound owner continuation note and a release
for one ingested run, binding its exact native session, terminal, pane, worker
workspace, checkout and Git head. It can release the idle session's whole tab
while its chain stays open; another kept occupant keeps the tab. It never releases
a lane or worktree. BCH's `HOLD-WORKER-TAB-CLOSE` still holds it, and
a same-pane, same-terminal or same-session continuation keeps the tab.

The project `release_sessions` housekeeping policy defaults on. It applies this
same pane-release transaction to reviewers with recorded PASS verdicts, and to
workers whose exact run has a PASS consumed by `promotion.reconciled` or a
confirmed retained successor with different pane, terminal and native session.
Open sibling work does not retain those completed sessions. NEEDS-WORK retains
both sessions pending correction/disposition. Reuse, missing or mismatched launch
identity, HOLD and live references remain keeps in the lanes view. Turn off only
these automatic releases with `record housekeeping set --release-sessions false`.
No fold keys or session display metadata grant this authority.
Settle reviewers have no separate worker run: after validating and publishing the
review, lane review writes an immutable `retirement-review/v1` receipt under
`ORG/retirement/reviews/`, bound to its launch receipt. Review never appends to the
event log. Their pane release uses `--reviewer` to bind that exact occupant;
it cannot release the worker. Unknown legacy reviewers stay kept.
After guarded tab closure the executor can close an empty policy-released native
workspace; its Git worktree, branch and open item chain remain intact.

Short-lived watcher and settle/executive/plan launches can write a mechanical
`retirement-occupant/v1` receipt under `ORG/retirement/occupants/`. It binds the
canonical common directory, cwd, workspace, tab, pane, shell PID and kernel birth,
and callback PID, birth and command; session launches also bind the agent's
terminal and native session. This receipt is independent of the display registry.
Lane review writes this receipt after verifying the reviewer; settle supplies the run under review.
The shared planner can prune an unchanged shell after the recorded process exits
and its callback completes. A watcher requires an ingested report; settle sessions
also require a terminal chain, and other sessions require no open run in their cwd.
Live jobs, unknown occupants, background processes, changed shells, operator focus,
and persistent/operator/lab workspace guards still keep. Recorded short-lived tabs
in the canonical checkout can retire without treating the desk itself as a lane.
`settle-watch --spawn` still appends `--close-tab-on-exit`. At its final instruction
that flag permits only its own recorded tab, pane, PID and birth to retire after
report ingestion, with no other occupant or process. If its guarded close fails,
a later tidy pass can reconsider its exited-process receipt.
Only watchers launched with `--close-tab-on-exit` record ownership of their tab;
a foreground watcher borrowing an ordinary operator tab leaves no receipt.
Apply removes receipts after their tab closes or when the current inventory
proves the tab absent. Preview skips absent-tab owner lookups and stays read-only.
Scoped cleanup retains receipts for workspaces outside its observed scope.
Housekeeping reuses its tick observation for receipt pruning, so bookkeeping adds
no record or agent reads to input recovery. Every close still gets a fresh guarded
observation. Other callers skip the pruning scan when no callback receipts exist.

Live sources are `<git-common>/promote/queue.json` (pending, current, interrupted
and reconciliation-pending jobs), the default trusted `verify-queue/v1` store
under `$XDG_STATE_HOME/herdr-monitor/verify/SHA256(common)` (or the normal
`~/.local/state` default), and the host slot lock and its `.queue` waiters. The
existing `MONITOR_TEST_SLOT_PATH` and `MONITOR_TEST_SLOT_COMPAT_PATH` declarations
are honored. Holders/waiters match by cwd or lane path in their label; verify
jobs match item or exact head. A completed integration/reconciliation checkpoint
waiting only for cleanup/delivery is no longer an active promotion resource user.
Live or unreadable recorded watcher processes and unsettled callback receipts keep
their run. Unknown/background pane descendants prevent retirement. Unreadable sources
fail closed. Git/read failures retain their affected workspace; record/reference
damage retains the project. No source is pruned or rewritten by observation.

The optional generic source is `<ORG_DIR>/references/`, with one atomic JSON
file per pending job. No writer is required. Writers publish complete files by
atomic rename and remove their own files when the job ends. Its exact format is:

```json
{
  "schema": "herdr-reference/v1",
  "owner": "tool-name",
  "kind": "host-check",
  "job": "job-id",
  "state": "pending",
  "item": "ENG-123",
  "run": "R-456",
  "lane": "topic",
  "cwd": "/absolute/lane/path",
  "pane": "workspace:pane",
  "created_at": "2026-10-14T20:00:00Z",
  "expires_at": "2026-10-14T21:00:00Z"
}
```

`schema`, `owner`, `kind`, `job`, `state`, `item`, `created_at` and `expires_at`
are required; `run`, `lane`, `cwd` and `pane` are optional. State is `pending` or
`running`. Cwd is absolute; timestamps must parse. An unexpired reference keeps
on any item, run, lane, cwd or pane match. Expired references are ignored and
reported. A malformed, unreadable or unknown-schema file keeps the entire
project and is reported, even if its apparent expiry is past. References only
ever keep; the planner never writes them.

Report ingestion, review/disposition and job completion coalesce a foreground
request in `ORG/retirement/request.json`. This is a revision hint, never stored
status or permission to close. Event writers supply the sequence they just
appended, without another log read; job completions supply a unique completion
key. A coalesced monotonically increasing request revision identifies each hint.
Canonical supervisor entry and both ends of a foreground promote drain consume
it once through the shared plan and guarded apply, recording the handled revision
and actual keep/refusal reasons. A repeated hint is a no-op; a hint arriving during
apply remains pending. `node supervisor/retire.mjs consume --repo CHECKOUT --org RECORD`
provides the same finite catch-up. Existing housekeeping reads fresh authority;
promotion also performs its scoped cleanup after reconciliation.
Request and consume locks bind PID and kernel birth identity. A proven dead
owner can be reclaimed; live or unreadable owners retain their locks. Entry lists
these locks and gives consume an internal `--budget-ms` deadline, with no outer
SIGKILL of the lock holder. A deadline releases the lock and leaves the hint pending,
including after partial apply; the next consumer observes again before resuming.
Promotion sends its ready acknowledgment before start-of-drain catch-up.
`skip-close` logs the fresh refusal. Promotion retains its successful outcome
with `cleanup.state: pending` and `integrated-but-cleanup-pending`; a subsequent
queue drain retries only cleanup, without revalidation or another integration.
Per-result retries wait one minute, then back off exponentially, capped at five
attempts for unchanged record/request revisions. A changed record or request
revision permits another attempt immediately; receipts retain the last refusal.
`lane close --git-only` requires zero live panes before removing the worktree,
even when a pane is eligible but not yet closed. Both close modes verify archive
tags, preserve ignored evidence with verified hashes outside the worktree, and
preflight Git metadata before deletion. Empty lane workspaces then close through
the same guarded executor; workspace failures remain cleanup-pending.

Supervisors and workers do not open blocking questions. They record each one
with `record ask` (an action category, a safe recommendation and a reason),
take the safe default and continue; funds, publishing, credentials and permission
changes default to no. This is policy text in [PROTOCOL.md](PROTOCOL.md) and the
project instructions, not a hook: Monitor registers no per-launch question guard,
permission hook or operator-presence check, and the harnesses' own sandboxes and
permission prompts apply. Launch native harnesses through Herdr with project policy
arguments. Project chats retain canonical checkout and pane receipts; older
receipt fields are ignored.

Project chats catch up on demand from `record status`, `record log --since 2h`
and `record show ID`; promotion and watch facts stay in `ORG/supervisor/inbox.log`.
(`record digest` was removed on 2026-10-12.)

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
| `promotable`, clean independent PASS in the named cohort | `promote RUN --existing-worker --why 'notice-autopilot/v1: clean PASS promotes …'`; an already-live native worker is required |
| `fix_round` | Leave the dispatched, watched correction in flight |
| Exact settle "base branch moved" escalation | One `handle RUN --retry` using the saved request, without `--to`; a second escalation wakes |
| Any findings, including capped Moderate/Minor or PASS with findings | `AUTOPILOT_FINDINGS`; ordinary supervisor judgment, no automatic acceptance or follow-up |
| `[promote-queue]` promoted | `handle --notice TEXT` closes the bound item; an awaited item then wakes with one landing line |
| Verified notice for an abandoned run | Journal and drop without waking or mutating the record |
| Anything else | Wake with a bounded one-line reason and the action receipt path |

FAIL, Major findings at the review cap, refusals, train failures, unknown release
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
`.supervisor.json` containing `{"autopilot":{"enabled":false}}`. Absence means
**off**. The schema accepts `autopilot.enabled` as a boolean and `autopilot.cohort`
as a string. The pilot requires both `enabled: true` and `cohort: "clean-pass"`;
a missing/unknown cohort wakes with `AUTOPILOT_COHORT_UNKNOWN`. A separate
[`green-pass` cohort](GREEN-COHORT.md) supports pin-bound green work with an
explicit Brain/lab identity configuration, protected cross-project execution
inventory, fail-closed reach checks and lifecycle control evidence. Selecting or
enabling it remains a separate supervisor step after bootstrap review. Tooling must be
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
remain per run so different delivery IDs cannot create duplicate reviews or enqueues.
Promotion receipts use the producer's notice ID: `promote:JOB` and
`promote:JOB:complete` are separate receipts after an interruption. A resumed
native refusal uses `promote:JOB:native-refusal:CONTENT_HASH` so its coded
exception never rewrites the original immutable interruption notice. Legacy receipts
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

The clean-PASS pilot checks the complete base-to-candidate diff before review
and after settle, with rename detection disabled so deletions and both rename
names are checked. Its closed Brain map covers one area among `brain/`, `board/`,
`logs/`, the `pane-run-output`, `render` or `report-feed` lib module and its named
test, or documentation. Protected lifecycle, session/permission, native launch,
notice, record, review, validation, receipt, promotion and release surfaces stay
on the ordinary path. Unmapped paths, symlinks/submodules, changed executable
permissions, missing/dirty diffs, and changes across mapped areas produce named `AUTOPILOT_SCOPE_UNKNOWN` or
`AUTOPILOT_SCOPE_EXCLUDED` exceptions. Settle's exact added review document is
included and hash-checked, never omitted from validation's tree identity. Scope
eligibility supplements the independent review of reachable effects; it does
not grant a changed behavior or authority contract.

`AUTOPILOT_NO_NATIVE_WORKER` means no currently live finite drain has successful
`/dev/ptmx` read/write, loopback listener and complete native process inventory
probes recorded against its kernel process birth and command. Autopilot does
not start one. `--existing-worker` rechecks
under the queue lock, serialized with the finite worker's empty exit, and never
falls back to a launch. The supervisor may use the ordinary bare enqueue from
its already authorized native context. Every worker and train probes again
before running preparation/checks; refusal is `PROMOTE_NATIVE_PTMX_REFUSED` or
`PROMOTE_NATIVE_LOOPBACK_REFUSED` or `PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED`
in the batch receipt and notice. The concrete
loopback requirement is exercised by `test-slot/test/helpers/gate-profile.mjs`;
the bounded gate runner and fixture cleanup require complete native inventory. No provider/harness detection, permission change,
unsandboxed relaunch or forwarding of a refusal is performed. A refusal is
preserved for the operator under native authority. If an earlier validation or
integration checkpoint exists, its interrupted batch retains `native_refusal`
evidence and is excluded from automatic drain retries. The operator must
inspect and resolve it under native authority; unrelated requests still drain.
A new worker never adopts that refusal as ordinary interrupted recovery.

The guarded fast-forward rechecks current run/head/clean PASS, pilot switch and housekeeping pause,
engineer children created after queue admission, blocking children, dependencies,
questions and STOP under the existing Git and record locks. Pre-existing optional
follow-ups, including non-blocking engineer report proposals, remain independent.
Retirement holds retain their separate cleanup-only meaning.
Duplicate/delayed notices adopt prior action journals; uncertain commands wake
without replay. A completion-only retry never reruns a successful gate or merge.

While policy authority remains active, each pilot run gets one `Fast path timing:`
note at landing or an exception,
projected from existing clocks: run start (dispatch), report-file mtime (report
available), ingest event, settle review start/end, queue admission, gate start/end,
integration and reconciliation event. The action receipt also keeps the current
measurement. Queue, slot, external-lock and dispatch waits remain named, with
missing clocks null and reuse explicit. File mtime is an observation, not a
claim about when the engineer finished writing. Awaited landing delivery is not
an exception. No scheduler or timing service is installed.

**Second-project adapter seam (BCH joins later).** The existing queue remains
the integration authority: bind a request with `--expected-head`,
`--if-current-run`, `--org` and the approved required-check plan (including
`--required-tests` for Brain's deferred full-file test evidence). The
automatic caller also needs the current run-bound completed settle/PASS receipt;
BCH must bind its own accepted review evidence at that seam, never infer PASS
from a done report. The owning project supplies its canonical
`.lane.validation.json` promotion command/planner and `.promote.json` gate preparation, Node/environment and resource declarations.
Its existing selector/receipt adapter runs against the queue's actual scratch
candidate and base; reuse requires its full existing input binding, and a miss
runs the selected focused checks there. A separate reviewed scope mapping and
project authority adoption are required before BCH opts into automatic enqueue;
Brain's map does not certify BCH paths. Preserve BCH's consumer/resource/proof
obligations and distinct review workspace contract. Do not put a second
fast-forward behind the adapter or weaken receipt identity to obtain a hit.
No BCH rollout or new receipt bridge is a prerequisite for this Brain pilot.

Bootstrap: this implementation uses the full existing review/promotion route.
Leave the canonical switch off until independent implementation/security review
of the landed bundle, then the owning supervisor may enable the named cohort
under its existing activation authority. This change does not enable itself.

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
deliver together. The compatibility `contrib/settle-watch.mjs` stays
until bch-cloak has completed its release-gated switch.

Foreground `supervisor.mjs entry --repo PROJECT --role supervisor` prints a pointer
to this installation's [PROTOCOL.md](PROTOCOL.md) for the native supervisor session
to read, then prints `supervisor.mjs brief`, resumes housekeeping only when both enabled
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
and then `supervisor-herdr`. Pass the foreground command an explicit recipient
when a project uses another supervisor name. Invalid receipts print a
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

Run foreground entry explicitly after startup, resume, clear or compact when a
fresh brief or recovery pass is needed.

```sh
node /path/to/monitor/supervisor/supervisor.mjs entry --repo PROJECT --org RECORD --role supervisor --to YOUR-SUPERVISOR
```

`status` renders active lanes and the ten most recent landed lanes with run, item,
lane, stage (engineering, review, fix, train, landed), provider/model, start time
and elapsed time, followed by the last ten policy receipts and their actions.
[status.mjs](status.mjs) exports the same read-only JSON projection. Stage comes from the event fold, verified settle receipts
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
runs and opaque routes/models/efforts, landed report files,
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
receipt. Autopilot requires a clean PASS; findings always take
`AUTOPILOT_FINDINGS` and the ordinary path. Major/FAIL findings,
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
newer runs, unresolved/declined blockers (including a done review whose latest verdict
is not PASS), open work and changed outcomes; the queue also refuses while an operator
question under the item or its blocking review is open. Conditional
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
way. A coded `AUTOPILOT_NO_NATIVE_WORKER` enqueue refusal is a confirmed no-op:
the journal records `not-queued`, and a later bare `promote RUN --why REASON`
can proceed without `--retry`, preserving the refusal in its attempt history.
The record note describes a promotion request; only the acknowledged queue receipt
establishes admission.
Repeating a successful promotion, including with `--retry`, returns the saved
acknowledgement even after lane closure.

An interrupted batch carrying `native_refusal` stays excluded from automatic
drains. After the operator resolves the native refusal in the authorized context,
explicitly run `node promote/promote.mjs --resume --repo CANONICAL` there. This
re-probes the concrete capabilities; failure retains the refusal and checkpoints,
while success records the refusal and new probe, clears the automatic-recovery
hold and resumes the existing batch. It never changes permissions or selects
another executor. Recovery consumes validated or integrated checkpoints when
their original inputs still match; changed inputs retain the existing replan
and validation requirements. Unrelated requests can drain during the hold.

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
boundaries. The old model-session launchers (`open-session.mjs`, `settle.sh`,
`continue.sh`, `workspace.mjs`) and `SETTLE.md` were removed: native `handle` and
settle replaced them. `contrib/settle-watch.mjs`, `arm-watch.sh`,
`dispatch/record-worker.mjs` and `reconcile.mjs` stay unchanged for bch-cloak
(ENG-64). The installed supervisor entry, this protocol, settle and housekeeping
cover the old session-start/SETTLE/work pattern responsibilities; project
authority/history belongs in record decisions, validation in project config,
machine paths/accounts in machine installation.

Internal response waits adapt to measured machine load; see the
[deadline inventory](../docs/reference/load-deadlines.md) for allowances and preserved safety checks.

Cold-start briefs show one [host memory pressure](../docs/reference/memory-gate.md)
line, read-only, so the supervisor waits before expensive cycle steps. They no
longer list process consumers or storage advisories.

A PASS review containing only scoped `Test evidence not re-executed` entries can
use the normal bound promotion path when the promotion test plan covers every
named file. Autopilot then queues and closes it through the existing verified
landing path. Reviewers still execute no commands and must report missing code,
incomplete acceptance and other uncertainty separately.

If the plan cannot cover those files, the supervisor may execute them in full
and record the evidence before `promote RUN --why REASON`. After the review record
is committed, run this from the clean lane workspace (substitute the named files):

```sh
LANE_VALIDATE='node --test FILE...' node lanes/lane.mjs check --tier fast
```

`LANE_VALIDATE='node test/helpers/run.mjs FILE...'` is also accepted. The receipt's
head and tree must match the current lane HEAD after the review commit; a check
from before that commit is stale. Then add a decision note to that run with the exact text
`Test re-execution evidence: /absolute/GIT_COMMON_DIR/lane-validation/KEY.json`.
Promotion resolves only the saved test-only PASS escalation, verifies the green
receipt's exact lane head/tree, full-file command and immutable log hash, and
rechecks all normal record, clean-tree, STOP and replay guards. Missing, stale,
filtered, red or unrecorded evidence cannot discharge it. The resulting request
retains the run binding and closes through the usual autopilot landing path.

## Manual and legacy promotion batches

Use [the shared completion protocol](PROMOTION-COMPLETION.md) to bind every member,
exclusion and superseded attempt before the gate and reconcile the full batch
before lane cleanup. `supervisor/reconcile.mjs prepare|finish` verifies project,
Git and gate evidence; `record complete-batch --file JSON` applies the guarded
record transaction. BCH Cloak can use this adapter during its release-gated
migration to the native workflow.
