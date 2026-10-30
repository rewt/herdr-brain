# Minimal line service

## Saved session bindings

Each pass replays completed dispatches' saved `observing` session proposals
before review intake, independently of the review cutoff. This is a record-only
operation under the original request lock and exact Brain claim. It never calls
dispatch recovery or native input. Unknown record replies keep their evidence
for another pass; refusals and unbound proposals remain final. The original
proposal and release stay unchanged. A `dispatch-session-binding/v1` receipt in
the dispatch journal names the settled event; see [the dispatch contract](../dispatch/README.md).

## Scoped review admission

`review_admission` is a project lane policy, default off. Set the whole object
atomically through the existing owning project's `record config set` writer;
identity defaults and standalone routing files cannot carry this setting.

```sh
record config set review_admission '{"enabled":true,"producer_groups":["ENG-16:R-32:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"canonical_commits":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"hold_ordinary":true}' --who-asked 'owning recorded selection'
record config --json
node "$ACCEPTED_ROOT/line-service/review-admission.mjs" --repo /OWN/CANONICAL --org /OWN/RECORD
```

Replace the example group and commit with the exact selectors returned by the
read-only inspection command. Producer groups normally have the form
`ENG-n:R-n:64_HEX_EVIDENCE_HASH`; explicit supplemental captures have the exact
`supplemental-review/v1:64_HEX_EVIDENCE_HASH` key. Canonical selectors in the view
are full commit IDs, without the `canonical:` prefix. No prefixes, item-wide
selectors, inheritance, globs or implicit inclusion of later captures apply.
For BCH's freeze, its owner selects exactly its sixteen producer group keys and
the full commit corresponding to `canonical:a94dfb72`, with `hold_ordinary:true`.
Those project-private values must come from BCH's own inspection and recorded
selection, not another project's record. Both arrays are required when enabled;
empty arrays intentionally hold that entire review category.

The line checks new producer/canonical queueing, existing queued review launches,
and saved review recovery/continuation. It rereads the project policy at effect
admission, including after capacity observation. Optional `hold_ordinary` holds
new ordinary selections (including repair dispatch) while existing reports,
verdicts and physical cleanup continue. An intentional review-only hold does not
create an engineering-idle repair. This policy does not stop a running worker,
change an immutable target, clear another hold, override caps/native ownership,
or grant authority to a manual caller. Disabling it resumes existing selection:

```sh
record config set review_admission '{"enabled":false}' --who-asked 'owning recorded selection'
```

Excluded debt stays discoverable and queued records keep their original attempts.
Each pass retains typed `REVIEW_ADMISSION_PRODUCER_NOT_ALLOWED`,
`REVIEW_ADMISSION_CANONICAL_NOT_ALLOWED`, `REVIEW_ADMISSION_BINDING_UNKNOWN`, or
`REVIEW_ADMISSION_ORDINARY_HELD` rows in `passes.jsonl` and
`effects.json.review_admission.held` under the existing project service directory.
These are expected selection holds, separate from review errors and verdicts.
The read-only view shows exact selectors, policy holds and independent source
holds without queueing or dispatching anything. An allowed row still needs every
existing readiness, source, STOP/HOLD, cap and native check. No record event or
fold change is required; old folds continue to read the record unchanged.

## Selected-only ordinary admission

`ordinary_admission` is a separate project lane policy, default
`{"selected_only":false}`. Its supported writer is `record config set`;
identity defaults and standalone routing files cannot supply it. An owner can
preview a proposed selection without changing policy, record events, queues or
native sessions:

```sh
node "$ACCEPTED_ROOT/line-service/review-admission.mjs" --repo /OWN/CANONICAL --org /OWN/RECORD --ordinary-admission '{"selected_only":true,"items":["G-9","ENG-42"]}'
record config set ordinary_admission '{"selected_only":true,"items":["G-9","ENG-42"]}' --who-asked 'owning recorded wave selection'
```

With `selected_only:true`, an ordinary item needs its own
`meta.queue_selected===true`, or an exact ID in `items` naming itself or an
ancestor. The optional array is a named set; no globs or ID prefixes apply.
Naming an ancestor deliberately selects its descendants, including future
proposals; an ancestor's metadata flag alone does not. An item's explicit
`queue_selected:false` vetoes the named set. Other readiness, ancestry holds,
reserved decisions, STOP/HOLD, pools, native identity and original-attempt guards
still apply. Selection does not serialize a wave: the existing detached starts
fill the build pool using item-named lanes and normal report/cleanup paths.

After adopting a compatible accepted release, BCH's owner would set the following
to start only its explicitly flagged wave while retaining its review allowlists:

```sh
record config set ordinary_admission '{"selected_only":true}' --who-asked 'owning recorded selected-wave admission'
record config set review_admission.hold_ordinary false --who-asked 'owning recorded selected-wave admission'
```

The second command changes only the ordinary hold; it preserves `enabled`,
`producer_groups` and `canonical_commits`. Keeping `hold_ordinary:true` continues
to hold every ordinary start, including explicitly selected items. BCH's owner
must supply its actual project paths and selections; these examples do not edit
another project. Preview with the same `--ordinary-admission` value first; it
shows both policies, each ordinary item's record status and `selected` flag,
and the effective `hold`. A null hold is selection permission, not a readiness
or native launch guarantee.

Every unselected open ordinary item remains in the record. Pass diagnostics and
`effects.json.ordinary_admission.held` show typed
`ORDINARY_ADMISSION_NOT_SELECTED` or `ORDINARY_ADMISSION_DESELECTED` reasons,
including exclusions beyond the pass's start/cap limit. Admission rereads policy
and current ancestry/flags after capacity observation before recording an effect.
Intentional exclusions do not count as stalled ready work for idle repair.
Reviews retain their independent exact allowlists; running workers, report intake,
verdicts, cleanup and saved UNKNOWN attempts retain their existing paths.

Disable or unset `ordinary_admission` to restore the legacy selection rule,
including unflagged non-proposal items. No new record event or fold change is
needed; older folds continue reading the same item metadata.

### Diagnosing few automatic starts

Bind the diagnosis to the consumer's installed runtime and owning config home,
then follow an actual `review-admission-held` row in `passes.jsonl` to the
corresponding policy decision. `REVIEW_ADMISSION_ORDINARY_HELD` is an explicit
project freeze, even when an item's own selection flag is true. Queue class and
priority change ordering; they cannot override that freeze. Removing a scheduling
delay cannot remove it either.

Older releases without `ordinary_admission` select unflagged non-proposal
backlog by default. A consumer waiting for selected-only support may therefore
deliberately retain the blanket ordinary hold. The compatible fix is the
default-off selected-only policy above, followed by the owning consumer's
authorized policy application. A preview that still shows the review hold is
evidence of the remaining freeze; it does not authorize lifting it. Inspect all
own `queue_selected:true` items before application: `items` is additive to those
flags, so a named set cannot cap stale explicit selections.

Separate three observations: installed-release refusal, isolated source recovery,
and actual installed consumer recovery. The focused `ordinary admission recovery`
control records a start with the actor passed by the line to its dispatch adapter,
while own/inherited holds, reserved work and excluded backlog stay pending. Its
native launch is stubbed; it cannot stand for a consumer's real start or soak.
Keep scheduling evidence with its owner instead of repeating unrelated checks.

For a live comparison, use the lifecycle measurement's fixed window and explicit
actor declarations. Count actual `run.started` events by their actor, and retain
unknown actors and allocated-but-unbound starts separately. A supervisor start
does not become a line start because the line later closes it. Over the next
roughly ten ordinary units, report both the all-start denominator and the eligible
selected cohort, with every hold, capacity wait and manual rescue explained.
The share alone cannot distinguish a deliberate freeze from scheduler starvation.
Consumer pin/activation and that live witness remain with their existing owners.

## Scheduling and owned commands

`pass.lock` protects scheduling and the single `effects.json` writer. Before
waiting for a foreground command the pass saves its intent and yields that lock.
Another finite wake can then consider independent subjects. A subject lock spans
the whole effect, including recovery; a changed input cannot replace a started
action on the same subject. On return the pass reacquires the scheduling lock
and reloads the journal in place before writing its result. Other passes' receipts
are inherited. Productive command time does not consume the scheduling allowance.

Each saved command names its consumer, completion wake fact and stuck owner.
The foreground helper persists its exact terminal result before replying, even
if the scheduling parent has exited. A missing result remains UNKNOWN, with no
timer-based retry, deletion or native substitution. Independent work can proceed.
Commands and their immutable results live in the existing service directory;
the action points to their receipt, which retains the original intent after the
active marker is removed. Recovery/decision operations keep their actual subject
lock and exact owner token while using the existing installed-service, source
and record guards. A saved subject label or reused PID grants no authority.

Maintenance still orders control, pass and promotion locks. While holding the
pass lock it additionally checks active command intents for matching terminal
receipts. An unfinished or UNKNOWN command refuses the transition, retaining its
named owner. PID disappearance alone cannot prove a quiet point. This applies to
forward/rollback, recipient changes, restart and cutoff/reference controls; no
running service or saved pin is changed by source delivery.

The pass audit reports `schedule-unlocked.duration_ms` per lock segment and total
`pass_lock_ms`, maximum segment and `suspended_ms` on completion. Admission rows
separate eligibility observation, decision, capacity observation and original
dispatch acknowledgement. Rows name their process and subject so overlapping
passes can be joined. `capacity_waits` retains the interval from first observed
full capacity to the next observed available capacity, separately from decision
time. Command receipts carry those admission facts and the foreground helper's
actual start time; they remain readable after active-marker removal.
`event_to_wake_ms` remains null for ENG-1033 to supply;
an acknowledgement is not a claim that the worker has finished native startup.

## Standing order and explicit selection

The existing record's single open `meta.queue_order` owner declares the operator's
ordered outcome names (an array or JSON array string). `meta.queue_class` on an
item, or its nearest classified ancestor, assigns an outcome; `queue_default`
on the order owner classifies otherwise unclassified descendants. Existing work
with runs uses `finish-open-owned-work` unless it has its own explicit class.
A captured source review serves its source item's outcome. Numeric item priority
and queued-review preference break ties within an outcome. Independent lower
ready work is considered when higher work is held or otherwise ineligible;
rehearsal/withdrawal ordering adds no dependency. Invalid or ambiguous standing
order refuses admission. Only the operator changes standing order; delegates
apply the adopted order and classify/select its on-path work.

Report proposals remain records until their own `meta.queue_selected=true` is
recorded. Parent selection never selects future proposals. `queue_selected=false`
also keeps any ordinary item outside admission. Directly commissioned existing
line items and captured post-code review obligations retain their normal selection.
This is an admission seam; proposal intake, typed deduplication and lapse policy
are separate work. Held, reserved, dependent, active and UNKNOWN requests retain
all existing launch/native guards. Queue order never clears a hold.

For the positively identified old Phase 0 priority-only hold, first record an
explicit own-item selection and an adopted on-path `queue_class`. Then the normal
owning worker can archive one disposition and apply it from clean landed source:

```sh
node line-service/priority-migration.mjs --org /OWN/RECORD --plan /OWN/RECORD/evidence/SELECTED/priority-plan.json --authority ADOPTED_DIRECTION_REFERENCE
node line-service/priority-migration.mjs --org /OWN/RECORD --run R-n --apply /OWN/RECORD/evidence/SELECTED/priority-plan.json
node line-service/priority-migration.mjs --org /OWN/RECORD --run R-n --restore /OWN/RECORD/evidence/SELECTED/priority-plan.json
```

The plan records exact before/after metadata and every retained hold. Only selected
never-started items with the exact priority-only reason and provenance qualify;
earlier independent holds, hold notes, reserved subjects, runs and saved attempts
exclude migration. The existing owning native worker, claim, source, record lock,
promotion write guard and STOP/HOLD fences are checked at mutation. Restore uses
the same archive and refuses changed subjects; it restores absent keys exactly.
There is no bulk-clear, duplicate closure, dependency rewrite, new scheduler or
consumer/pin edit. Older folds ignore the disposition and retain the old holds.
The ordinary pass audit records its actual order and classifications; source and
focused checks alone do not prove installed execution or release acceptance.

For the contained startup-notice backlog, the owning native supervisor can run
this explicit source control from its canonical project checkout:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/supervisor/prompt-supervisor.mjs --handle-pending-line --org /OWN/RECORD --id STABLE_BATCH_ID
```

It selects all currently safe PENDING `[line-service]` notices addressed to
`brain-chat` in that record, not an old startup manifest. One immutable bounded
manifest and one existing `session.message.v1` record envelope precede explicit
handling. Original inbox bytes, sent entries, uncertain/in-flight attempts,
obligations, unrelated recipients and order remain. Existing `autopilot` handled
events let retained inbox readers recognize the disposition; no SENT, native
delivery or model consumption is claimed. Retry the same ID only for the same
saved batch. New arrivals stay pending and are returned explicitly.

The control requires actual project/record/caller/recipient/source bindings and
uses the SAME drain and journal locks without owner probes/recovery. An occupied
lock, source/native change, redirected receipt, unknown project or changed
notice state refuses before further handling. It never prompts, resumes,
restarts or signals the inbox owner. A refusal is not authority to use an
alternate executor or edit the journal. Only the project owner executes this
control; the worker supplies source/affected evidence. This is not permission to
restart either stopped line service.

## Phase1 source contract

For a fresh second project, read the
[adoption runbook](../setup/second-project-adoption.md#canonical-native-owner-and-line-installation)
before installing. An existing supervisor in another repository cannot authorize
the new project's install. A fresh accepted READY release supports
`install --id ID --dry-run`, followed by the identical binding options and
`--expected-plan SHA256`. Its supported apply writer records the actual canonical
landing cutoff and bootstraps once, without a development-source migration.
The runbook gives exact commands; use a qualified release containing ENG-1095.

The operator approved the whole Phase1 implementation on 2026-10-26. Source
landing and offline checks do not claim live acceptance. Brain must first prove
one existing small item through start, land, report, review, verdict, source close,
worktree removal and session retirement without a chat session operating it.
Then BCH's own supervisor performs the same proof. No Fera or public effects.

Each model-free launchd pass uses the existing record, native dispatch, route,
claim, closeout queue and transport. It never promotes another owner's work or
calls a model API. The supervisor uses its accepted installed release (or the
existing committed canonical development-source controls), pinned Node20.19.4,
actual native path/socket and its own project.
BCH effects belong only to BCH's supervisor. No pins, saved consumers, old
watchers, claims or retained ambiguous/native-refused attempts are replaced.

```sh
# Existing development-source install after its supported cutoff initialization:
node line-service/launchd.mjs install --repo /OWN/CANONICAL --org /OWN/RECORD --to PROJECT_SUPERVISOR --herdr /ABS/herdr --socket /ACTUAL/herdr.sock
node line-service/launchd.mjs status --repo /OWN/CANONICAL
node line-service/launchd.mjs stop --repo /OWN/CANONICAL
node line-service/launchd.mjs restart --repo /OWN/CANONICAL
```

For a new install, omitting `--to` selects the actual canonical native supervisor
performing the install. An explicit recipient must also resolve to a live named
agent in that project through the selected Herdr executable and socket.
Release install preview writes nothing and requires fresh service state. Apply
retains `installs/ID.json` before any configuration or launchd effect, under the
existing control/pass/promotion/record guards. A partial or refused attempt is
UNKNOWN and cannot be replaced or replayed, including under another ID. It keeps
its intent, cutoff, configuration and STOP; source landing/fixtures do not grant
live activation authority. Completed fresh installs participate directly in
runtime and recipient history, including later upgrades and rollback.

Stop writes this service's STOP and boots out its exact saved job. Restart proves
the saved job absent and archives its STOP before one bootstrap. Refusal or
uncertainty retains STOP and its receipt; it grants no alternate-executor retry.
Project STOP/HOLD, actual native identity, claims/generation, source cleanliness,
main CAS/FF and archives remain mandatory. Ordinary lock recovery requires fresh
positive ESRCH, existing recovery serialization, owner re-read/CAS and original
owner archive; live, EPERM and unknown stay held. There is no force entry.

### Change a stopped service's notice recipient

The project's own canonical native supervisor uses the matching current source
or accepted installed release containing this command. Retarget requires an
existing `installed` receipt, clean canonical main/source, the service's own
STOP and a positively absent launchd job. A project STOP/HOLD, occupied control,
pass or promotion lock, foreign record/caller/recipient, changed native session,
unknown phase or saved-binding drift refuses the operation. It never recovers
a pass owner or stops/starts a job itself.

```sh
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" status --repo /OWN/CANONICAL --org /OWN/RECORD
# If not already stopped, the owning supervisor first uses the supported stop.
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" stop --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" retarget --repo /OWN/CANONICAL --org /OWN/RECORD --to PROJECT_SUPERVISOR --dry-run
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" retarget --repo /OWN/CANONICAL --org /OWN/RECORD --to PROJECT_SUPERVISOR
```

`NODE` is the pinned Node 20.19.4; `CURRENT_ROOT` must be the saved installation's
current source, after its separately authorized release upgrade if necessary.
Brain uses `--to supervisor-herdr`; BCH's owner uses `--to supervisor-opus` with
BCH's own canonical repository and record. These are owner commands, not worker
authorization to operate either real service. Restart remains a separate owner
action subject to its existing guards and release acceptance.

The dry run writes no installation, plist or receipt. Apply preserves every
plist byte except the recipient string at `ProgramArguments[8]` and sets only
`installation.recipient`. It first writes an exclusive immutable before/after
archive under `retargets/`, then appends a typed
`line-service.recipient-retargeted` record receipt naming old/new recipients and
the actual native caller/recipient tuples. The service STOP, runtime, pin,
transport, interval, logs, saved jobs/watchers and retained deliveries stay intact.
An already-current recipient returns unchanged without another receipt.

An interrupted intent or changed archive is UNKNOWN: STOP and the original
archive remain, and restart, migration, upgrade and further retargets refuse
automatic replay or replacement. Completed changes participate in the existing
installation history across migration and release upgrades. Rollback of a later
upgrade restores its exact previous recipient; a new retarget after an upgrade
requires a separate owner disposition before rolling that upgrade back, because
its exact prior installation would otherwise overwrite the later routing choice.

### Move a stopped development-source service to an accepted release

The project's **own canonical native supervisor** runs this handoff. Brain's
maintainer supplies source and offline evidence; it performs no BCH effects.
The old `rc-20261028-d993883a63` bundle has no migration command. The release
coordinator must first qualify a release containing this implementation, with
full final-release coverage, live acceptance and corrected Majors. The project
owner then adopts that accepted release through its normal pin process. Source
landing or the fixture tests below do not qualify an installed release or lift
any existing admission/priority hold.

Keep the service's own STOP throughout migration, with its exact launchd job
already absent through the supported stop. Project `.lane/supervisor/STOP` and
`HOLD` still refuse this control. A retained pass/control/promotion lock also
refuses; this command never probes/reclaims an old owner. Resolve any actual
native refusal or uncertain owner through its existing owner, not by removing
files, editing a plist, borrowing an identity or changing saved runtimes.

From the actual canonical project checkout and existing native session, use
the immutable installed root reported by the project's READY pin. Substitute
the real project, record, release and a stable migration ID:

```sh
NODE=/Users/rewt/.nvm/versions/node/v20.19.4/bin/node
ACCEPTED_ROOT=/ABS/installed/releases/ACCEPTED_RELEASE_WITH_MIGRATION
"$NODE" "$ACCEPTED_ROOT/line-service/launchd.mjs" status --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$ACCEPTED_ROOT/line-service/launchd.mjs" migrate --repo /OWN/CANONICAL --org /OWN/RECORD --id development-to-release --dry-run
# Copy archive.sha256 from that dry-run's JSON into PLAN_SHA256.
PLAN_SHA256=EXACT_64_CHARACTER_DRY_RUN_DIGEST
"$NODE" "$ACCEPTED_ROOT/line-service/launchd.mjs" migrate --repo /OWN/CANONICAL --org /OWN/RECORD --id development-to-release --expected-plan "$PLAN_SHA256"
```

Dry-run checks native/record/pin/payload bindings under the handoff locks and
leaves runtime files intact; dead-pass recovery is receipted below. Apply
requires its exact plan digest, the same native owner and clean
canonical main, unchanged installation/plist/STOP, the original cutover, an
absent launchd job and READY acceptance for the exact fully verified installed
payload. Drift between planning and application refuses; inspect it before
planning any new action. No global-current or development-source fallback is
used. The Node executable must equal the original recorded installation and
execute Node20.19.4; it is retained rather than upgraded.

An original install can retain `phase: "uncertain-or-refused"`: `install` writes
that phase when its one `launchctl bootstrap` throws or returns nonzero.
The saved Brain development receipt instead has `phase: "stopped"` and
`stopped_at`, with no recipient or runtime fields. Migration admits that shape
through the same verified stopped-state settlement, retaining `stopped_at` and
the exact original receipt bytes in the archive.
`restart` records its own uncertainty in `controls.jsonl`; it does not rewrite
the installation phase. Do not edit that receipt or replay the install.
Migration accepts these original receipts only with all the same guards,
including positive native absence and this service's unchanged STOP. Its
immutable migration archive records a `line-stopped-installation/v1` observation,
and the same record transaction appends `line-service.stopped-installation-verified`
before the migration completion. Successful migration or forward upgrade also
records `line-service.installation-settled` with its immutable archive and verified
stopped-service proof, and sets the current phase to `installed`. The archive
retains the original phase/error/stop time; no original bootstrap is replayed or claimed
successful. Partial intents and unknown service observations remain held.
Dry-run leaves runtime bindings unchanged (dead-pass recovery is receipted as below).
`starting`, other phases and partial/UNKNOWN
migrations remain refused. This recovery must be present in the accepted release
**before the project's one migration**; a7b9b37dcd does not contain it.

The only plist change is the controller entry point in `ProgramArguments[1]`.
Label, project/record, recipient, Node, Herdr executable, socket, PATH, interval
and log paths remain the saved values. The installation retains its original
time/target and records the immutable accepted runtime plus migration archive.
No install flags are accepted for migration. Original installation/plist bytes
are fsynced once to `line-service/PROJECT/migrations/ID.json`, then a completed
`line-service.runtime-migrated` event links that archive to the untouched original
cutover. Phase0, STOP, saved dispatch/watch/settle/closeout jobs, claims, effects
and UNKNOWN review attempts are not rewritten. Those jobs keep their recorded
runtime; only new controller invocations use the installed entry point.

The control takes the existing pass, promotion and record locks plus one
service-control lock. Both dry-run and apply may recover only a proven dead
`pass.lock` owner (including a dead `.recovery` guard), using the line pass's
serialized recovery protocol. A fresh positive ESRCH, exact directory/owner
re-read and repeated death probe are required. Legacy at/argv owner identity is
retained; live PIDs (including reuse), malformed/missing identities and refused
probes retain their locks. Append-only `line-service.lock-recovery` events with
schema `line-lock-recovery/v1` bracket removal with intent/completion, recording
the operation/ID, dry-run flag, native caller, owner bytes digest, directory
identity and death proof. Receipt failure prevents removal; an intent without
completion remains visible for inspection. No stale lock means no recovery event.
Control, promotion and record locks retain their no-recovery behavior.
An interrupted application leaves STOP
and its immutable intent; either the same ID or another ID refuses replacement
of an UNKNOWN attempt. A completed exact-ID retry only reads the original
completion. Partial migration is not authority to restore files by hand or
retry a native effect. The owner inspects the retained archive and refusal and
routes any necessary repair through the normal correction path.

Migration never starts a job or archives STOP. After the supervisor's separate
admission/priority decision and fresh own guards permit launch, restart through
the **same installed root**:

```sh
"$NODE" "$ACCEPTED_ROOT/line-service/launchd.mjs" restart --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$ACCEPTED_ROOT/line-service/launchd.mjs" status --repo /OWN/CANONICAL --org /OWN/RECORD
```

Restart validates the completed handoff, installed payload and current project
pin before its one bootstrap. Its existing STOP archive/restoration and native
refusal behavior remain. Installed passes no longer require a development Git
checkout; their source head is the release commit. A changed project pin holds
future controller effects rather than silently rebinding a saved controller.
Observe the first real pass's source, queue, capacity and effects using existing
receipts. Offline controls simulate launchctl in disposable projects and are
not a BCH restart or live acceptance receipt.

Use that accepted immutable root for shell adapters as well:

```sh
PATH="$(dirname "$NODE"):$PATH" bash "$ACCEPTED_ROOT/herdr/release.sh" exec dispatch/dispatch.mjs --repo /OWN/CANONICAL --help
# For new authorized work, replace --help with that work's original arguments.
```

The shell uses the adjacent `herdr/releases.mjs`, even when the project pin
selects a different release. The d993883a63 verifier rejects a7b9b37dcd with
`incomplete release ...: inventory`: its caller-side inventory lacks the three
`docs/evidence/ENG-864/{r1176,sol-research,claude-research}.json` assets. The
a7b9b37dcd verifier includes them and accepts the same unchanged bundle. Changing
PATH, cwd or `HERDR_MONITOR_HOME` does not update an explicitly selected old
script's verifier. Use the accepted root's script and retain full verification;
do not alter a manifest, remove assets or retry an UNKNOWN dispatch. `--help`
is a read-only launcher check, not evidence that a live dispatch completed.
New tooling includes the invoking root and pinned script path in this inventory
refusal; it never automatically hands off to another toolchain after failure.
The already shipped d993883a63 script retains its original error. Shell `exec`
uses `node` from PATH, and its entry child uses that Node's `process.execPath`.
New tooling checks its own `.nvmrc` before selection/execution and refuses any
other version, including Node22. Prepend the saved Node20.19.4 directory as above;
the command neither discovers an alternative interpreter nor changes a saved
runtime or pin.

Focused producer selection for this change: `node test/helpers/run.mjs
test/line-service-runtime.test.mjs` and the existing `launchd uses` control in
`test/line-service.test.mjs`, through one lane check on clean committed source.
No full/default suite or reviewer suite is selected here.

### Upgrade an already migrated service, or roll back

Brain operations use these same installed-release and project-pin paths. The
retained `herdr/canary-env.sh` SessionStart entry now puts installed launchers
(`~/.local/bin`) first; explicit development source commands remain available
for engineering. Updating source does not change an existing session PATH or
authorize activation. A canonical release/adoption owner must install/accept
the chosen release, set Brain's existing project pin, migrate its controller,
and observe the next real dispatch. Until that happens, live separation is
pending. Do not edit saved controller/worker/watch paths to simulate adoption.

New command selection, installed controller admission and stopped handoffs
check the actual target fold against present core record event types. A target
without `item.acceptance-amended`, for example, refuses with
`record-incompatible` before creating a transition intent. The same check runs
inside the transition's record transaction so events arriving after preview
cannot silently become stale facts. Unknown core types and unrecognized fold
layouts refuse. Legacy protocol-1 folds use their literal event switch; no
second pin/version registry is introduced. This is a recognition check, not
proof of all event semantics. Other subsystems' opaque receipts keep their
existing readers and guards. Explicit captured continuations keep their
original root and callback; they are never reselected by this admission check.

Maintenance currently holds **control, then pass, then promotion**, with record
CAS inside those locks. ENG-1034 must retain the stopped handoff's exclusion and
final record compatibility check when replacing `pass.lock`. ENG-1038 should
observe the authorized owner's first real dispatch: installed controller
`ProgramArguments[1]`, project pin/accepted root, child `release.root/commit`,
watcher executable and original callback, plus the changed-main observation.
Scratch READY fixture input and a saved pin alone do not supply that receipt.

`upgrade` hands the controller between two explicit immutable release roots.
Both roots must be fully sealed and READY in the same installation home, and
the project's supported pin must already select the target. The command must
execute from one of those roots with this upgrade support. It requires the
owning canonical native supervisor, clean canonical main, the service's own
STOP and an unloaded job; use the existing `stop` command first. Project
STOP/HOLD and occupied control/promotion locks refuse without recovery. The
pass lock follows the same guarded, receipted dead-owner recovery as migration,
in dry-run, upgrade and rollback.
This command never changes a pin or starts a service.

After the release coordinator has qualified and installed the successor, the
project owner changes its pin through the supported pin path, then runs:

```sh
NODE=/Users/rewt/.nvm/versions/node/v20.19.4/bin/node
CURRENT_ROOT=/ABS/installed/releases/CURRENT_ACCEPTED_RELEASE
TARGET_ROOT=/ABS/installed/releases/QUALIFIED_SUCCESSOR_WITH_UPGRADE_SUPPORT
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" stop --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" upgrade --repo /OWN/CANONICAL --org /OWN/RECORD --id release-upgrade-STABLE_ID --from-root "$CURRENT_ROOT" --target-root "$TARGET_ROOT" --dry-run
PLAN_SHA256=EXACT_64_CHARACTER_DRY_RUN_DIGEST
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" upgrade --repo /OWN/CANONICAL --org /OWN/RECORD --id release-upgrade-STABLE_ID --from-root "$CURRENT_ROOT" --target-root "$TARGET_ROOT" --expected-plan "$PLAN_SHA256"
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" restart --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" status --repo /OWN/CANONICAL --org /OWN/RECORD
```

Dry-run may recover a dead pass owner with the append-only receipts described
above; it leaves runtime files intact. Apply rechecks native identity, payloads, pin, STOP,
record and saved bytes under the existing control/pass/promotion/record locks.
It fsyncs a new `upgrades/ID.json` intent before replacing the controller path
and installation source/runtime, then appends `line-service.runtime-upgraded`
with old/new roots, direction, previous event sequence and archive digest.
The original cutover, migration event and migration archive remain untouched;
the original cutoff still bounds review debt. Every later start validates the
whole handoff chain. Saved jobs, watchers, transport, Node, claims and UNKNOWN
effects retain their existing bindings. Older folds ignore the new event type.
An orphan intent, changed archive, partial write or mismatched completion
refuses replacement under both the same and another ID. Inspect the original
attempt; do not replay a native refusal or restore files by hand. An exact
completed latest-ID retry only returns its completion and never restarts.

To roll back, stop through the existing path and select the previous accepted
release through the supported pin path. Use the successor's qualified tool
again with a new stable ID, reversed roots and `--rollback` on both dry-run and
apply:

```sh
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" stop --repo /OWN/CANONICAL --org /OWN/RECORD
# The project owner selects CURRENT_ROOT using its supported pin command.
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" upgrade --repo /OWN/CANONICAL --org /OWN/RECORD --id release-rollback-STABLE_ID --from-root "$TARGET_ROOT" --target-root "$CURRENT_ROOT" --rollback --dry-run
ROLLBACK_PLAN_SHA256=EXACT_64_CHARACTER_DRY_RUN_DIGEST
"$NODE" "$TARGET_ROOT/line-service/launchd.mjs" upgrade --repo /OWN/CANONICAL --org /OWN/RECORD --id release-rollback-STABLE_ID --from-root "$TARGET_ROOT" --target-root "$CURRENT_ROOT" --rollback --expected-plan "$ROLLBACK_PLAN_SHA256"
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" restart --repo /OWN/CANONICAL --org /OWN/RECORD
"$NODE" "$CURRENT_ROOT/line-service/launchd.mjs" status --repo /OWN/CANONICAL --org /OWN/RECORD
```

Rollback accepts only the previous root in the latest completed handoff and
restores that installation/plist snapshot exactly. It records the rollback
before restoring the legacy-readable installation, so an interruption cannot
start an old runtime with an unrecorded handoff. The archives and both events
remain available. This also supports returning to the first migrated release,
which predates upgrade support. Qualification and live acceptance remain the
release coordinator's obligation; fixture bootstrap/pass controls do not
authorize a real project upgrade or count as live acceptance.

Focused upgrade selection: the runtime migration/upgrade controls in
`test/line-service-runtime.test.mjs`, `producer cutoff` in
`test/line-service-producer.test.mjs`, and `launchd uses` in
`test/line-service.test.mjs`, through one lane check using the bounded runner.

The original service cutover remains immutable. Before Phase1 activation, the
owning native supervisor records its designated intended pre-Phase0 SOURCE
boundary with the existing stopped-service helper:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/line-service/cutoff.mjs --repo /OWN/CANONICAL --org /OWN/RECORD --id STABLE_PHASE0_ID --cutover --phase0-head FULL_DESIGNATED_HEAD --evidence /DESIGNATED/PRODUCER/LOCATOR
```

This appends one `line-service.phase0` event under pass/promotion/record locks and
fresh own native/project/source guards. It never rewrites the earlier cutover or
starts a runtime. Brain's designated intended source boundary is
`ff88cae6cc7db0140debe47bc3f55fafed46d6c7`, archive
`archive/phase0-land-first-20261026-pre`, captured before Phase0 instruction edits.
The original receipt qualified the exact18:55 head as UNKNOWN. Later designated
owner evidence confirms Brain's same head at18:55 (move18:54:47), and BCH's own
`8add6fb831a20f8a2db3e91b805ea8ba83a01903` (move18:53:55). Preserve both the
original qualification and later evidence; completion measurements alone are not
an18:55 observation. Brain's SHA supplies no BCH authority. Without any valid
boundary, the installed service records its first actual clean canonical main
once under pass/promotion/record guards, with no invented historical time.

Reviews are owed for each actual landed build commit strictly after that source
boundary, including a closed item or removed producer worktree. Two Git reads
index the interval; old reports outside it perform no per-report Git, hashing or
native inventory. Canonical `rev-list` defines owed commits; immutable reports
and native landing facts attribute them. Unclaimed/unreported commits remain
visible in health and the record inbox. Immutable report bytes and original
dispatch/source attribution bind the delivered diff. Unknown attribution holds
only that review branch.
Red checks or a blocked report do not disqualify genuinely landed changed code.
Only an existing attempt for the SAME source item/head or immutable producer
item/run/report group blocks a new review.
Unrelated old private review directories do not establish an attempt. A real
same-change UNKNOWN/native refusal remains held. Routine recovery requires strict
original-request proof; a timer or missing run never establishes inactivity.

The current queue helper creates ONE ordinary reviewer item for the whole
immutable producer report/source group, keyed by its item, final delivered head
and report hash. Its explicit source/base range or captured owned commits include
intermediate and final source; interleaved commits attributed to other producers
remain context with independent coverage. It never creates a separate review for
each intermediate/final tuple in the same report. Red producer checks still
permit review of genuinely landed source. Existing partial/active/UNKNOWN
reviews, independent verdicts and cap1 remain immutable: no retarget, cancellation
or replacement. Their exact coverage is counted without claiming the whole
producer has been reviewed. Strictly later attributed commits outside every
retained capture receive one immutable `supplemental-review/v1` target through
the same record queue. Its evidence binds the prior targets, exact owned commits
and recorded landing/report provenance. Earlier captures, native attempts,
verdicts and cap1 stay unchanged. Overlap, an UNKNOWN prior scope or a gap inside
an earlier captured interval remains held; none permits a duplicate or retarget.

Commits with no recorded producer use `queue-review canonical:FULL_SHA` in the
genuine installed canonical service context. The ordinary reviewer item owns
the **current** review responsibility and references itself as its source item,
with a null source run. Its `canonical-unattributed/v1` evidence preserves null
historical item/run/owner, binds the recorded boundary and exact canonical diff,
and never emits a synthetic producer run or landing. The canonical index keeps
that historical attribution missing while counting the exact queued/verdict
coverage. Ambiguous attribution and exact-head UNKNOWN attempts remain held.
Verdicts and linked Major corrections use the existing record path and cap1;
release still requires actual Major correction checks.
Its bound immutable target/evidence is checked again before every native effect.
New source dispatch uses a registered `review-` worktree at that exact head.
Routine work uses the project's normal review selection (the portable default
is `review`, Claude Opus high), without requiring an other-family policy or a
declared producer family. Set source item `meta.judgment_heavy=true` or
`meta.outward=true` for work requiring other-family review; an explicit
`meta.review_other_family=true` also requires it. New queue items capture this
requirement, and routing also checks the source flags before dispatch.
The producer's recorded harness, or declared route when the harness is absent,
selects `selection_policy.by_task_class["review-other-family"]`: Codex producers
use `review` (Claude Opus high); Claude producers use `review-codex` (Sol xhigh).
Missing producer family, missing independent policy/route or a same-family route
refuses clearly, with no default fallback. Existing saved/native/UNKNOWN
attempts and captured requirements remain retained. Measure the share as
other-family review runs divided by review runs for explicitly classified
judgment-heavy sources; missing classification/family is unknown, never success.
The review pool defaults
to three sessions, separately from the seven-build default. An explicit
`dispatch.max_total_sessions` shared ceiling remains mandatory when configured;
otherwise the combined ceiling is the sum of the two pool limits. Legacy
combined callers retain their old bound. Old settle reviewers and uncertain
native attempts still consume review and combined capacity.
Saved owner/pinned consumers retain their original selection. A matching explicit
source selector does not fabricate native/run authority. Unknown queue/helper
capability holds before launch.
An already loaded development helper keeps its immutable target/group capability
when unrelated source files land; a global eighteen-file equality check cannot
invalidate the in-flight request. Immutable saved bundles keep their byte fence.
Matching source selection, actual run/controller ownership and fresh native,
record, target/evidence and worktree guards still precede effects. Capacity
continuations use typed original guard receipts plus positive prelaunch evidence
and fresh admission, not words such as "unknown" in another session's occupancy
diagnostics. Real native/identity/ownership refusals stay stopped. An unavailable
native-launch flag is recorded as null, never defaulted to false.

Future review errors, repeated counters and routine notices stay in the existing
`passes.jsonl` diagnostic journal and its `effects.json` checkpoint. Each key has
one cumulative count, first/last occurrence and inspection flag. A fsynced delta
precedes the checkpoint, so a lost checkpoint replays counts without replaying
native effects or claiming delivery/consumption. Historical record events and
already-recorded notice references remain unchanged. Each real pass observes
owed/queued/running/done groups, commit coverage, attribution gaps and formal-fix
exemptions in diagnostics. A queue/coverage gap after three passes sets one
inspection flag; recurrence only advances its count. `--digest --org RECORD
--repo CANONICAL` combines these diagnostics with historical record facts.
`morningDigest({events, diagnostics})` is the same read API for future consumers;
an events-only caller sees retained historical health/counters. These are
observations, never authority for a native effect or a claim of release PASS.
Only actual pending named reserved decisions use this service's record-inbox
producer and existing native decision transport. Durable intent, decisions,
claims/generations, review/verdict/report, disappearance, recovery, dedup and
effect intent/outcome facts remain authoritative record data.

Ordinary pre-effect cleanup deferrals use structured diagnostic rows in the
existing `GIT_COMMON_DIR/closeout/worker.log`. These rows suppress unchanged
evaluations across restarts. Named retry or a related record revision can request
a fresh guarded observation. They cannot establish completion, retired sessions,
native outcome, ownership or an effect's authority. Unknown/safety-sensitive
refusals, unresolved native intents, session-retirement milestones and completed
evaluations stay in the record; a diagnostic cannot replace them. Duplicate
durable refusal facts are retained once per exact source/revision/outcome.
Every actual cleanup effect still uses its fresh native/source/claim/STOP/HOLD,
archive and content guards. No extra transport, process or history rewrite occurs.

The installed service observes normal queue progress across real passes. With
unchanged source/request evidence it can archive one inactive attempt and create
one normal-route replacement, without a supervisor command. It first serializes
the ORIGINAL request under its existing lock: live/denied/unknown owners stay
held, and only the existing positive-ESRCH recovery applies. A persisted
pre-record-start protocol barrier, or an ended fully bound reviewer process plus
positive native pane absence, must establish inactivity. Working reviewers,
incoming reports, native refusals, unresolved exit intents, partial/ambiguous
producer groups, source/claim changes and STOP/HOLD all retain the attempt.
Original journals and UNKNOWN/native flags are archived unchanged, no verdict
is invented, callbacks are retained, and cap1 permits only one replacement.
Prepared archives resume with the same bytes when an unrelated service update
occurs. Neither this path nor the explicit legacy recovery launches a reviewer;
the ordinary guarded queue dispatcher owns the new worktree/session.

A positively never-started recorded queue run also has an explicit owner-only
form. This covers canonical unattributed targets and producer targets without
inventing a producer. From the actual owning supervisor's canonical checkout,
using the matching development source, run:

```sh
HERDR_BRAIN_ROOT=/actual/source ORG_DIR=/own/record node /actual/source/bin/org.mjs \
  queue-review REV-n --recover-unstarted --role supervisor \
  --resolution /own/identity/unstarted.json --decision-seq N --id STABLE
```

The resolution is an owned plain JSON file naming `review_item`, `journal`,
`journal_sha256` (the SHA256 of its complete original bytes), `head` and `base`
(the immutable review target's diff base). The scoped decision must be an actual
decision note on that reviewer item, written by the current native supervisor,
and include the stable ID, full journal path, journal SHA256 and full target HEAD.
`--role` and display labels alone supply no authority. A real preparation error
also requires `fix: {"commit":"FULL_SHA","file":"relative/source/file","why":"actual fix"}`:
the named source input must actually differ from the original captured source,
be landed in the selected current source, and still match its fixed bytes.
An elapsed typed admission-lock/capacity barrier is not a preparation failure.
Unknown errors cannot be relabeled as timeouts.

This command serializes the original request and promotion lock, freshly checks
native caller/absence, source/claim versions and item/ancestor STOP/HOLD, archives
the full request, routes, ask, evidence and driver bytes, and authorizes one
unchanged-target normal dispatch. It abandons an open original only after positive
pre-native proof; already abandoned originals remain unchanged. Explicit
`native_launch_attempted: false`, stage `worker`, and no worker, launch process,
session binding, watcher or incoming report are required. Missing launch metadata,
native refusals, started/unqualified sessions, competing saved requests and
completed verdicts retain their original hold. Original journals, claims, runs,
verdicts, review item and cap are preserved. No launch happens in recovery.

The service sees a new durable dispatch input; normal dispatch reserves that
authorization once under the record lock before saving its fresh journal. A
lost/ambiguous reservation stays occupied. For a manual normal invocation use
the ordinary reviewer route and a new `review-...` lane, with **`--base` equal
to the captured target HEAD**, not its diff base or parent. The normal request
still checks fresh native capacity, current holds and exact source at each edge.
No old journal is retried or rewritten and no second review item is created.
Retained partial scopes still require the existing exact disjoint-source guards.

Recovery archives are immutable under `evidence/review-recovery/STABLE/` and bind
their intent, subject, original request hash, source, claim generation and scoped
decision. Interrupted archival resumes only that identical preparation; another
ID or changed input retains it for judgment. They replace the former manual
abandon-then-fresh-start dead end, not the existing UNKNOWN/native holds. Removing
this source change means reverting its exact landed range in the owning project;
never remove the archive or authorization/consumption history to reset its budget.
Source/fixture success does not establish live recovery or release acceptance.

An existing pre-start partial request with disjoint immutable sibling scopes can
instead continue its ORIGINAL request, target and cap. The service records and
archives a positive serialized prestart proof; its old UNKNOWN launch flag stays
null. Current source validates the captured landed range and evidence, and
refuses overlap, changed ownership, source/evidence, native presence and HOLD.
No new review item, replacement or target expansion occurs. A completed sibling
PASS remains scoped to its own exact range. This exception is for the proven
original request only; new producers still enqueue one whole report/source group.

A recorded `worker` barrier with explicit `native_launch_attempted: false` can
also continue the original run, including a captured partial range. The current
claim generation must match the saved ownership; no recorded worker, native
process or session binding may contradict that barrier. Old implementation-change
outcomes have an exact legacy mapping to a typed outcome, never a broad text
exception or conversion of TRUE/UNKNOWN launch evidence to NOT STARTED.
An unchanged `watch` or `prompt` request can finish its first prompt through
`dispatch --retry JOURNAL --continue-review` after the installed progress path
archives `review.original-continuation`. This requires the original fully qualified
session, terminal, pane, workspace, process birth and claim, with fresh idle native
readback. Unqualified sessions, working agents, `prompting`/complete requests,
reports and ownership changes remain retained. The dispatcher rechecks the same
process/session before delivery, uses the existing watcher contract and original
callback, and never adopts, relaunches or resends uncertain input. These proofs
authorize only the original request and captured range, without a replacement.

Reviewers inspect only the immutable diff and producer evidence, with zero
suites/edits. Their normal report says `outcome: done`, `verdict: PASS|FAIL` and
uses `- [Major] path:line - explanation` / `- [Minor] ...` findings. The record
stores verdict/findings against source item/head. FAIL/Major creates one linked
engineer correction; Minor creates one follow-up. Existing engineer proposals
are preserved and linked. Corrections retain the original review and never
create a re-review chain. The current service can record these facts from
immutable already-ingested bytes even when the selected record consumer is old;
it uses its actual owned pass/installation and fresh run ownership, without
changing that consumer, a pin or the report. Major correction checks remain
required before final release.
An explicit verdict may be in frontmatter or a standalone `Verdict: PASS`,
`Verdict: FAIL` or `Verdict: NEEDS-WORK` body line, including Markdown headings.
An isolated `**PASS**`, `**FAIL**` or `**NEEDS-WORK**` is also a declaration.
Quoted/fenced examples and indented code grant no verdict;
missing, unknown or contradictory declarations hold intake. The fact records
the declaration location and original report hash; report bytes are unchanged.

An explicit review hold is a decision note on the source item or its run that
starts with `REVIEW HOLD:` (or an existing explicit hold/retained-reviewer
phrase) and names the change's full commit:
`record note SOURCE_ITEM "REVIEW HOLD: FULL_SOURCE_HEAD; reason" --decision`.
The service checks the note for each captured commit as an exact full string
(a label such as `head` may touch it; a longer hex run may not), so a hold for
another commit binds nothing. An explicit hold that names no full commit holds
its run conservatively. Other decision prose that mentions reviews, such as
"no duplicate worker/review", is never a hold. Queued/native/UNKNOWN attempts
still retain their original ownership and cap.

Each pass writes a heartbeat, ingests an actual valid report as soon as its file
exists, conditionally source-closes genuinely done integrated work, drains named
closeout keys and considers independent READY work. It does not wait for native
idle to ingest. A blocked report cannot start again until an actual note, answer,
unblock or changed brief arrives; unresolved dependencies/HOLD still refuse.

Starts use `dispatch --detach`. The original journal reserves capacity before
spawn and returns immediately; each candidate and the child perform fresh
admission/readiness checks. Foreground commands stop only for measured silence
AND confirmed inactivity of their own unchanged child; elapsed time alone and
unknown activity never authorize a signal. The eight-minute work allowance
defers new scan/cleanup work and never terminates an active child. READY admission
gets its own unchanged allowance after those stages, with a passive stage receipt;
unrelated long productive cleanup cannot use it up. Native pool limits and fresh
source/readiness/STOP/HOLD checks still apply to every new start. The two
legacy-named memory phases now pause only for a genuine live proving reservation.
Memory pressure is observed, never an admission wait. Lost launches/prompts are
retained, never resubmitted. New detached watchers record callbacks without
prompting a session; already-saved watchers keep their original recipients.
An original preflight with positively recorded `native_launch_attempted: false`
can continue through `dispatch --retry JOURNAL --continue-preflight`. The service
uses that same entry after a deterministic preparation failure, once per actual
helper capability. It preserves the request, route, immutable target and first
launch receipt, and recounts admission under the existing locks before handoff.
Missing zero-native evidence, a live/unknown native attempt, permission/identity
refusal, a different saved helper or an already spent continuation remains held.

For the explicitly authorized inactive legacy attempts, the owning native
supervisor uses the existing record queue entry from its own canonical checkout:

```sh
HERDR_BRAIN_ROOT=/absolute/shared/brain node /absolute/shared/brain/bin/org.mjs queue-review SOURCE_RUN --head ACTUAL_HEAD --base ACTUAL_BASE --recover-inactive --role supervisor --resolution /own/inactive-review.json --decision-seq OWN_DECISION_SEQ --id STABLE_ID
```

The decision is an existing normal `record note SOURCE_ITEM "..." --decision`
by that actual canonical native supervisor, recording the delegated choice and
the full source item/head. No new approval round is required. The resolution
input names the actual tuple and original evidence, never a packet/admission head:

```json
{"item":"SOURCE_ITEM","run":"SOURCE_RUN","head":"ACTUAL_HEAD","base":"ACTUAL_BASE","evidence":"/own/.org/reports/SOURCE_RUN.md","attempts":["/own/archive/original-review.json","/own/archive/original-review.log"],"inactive":{"kind":"never-created","verified_by":"ACTUAL_OWN_SUPERVISOR","reviewer":null,"evidence":"/own/archive/OUTCOMES.md"}}
```

For a recorded absent reviewer use `kind: "absent"` and its known `reviewer.pane`;
unknown agent/terminal/session values stay null. The control requires fresh native
inventory and positive pane-not-found, source ownership/clean/head CAS, exact
landed nonempty claimed source and immutable report bytes. Completed same-head
verdicts are preserved. A durable intent precedes fsynced evidence copies and an
exact-change resolution event. Originals, native intents, saved jobs and old
caps remain; at most one fresh cap1 normal-route review is queued. No boundary is
reset and no direct lane-review or native start occurs in this control. Changed
evidence/native ambiguity refuses that effect. A damaged archive cannot block
an unrelated change. Brain and BCH supervisors alone execute their own controls;
the implementation worker performs no BCH action.

Ingest and conditional close retry through their idempotent contracts. Named
closeout retries automatically on new target revisions or a pre-effect lifecycle
mutex/budget deferral with no unresolved native intent. A pre-effect changed-code
handoff retains its original requests for the next fresh drain. An unresolved
native exit/close intent resolves only from the actual original producer's exact
recorded completion. Named retry-safe drains, manual retries, elapsed time and
later service passes must neither reobserve nor resend it. A missing producer
remains an owned defect; retain UNKNOWN, the original source/intent and its
scoped failure/refusal evidence. Still-live, replaced, permission-refused or
unknown outcomes remain held. No-intent pre-effect allowance and recorded owned
stage progress are separate from resolving an unresolved native outcome.
Durable effect IDs and original bindings remain intact. Conditional source completion binds a landed cleanup request;
the executor still proves current identity, actual integration, callback release,
clean Git and archive preservation before any retirement/removal. The installed
line owns routine cleanup; competing automatic kicks/unnamed drains yield to it.
An adopted project's installed release can read its selected home policy and
bind report closeout requests while that service runs development source. These
producer and scheduler observations do not require matching code directories;
the installation's project, record, Node and service target still must match.
Named cleanup execution checks the exact service source before consuming and
again before effects. An unreadable policy or invalid installation stays held.
A closer verifies its committed import graph and main branch, so unrelated main
landings no longer invalidate it. A changed closer payload still hands off.

Routine holds and status use the existing record inbox, never session prompts.
Service and detached-dispatch foreground commands use the existing measured
no-output AND confirmed-no-activity policy, with a fresh owned birth check before
signaling only their own child. There is no 120-second elapsed execution kill or
ten-minute detached-controller stop. Unknown activity never authorizes a signal.
A retained dispatch receives read-only original-request/record outcome readback;
its original error, receipt and ownership remain. A missing run or journal never
proves zero native work and never authorizes replacement. Native ambiguity stays
with the owning supervisor; independent work continues.

An explicit owner/delegate NOT STARTED disposition can resolve one original
elapsed-stop request through the existing dispatcher. The owning canonical
supervisor records its scoped decision naming the exact item, original journal,
stable ID and full changed-source commit, then uses:

```sh
HERDR_BRAIN_ROOT=/SOURCE node /SOURCE/dispatch/dispatch.mjs --repo /OWN/PROJECT --org /OWN/RECORD --resolve-not-started /OWN/RECORD/dispatch/ORIGINAL.json --disposition /OWN/RECORD/DISPOSITION.json --decision-seq N --id STABLE --changed-source FULL_SHA --role supervisor
```

The immutable disposition data names `original_request`, `conclusion` beginning
`NOT STARTED`, and the explicit delegate `disposition`. Data alone grants no
authority. The control requires actual native caller binding and the matching
scoped decision, unchanged open/no-run/no-worker request and raw elapsed-stop
effect, fresh native absence, committed changed source, ready/unreserved item,
and an unchanged clean registered lane. Existing request serialization recovers
only positive ESRCH; live/denied/unknown owners refuse. STOP/HOLD remain fences.
It archives original bytes and records one disposition without rewriting the
original journal/effect or launching anything. Only that exact recorded input
becomes fresh for the line; the old request can never be retried. Native or
record progress invalidates the disposition instead of authorizing a duplicate.
Three occurrences of the same normalized failure create one envelope; every raw
occurrence/count is retained. A pass over ten minutes creates one record alert.
Only an actual pending explicitly reserved human question naming its decider can
use the existing one-shot native decision pointer, with the original stronger
session binding. Record errors have no native fallback.

A typed exact-target verdict completes the current review task independently
of its linked engineer corrections. The service conditionally closes that
immutable done review and publishes its ordinary closeout target, even while
its own fix proposal remains open. It never closes the source or fix item.
Missing/contradictory verdicts, ownership changes, reopened reviews, human
questions and independent blockers remain held. Retirement checks the typed
verdict/closure against the current run and retains all native occupant,
source/integration, callback, HOLD and archive guards. A FAIL reviewer may retire;
its product correction remains separately owned without a second review chain.

Physical removal seals housekeeping's actual owner files and their directory
identities, rather than unrelated activity logs or state updates. New/replaced
owners, unknown/redirected locks, target references, source/CAS changes and HOLD
still refuse; this makes no owner probe, process signal or lock recovery.

The installed line selects one least-recently-evaluated bound session request
and one independent physical-cleanup request per pass. Named `drain` supports
`--sessions-only --deadline 0`: it uses measured activity for owned commands,
records actual exit/tab-close results, and leaves worktree preservation/removal
queued separately. Zero disables the elapsed retirement allowance for exact
named targets only. A successful session phase records `sessions_retired: true`
with full physical completion still false; later cleanup never replays quit.
Each new native mutation rechecks the original source, claim, actual binding,
callback, STOP/HOLD and archive guards. Uncertain original intents remain
UNKNOWN until their actual original producer records the exact linked
completion; no named/manual retry, timer or later service pass authorizes native
readback or another exit/close attempt. Missing producers and scoped failures or
refusals remain owned and retained. Recorded session-stage progress and
pre-effect allowance with no unresolved intent do not fabricate that completion.
Evaluation timings are passive observations of real passes, not benchmarks.

`node supervisor/closeout.mjs status --owner --repo /OWN/PROJECT --org /OWN/RECORD`
is a read-only compatibility/claim snapshot. It does not acquire/recover a lock,
probe a process, drain a queue or start a successor. It reports the actual loaded
source capabilities separately from the normally selected fresh root, whose
capabilities remain UNKNOWN until that implementation executes. Pins and saved
requests retain their existing selection. Stored owner tuples and exact receipt
bytes are preserved; old evaluations, handoffs, logs and elapsed deadlines do not
establish the original consumer's outcome. Even absent locks leave that outcome
UNKNOWN. A retained original owner needs its own bound terminal/outcome receipt
and exact claim release before its owner considers a successor; this status
observation supplies no native, retry or recovery authority.

Positive post-FF `change.landed` facts also feed the existing review queue before
the producer's final report. Each immutable evidence snapshot includes the
actual native worker, current Brain claim, original dispatch, named landed
commits and their whole range at capture. A pathname, admission head or routine
phase note cannot substitute for that evidence. The ordinary queue command and
review route retain the actual selected-consumer and native-capacity guards.
There is one queue item for that producer group; an existing UNKNOWN/manual or
partial attempt still prevents another. The captured scope is never retargeted
when a final report or later source arrives. Later commits remain visible in
canonical coverage debt, without a duplicate reviewer, invented coverage or
product completion. Landing itself makes no test or final-release PASS claim.

Routine notes (including phase evidence/decisions) and notification metadata do
not make a blocked item eligible for another worker or change a saved request's
frozen readiness. Actual task/acceptance edits, answered blockers, link changes,
explicit reopening and the existing bound brief change remain genuine inputs.
If the original blocked run subsequently lands source, that recovery keeps its
ownership until an explicit item reopen hands the remaining scope back. A phase
PASS is not a done report. Every pre-effect check still refuses real task,
ownership, native, STOP/HOLD or source changes. Already-started uncertain jobs,
their claims and watchers remain retained; this adds no retry or NOT STARTED
disposition and does not mutate an earlier immutable report.

Each hold fsyncs a compact notice delta to the existing pass audit. Full effects
snapshots are checkpointed at stage/pre-effect and final boundaries, rather than
once or twice per historical hold. First review errors and their one record
inbox envelope share a transaction. Repeats add no per-key event: each batch
writes at most one `line-service.review-error-counts` event with the new
cumulative counts. An older journal row that cannot prove its boundary is kept,
counted as `review_error_unbound` in pass timings and skipped; it never fails
the batch.
The digest counts occurrences across these checkpoints, retaining older events.
A lost checkpoint replays only exact validated notice deltas and stable message
IDs, never native effects or launches. Every new record mutation still checks
the actual installed service/pass ownership. Passive pass timings include full
journal write counts, notice attempts and counter batches; no extra benchmark,
watcher or elapsed worker stop is needed.

Producer validation receipts are distinct from independent review attempts.
Only source-bound lane-validation identities (including red or unrun truth),
exact existing foreign review/closeout record copies, and read-only diagnostics
linked to that positive producer evidence receive that distinction. The actual
native landed worker/claim binds their source. Unrecognized/manual receipts,
native/qualification/stage markers, changed proof bytes and actual launch
journals remain held; a receipt name, later HEAD or claimed green is insufficient.

The existing supervisor-bound `queue-review --recover-inactive` accepts
`--predecessor-preparation UNUSED_ID` for one exact archive-copy input correction.
It requires the same actual canonical native caller, identical source tuple,
original decision/intent/archive, and a newer scoped decision linking both IDs
and the old intent. Every old attempt byte must be represented by the corrected
original named settle files. The old preparation must have no completed review
or effects, and another preparation cannot claim its one replacement budget.
Both decisions and all old bytes remain immutable. Dedup exempts only these two
validated authorization notes; new independent holds, actual UNKNOWN/native
progress, completed verdicts and archive/source/claim/CAS changes still refuse.
There is no native launch in recovery, and no callback/journal/report rewrite.

```sh
node line-service/line-service.mjs --digest --org /OWN/RECORD --since 2026-10-27T00:00:00Z
```

The morning digest derives landings, verdicts/findings, holds, idle hours and
build-to-main minutes from record facts. New own lane promotions record their
actual post-FF time under fresh native/claim/source CAS. Historical containment
observations have `landed_at: null`; incomplete idle intervals stay UNKNOWN.
The service directory retains `passes.jsonl`, `effects.json`, `heartbeat.json`,
installation, STOP and original native output. Pass timings separate record/scan
cost from effect command time; they are passive next-real-pass observations.

After three completed passes with ready non-review work and no productive native
engineering, the same line files and immediately admits one ordinary halt-repair
engineer. `HERDR_LINE_HALT_PASSES` sets a positive completed-pass threshold. A
retired automatic judgment without its exact-input saved dispatch effect is not
admissible work and does not count toward an idle episode; its record and original
attempt remain intact. Observation and the repair-intent recheck use admission's
same judgment policy. They also defer obsolete closeout outcome decisions using
admission's queued cleanup observation before computing dispatch input; current
cleanup defects remain eligible. A detached acknowledgement or unrelated review does not
reset that count. Native engineering progress, an observed productive engineer,
or changed ready/hold/
routing inputs resets the episode. Counters and full item/report/hold observations
remain in the diagnostic journal; only the repair intent enters the record. Pending, working,
held and uncertain repair owners exclude another repair; completion permits a
new owner only after changed inputs and another counted stall. Actual admission
still uses the existing capacity, native, ownership, reserved and STOP/HOLD gates.

An exact retained missing-supervisor-address error from before journal allocation
may recover once when its current execution contract validates. The original
failure remains intact and links its new effect. Missing journals alone never
qualify. Older installed record renderers receive the validated saved/recorded
execution contract at dispatch; partial or changed contracts still refuse and
the original rendered brief is archived beside the run. No installed pin changes.

The focused Phase1 selection uses the existing runner, core files together and
dispatch files separately (at most four per group):
`test/line-service-phase1.test.mjs`, the `phase1` control in
`test/closeout.test.mjs`, and `dispatch/test/phase1-starts.test.mjs`.
All are discovered by the next full release. Run once through lane check on the
clean committed candidate after self-landing; no full/default/reviewer suite.
One independent async post-code review per landed change remains nonblocking.

Supervisor-herdr owns proof-based go/no-go and plain Git revert of the listed
Phase1 commits if it freezes a line or stops landing. The current
`OVERNIGHT-GUIDELINES-20261026.md` supersedes the narrower overnight plan; quiet
chat is the operator delegate, and the existing watcher remains the only one.
Fix local non-fence blockers in the same run, change approach after two or three
failed attempts, and leave new discoveries for morning. There is no ACK or
22:00/23:00 deadline wait. The pre-source archive is
`archive/phase1-land-first-20261026-pre` at
`f1a4abc30d3b08d2887612f19946c165603db43d`. Use ordinary `git revert` on the exact
newest-first Phase1 commit list, preserving record evidence; the older narrow
launchd revert allowlist is not this rollback entry. The last-good code stays
live if proof fails. Public, mainnet, secrets, other-identity files and unarchived
work stay fenced. The release coordinator retains the final full-release and
adoption obligations.

## Finite report and closeout turns

Each `closeout.evaluated` now carries independent `resources.session`, `.folder`
and `.branch` dispositions. Only exact `closeout.effect` receipts establish
`closed`, `removed`, `deleted` or `retained`; `absent` is a current allocation
observation and never an exit-command success. `kept` includes scope, reason,
evidence, owner, first_seen, continuation and escalation. `author_packet` names
the preserved report packet or remains `unproven`. Item/review completion and
source versions cannot supply missing effect receipts.

`condition` (`closeout-condition/v1`) distinguishes contention, active-process,
dirty-work, pre-effect-budget/change, missing-identity, safety-hold, native-refusal,
legacy-refusal, uncertain-invocation and owner-evidence-required. The finite role
can freshly observe ordinary pre-effect conditions with the original guards.
Unresolved native/Git invocation and actual refusal do not enter that path.
New native intents name `producer: native-closeout/v2`; their terminal effects
must link the exact `intent`. Original completion or the existing admitted
never-started bridge resolves uncertainty. No force-kill, expiry or absence
supplies that proof. Report prose never supplies a native refusal. Historical
recorded prose holds and structured refusals retain their original owner.

Unchanged kept dispositions deduplicate. After three no-progress finite turns
or thirty minutes, one grouped `closeout-supervisor-alarm` in the existing
service `closeout.log` identifies counts, oldest scope and original-owner routes.
Unchanged alarms do not create more decisions or retry native effects. The
checkpoint counts observation turns only; neither count nor age grants authority.
Binding transactions fence semantic Git identity/ref results. Removal still
checks target index/generation, effective Git policy, actual loaded source,
preservation, STOP/HOLD and main CAS under the existing lifecycle lock; unrelated
main index/config activity is outside that footprint.

The existing installation's `--once` entry first runs bounded report ingest and
closeout, then starts (or finds) the ordinary finite general-pass child. Its
existing launchd interval therefore continues waking while a slow review owns
`pass.lock`. Startup and each scheduled wake reconcile committed run/report
sources; no second launchd job, saved watcher replacement or core loop is needed.
The wake probes `pass.lock` through the same notice-lock owner guard as the pass,
recording fsynced `line-pass-lock-recovery/v1` intent/completion rows before and
after recovering an exact dead owner. Live or unidentified owners stay held;
heartbeat age grants no authority to stop or replace them.
The new `line-service/closeout.mjs --once --repo ... --org ...` hint entry delegates
to the same role. Both use the birth-aware `closeout-turn.lock`; the existing
closer still owns its consumer and retirement locks and every native/Git effect.

New original watchers publish `record report-available --run R-n --sha256 HASH`
after validation, ahead of waiting for idle. That commits a source hint before
waking the finite role; report availability itself grants no retirement authority.
Lost hints, spawn replies and ingest acknowledgements are repaired by the next
finite reconciliation. `closeout-turn.json` checkpoints a selection before its
command and a continuation before acknowledgement. The default turn selects at
most eight reports and eight closeouts with its own 720-second allowance;
native drains receive the remaining deadline. Least-recently-selected targets
run first, including after a crash. A kept target yields to independent peers.
Original UNKNOWN/refused commands remain governed by their original record facts.

An ingested report's original watcher can remain alive while its final notice
waits for supervisor input. That transport wait does not retain the finished
worker allocation once its claim-bound watch receipt names the original final
ID in the ordinary inbox and that inbox records acknowledged transport ownership
for the same project, record and run. The source-bound closer omits only that
synthetic watcher reference. It leaves the watcher, inbox bytes, recipient and
delivery attempt untouched. Worker/pane continuation recipients, uncertain or
refused input, unknown watcher liveness and missing/redirected handoff evidence
keep the reference. Real process cwd references, native callback occupants,
unsaved changes, source/claim checks and all other retirement guards still apply.
Review and correction obligations stay in the record after allocation release;
the closer never waits for a review verdict to close the author session.

The exact historical pre-journal release-source override refusal can be admitted
once when an accepted release no longer supplies that override. The original
terminal receipt survives, and `line-service.dispatch-readmitted` binds the new
intent to the zero-launch proof. Journals, launched workers and other uncertain
outcomes never qualify. Logical source completion may use a full immutable report
range or its native landing after the folder is gone, with fresh canonical
containment and conditional current-run/report guards. Typed pre-command holds
are reconsidered against current source; a refused or unknown close stays owned.

A missing folder with a surviving fully bound original native tab can receive an
`absent-allocation-native/v1` cleanup scope. The existing retirement planner and
executor still check native/process identity, claim, report, focus, references,
STOP/HOLD and original uncertain/refused effects. This scope closes only the
original native allocation and grants no Git disposal or preservation proof.
The ordinary vacancy census settles remaining absence separately.

Final reports and authorized abandonments bind their original run/claim, dispatch,
launch receipt, common directory and worktree/branch generation in the source
transaction. Missing allocation or native identity produces a typed binding
exception. A timely saved Codex observation may append after finality, without
renewing its window, and complete an unattempted empty binding only when the
original allocation still matches. Existing effect attempts never acquire a new
source opportunity. Fresh effect checks retain current-run/report hash, claim,
source/epoch, native session/terminal/pane and STOP/HOLD checks.

A failed dispatch records its original terminal result; prompt-not-sent alone
leaves a typed nonfinal exception. Explicit
`dispatch/dispatch.mjs --retry R-n --abandon --abandon-reason TEXT` lets that
original producer commit authorized abandonment only with positive pre-native
or bound unprompted evidence. Uncertain launch/delivery stays retained. New
allocation uses the same birth-aware retirement exclusion. These source changes
do not restart an installation, change pins, release, or prove live latency.

Delivered source carries `brain.dispatch-source/v1` in the existing post-FF
receipt: actual Git common directory, owning record, original dispatch attempt,
workspace, run, claim generation and immutable landing base/head. Self-landing
compares the immutable dispatch binding under the existing native/claim fence.
No report, test or review readiness requirement is added to landing.

The `brain.delivered-source/v1` read projection labels each claimed report range
`covered`, `external` or `unknown`; `none` means no code delivery is claimed.
Only matching typed guarded receipts cover a range. Hash containment, a matching
remote and a clean original allocation do not prove the producing repository.
An optional `source: HEAD; base: BASE; repository: /absolute/source/path` artifact
retains an external repository explicitly; that text cannot grant coverage.
Every additional explicit commit claim is checked too. Reports remain ingestible,
and report-closeout evidence keeps the classification and original owner without
blocking the independent guarded resource-cleanup path. A post-FF receipt failure
keeps the actual Git landing with coverage/timing unknown; it never replays FF.

Canonical diff review and guarded source coverage are separate facts. New review
targets/verdicts carry source provenance, unknown claims do not create a
`change.landed`, and external ranges stay held with their evidence and owner.
Review health exposes `guarded_commits` and `uncovered_source` independently of
diff-review totals. Existing immutable captures/receipts are retained without
historical reattribution. Source completion holds external/unknown claimed ranges;
planning reports need no synthetic source receipt. Release coverage remains the
release coordinator's responsibility.
