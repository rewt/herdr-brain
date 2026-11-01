# One successor under the original Brain trial

This implements DEC-466's `probation-successor` preview/apply interface. Only the
actual recorded canonical native supervisor can execute it, from clean canonical
Brain main. It performs stopped configuration handoffs; every result declares
`runtime_started:false`, `stable_ready:false`. No trial, pin, READY, consumer
offer, shared mode, saved job, watcher or review callback is replaced.

Supervisor-herdr owns all real activation and R2 evidence. The release/canary
owners sealed the exact candidate `rc-20261101-ab671e8986` containing this protocol and ENG-1307.
`rc-20261101-cfc359b946` cannot gain these readers; its R-1767 evidence remains
historical. A4 owns the new exact-candidate R3 window after real return. Keep
ENG-1170 open and respect its own and ancestor HOLDs throughout the trial.
Only after recording actual installed/recovery/return witnesses may the
supervisor remove ENG-1171's completion dependency on ENG-1170. This interface
does not do that, install a release, or authorize a native start.

Use these exact tool roots (the commands below implement supervisor-steps.md):

```sh
BRAIN_NODE='/Users/rewt/.nvm/versions/node/v20.19.4/bin/node'
BRAIN_SOURCE='/Users/rewt/development/rewt/herdr-brain'
BRAIN_RECORD='/Users/rewt/development/rewt/.org'
OLD_ROOT='/Users/rewt/.local/share/herdr-monitor/releases/rc-20261031-d3271f06ef'
RECOVERY_ROOT='/Users/rewt/development/rewt/.org/line-service/c8b8479c34b7b676f466/development-recovery/r2-20261031-d3271f06ef/runtime'
TRIAL='r2-20261031-d3271f06ef'
NEXT_ROOT='/Users/rewt/.local/share/herdr-monitor/releases/rc-20261101-ab671e8986'
# Do not substitute current, main, cfc, or a newly rebuilt recovery/candidate.
```

The initial protocol below is historical reference: entry and completed rollback
already exist, including rollback event 64589 and its clear receipt. Do not
repeat either effect. Continue the existing return with the DEC-476 handoff
below. For a fresh authorized fixture, first use OLD_ROOT's supported stop and `probation-switch` to establish
the original recovery anchor, as specified in DEC-466's supervisor handoff. Each
preview's `required_decision` must be recorded verbatim on ENG-1170 with the
actual supervisor actor, retaining its returned note sequence. Keep the genuine
service STOP and wait for pass, command and promotion owners to finish. Observe
the actual original sealed recovery's restart/pass, then stop with its own tool.
An existing or UNKNOWN attempt is retained, never replaced with another ID.

All NEW successor handoffs run from canonical BRAIN_SOURCE, including rollback
while NEXT_ROOT is installed. Preview is read-only apart from existing locks
and any positively proven lock-recovery receipt. Apply requires the exact
unchanged preview digest and recorded decision, including unchanged source,
record (apart from that one decision), native identity, STOP, config and history.

```sh
cd "$BRAIN_SOURCE"
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-entry --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-entry --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$NEXT_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

The supervisor records actual installed controller/child provenance and a
comparable subsequent warm pass with admission reuse. Stop via NEXT_ROOT before
the deliberate recovery leg. Obtain fresh preview/decision values per leg:

```sh
"$BRAIN_NODE" "$NEXT_ROOT/line-service/launchd.mjs" stop --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-recovery --from-root "$NEXT_ROOT" --target-root "$RECOVERY_ROOT" --rollback --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-recovery --from-root "$NEXT_ROOT" --target-root "$RECOVERY_ROOT" --rollback --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

Observe a real pass from the ACTUAL unchanged sealed recovery and its original
Node tuple. After its supported stop, return to the SAME successor extension:

```sh
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" stop --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-return --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-return --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$NEXT_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

Preview returns `required_decision`, `plan_sha256`/`archive.sha256`, immutable
`extension`, original `scope_sha256` and `recovery_sha256`, full
`successor_scope` and exact runtime. The scope binds original authority sequence
and archive, recovery digest, candidate commit/tree/common, manifest and frozen
validation digests (including its inventory), plus the original pinned Node's
bytes/version/platform/architecture. The effect plan also binds committed source
inventory, policies/config bytes, native owner, complete record snapshot,
previous history sequence, service absence and STOP. Apply returns those
digests and `switched:true`, `stopped:true`; it starts nothing. Re-preview after
unrelated record movement; do not reuse a stale decision or plan.

The original probation note/archive/scope/recovery payload never changes. The
first new effect writes `probation-successors/TRIAL.json` and its separately
archived exact effect under `probation-successor-effects/ID.json`. Completion
records append `line-service.probation-successor-authorized` (once) and
`line-service.probation-successor-switched` (per leg). New admission names this
exact extension and original trial; captured workers keep their own root.
Withdrawal/completion of the original trial closes new admissions and preserves
captured work. Perform the deliberate drill while authority remains active.

Before the first intent or config write, each effect writes an immutable
`.successor-ID` compatibility fence in the existing `probation-switches`
directory. The OLD reader's exact inventory check refuses startup on that extra
file. The NEW reader independently verifies every intent, completion and fence;
an incomplete intent fences every replacement ID and startup. New event names
are ignored by the old aggregate fold; actual old record compatibility is still
checked at effects, so new incompatible events refuse restoration.

Successful rollback restores the exact legacy anchor installation/plist bytes.
After its completion is durably recorded, the canonical command writes an
immutable `probation-successor-clears/ID.json` receipt retaining all fence bytes
and their completed rollback sequence, then clears only those deliberate fences
under the original locks and fresh guards. Authority and effect archives remain.
Thus the OLD sealed reader can execute its original history without knowing
successor event types. A fault before completion or during cleanup remains held
with original evidence; no replay, archive rewrite, hand deletion, replacement
ID, alternate identity or new trial is supported. Route that original exception
through the recorded project supervisor inbox. A native refusal stops its effect.

Isolated producer controls exercise old-reader startup, rollback/return and
refusals. They are not a real installed canary, warm-pass/soak or release witness;
those remain with the existing supervisor, canary, A4 and release owners.

## DEC-476 target-capability admission and the existing return

`lib/record-compatibility.mjs` recognizes the actual state switch, exact delegate
import/tail and obligations map. `lib/obligation-capabilities.mjs` identifies
reviewed helper bytes by SHA-256, without importing/evaluating target code:

- Legacy `8f4e3cc3ce09ebf632d5a21b0eda28edf505e556480cb5044cf849e02d2b04f0`
  in the unchanged sealed recovery and exact ab671e8986 successor.
- Current `7d96691e48bcb8fbf1096a99a204c4284e6cec89847198646587870af8911b6e`.

Every present event separately requires its named handler, conditional report/
source completion, dispatch/review metadata, closeout target/binding-error
payload, native intent/result or generic pending/waiting/requested retention
capabilities. Completion requirements apply without an open row. Generic
unsupported retention cannot satisfy a specialized contract. A digest never
admits every record. Unknown source or a missing capability refuses the first
offending sequence before intent/config/native or selected-command effects.
Unknown core cases, malformed wiring/layout, missing helpers and torn tails
retain their refusal; opaque non-fold receipts remain readable. Iterable/file
admission uses bounded per-event scratch maps including items; it never builds
a second full record state. The local pure delegate remains a coverage backstop
even before its canonical source digest is registered. An unclassified obligation
touch refuses at its first sequence; canonical byte changes alone do not revoke
frozen target profiles. Explicit requirements remain the capability oracle.

The shared capability set is a reviewed admission floor, not verification of
identical per-contract reconciliation. In particular, legacy `source.state/v1`
does not reconcile source completion on `item.closed`/`item.reopened`, and legacy
`closeout.evaluated/v1` does not link parent evaluation to wait completion. These
are accepted compact-status differences, not capabilities verified in that helper.
The floor is retained event/payload reading and original claim/source/intent/
outcome identity, not identical compact inventory status. The legacy helper can
leave a superseded report draft supported, retain a stale review diagnosis,
finish a worker-report wait before its parent observation, leave native waits
pending after disposition, or show a historical close as supported. Current
5e842b8e/a84da588 reconciliation differs. Neither index authorizes effects or
retry, infers conditional closure, rewrites the first original result, removes
a native refusal, or replaces UNKNOWN. Report intake, queue-review, conditional
close and the original closeout/native validators still decide their effects
from original facts. A genuinely incompatible/unsafe contract must refuse and
go to supervisor-herdr, not gain a capability to make a positive control pass.

Producer maintenance: compatible helper implementation changes may add a
reviewed exact source digest/profile while retaining old profiles. Requirements
are independent of the old profiles' fixed capability sets. New incompatible
event/payload semantics add an explicit requirement (including selectors on
existing event names); only reviewed compatible targets gain that capability.
Update the focused controls with each contract. Do not normalize executable
differences, trust a version/export, or use generic map touches as the oracle.
No new event version, manifest protocol, loop or policy layer is introduced.

This shared seam is also candidate-read code and will ship in future candidates.
The current return uses the repaired **canonical tool**; it needs no rebuilt
candidate or recovery: each unchanged frozen reader compares its own legacy
helper to matching frozen roots. The focused OLD lifecycle runs actual archived
ab671e8986 reader/service code after canonical helper bytes move, as well as the
original OLD recovery's own startup. A second lifecycle covers current profile
bytes. These synthetic controls do not establish the real live return or soak.
Successor entry and return now use `probation-successor-capabilities.mjs`'s
source-verified `successor-reader/v1` profiles instead of comparing six files
with moving canonical bytes. The frozen ab671e8986 protocol and the G2 repair
are admitted implementations of the same original-authority/history, UNKNOWN
fence, stopped-runtime and completed-rollback-clear contract. Unknown target
source refuses before effects; target code and self-declared versions are never
used as proof. Compatible revisions require a reviewed fingerprint addition,
retaining old profiles. This is an admission floor, not new effect authority.
Profiles carry separate effect, fence and history capabilities, checked against
canonical writer requirements before entry/return effects. An incompatible
writer contract must bump its requirement before shipping, without upgrading
retained profiles; a compatible implementation adds a reviewed fingerprint.
`lane check` warns with the canonical fingerprint when its profile is missing
or lacks a writer requirement, independently of the selected tests.

Rollback skips candidate reader capability admission: it restores the verified
original recovery without starting the candidate. Exact tuples, manifest and
payload integrity, ancestry, record compatibility, native ownership, STOP/HOLD,
history and preview/effect CAS still apply. The focused lifecycle controls move
all six canonical protocol files after sealing both roots, then exercise entry,
rollback and exact return; a sealed incompatible candidate refuses. A separate
control changes the writer's required effect contract after entry: rollback
succeeds, return refuses without effects, and restoring the compatible writer
requirement permits exact return.
These fixture observations do not prove a live canonical rollback preview.
That stopped-service witness remains UNRUN here and belongs to supervisor-herdr
at its separately authorized safe boundary; this repair switches no service,
pin, offer or runtime.

The exact supervisor handoff remains
`.org/evidence/DEC-476-R-1799/supervisor-steps.md`; source-verified profile and
writer-requirement admission supersedes its step 1 condition that all six
canonical source hashes must match the exact ab671e8986 bundle, while both
frozen roots remain unchanged. After consuming the engineer's
landed range/evidence and retaining the single asynchronous record review,
supervisor-herdr alone continues `dec466-successor-return` under active,
unheld ENG-1170 and trial `r2-20261031-d3271f06ef`. It owns the separately
authorized safe boundary: recovery's own stop, in-flight owner drain, fresh
positive native service/job absence, STOP/HOLD/config/source/record/history/CAS
checks and original-ID inspection. Preserve the original pre-effect failed
preview `.org/evidence/R3-SUCCESSOR-20261101/13-return-dry.json`, R-1796's refusal,
completed rollback and clear receipt. If any completed/failed/partial/UNKNOWN
return attempt now exists, stop and route it; do not replace its ID or executor.

From clean canonical source and the actual native supervisor session, using the
variables above (these are supervisor-owned commands, UNRUN by the engineer):

```sh
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" stop --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
cd "$BRAIN_SOURCE"
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-return --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --dry-run
# Capture actual plan_sha256 and required_decision; copy the latter VERBATIM.
HERDR_BRAIN_ROOT="$BRAIN_SOURCE" ORG_DIR="$BRAIN_RECORD" ORG_ACTOR='supervisor-herdr' "$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-successor --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL" --id dec466-successor-return --from-root "$RECOVERY_ROOT" --target-root "$NEXT_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$NEXT_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

Require the actual preview's extension
`77dae47e855010824f1746de711dc3b6bcdedcfde58736cecaf425823fafda3d`, original scope
`4f9df60c86b89b7088a6952edb649735163fbb845cd949d9987c7e9571a56d8b`, recovery digest
`8c2ac36fabdd5b03f8028d50f598520b36ad6e49377520f8536cb32a174887b7` and exact runtime
`ab671e89865ccf85d6d7d6d410688703d019d8ca`. Capture actual authority sequence and
unchanged plan; unrelated record movement invalidates the preview. A started
apply's refusal/failure/UNKNOWN preserves that original fence, with no blind
re-preview/reapply. Successful apply starts nothing. Restart through the exact
installed reader, then record actual controller/child/root/Node/trial provenance,
ordinary pass-complete and comparable second warm pass with admission reuse.
Record live receipts once on ENG-1319/ENG-1170 and repair evidence on ENG-1321.
Unsafe/native/identity/ownership/reserved/failed exceptions use the owning run's
durable project-supervisor inbox before native input; refused/uncertain input
does not replay. Keep watchers, jobs, archives, pins and callbacks intact.

Supervisor/A4 retain the new exact-candidate R3 window (at least 90 minutes and
10 genuine units, including 3 source units and 2 capacity turnovers, evaluator
after cutoff). Shared mode remains OFF/UNRUN. Major corrections, installed
canary, final coverage and offers/adoption retain their existing owners. No
live preview/apply, candidate pass or soak is implied by this implementation.
# Recovery admission visibility and candidate ceiling

Each general pass records `recovery-admission` in its existing `passes.jsonl`
for active probation recovery roots. A refusal records
`recovery-admission-supervisor-alarm` with the root, trial and original reason
before runtime/STOP/HOLD guards can refuse the pass. This is visibility only;
it does not restart, switch, repair a root, send native input or waive a guard.
Ended and foreign trials are excluded. A later compatible observation records
admission again. Frozen installed roots acquire this observation only in a
later separately installed candidate; landing source alone does not install it.

Probation authorization, development entry/return and successor entry/return
compare the entire candidate fold contract with recovery, even when no current
event exercises an extra case. Reviewed obligation profiles retain their fixed
capability floor. Unknown helper bytes or requirement selectors require review;
candidate code is never executed to infer its contract. The selector digest in
`recoveryContract` identifies the reviewed DEC-476 requirement floor, not an
automatically growing grant to old roots. This conservative reader comparison
cannot prove every producer write; the per-pass record observation remains needed.

Excess refuses before an intent is written. The error supplies an exact
`Brain recovery contract excess accepted: DIGEST` decision text. Any exception
requires a separate `note.added` decision by the recorded native supervisor,
with its owning item/run still admissible, passed as `--recovery-authority SEQ`
to the existing probation command. Ordinary effect authority is still required;
it cannot acknowledge excess implicitly. The extra decision and excess are
captured in the immutable effect archive. Existing record incompatibility still
refuses even with this acknowledgment. Rollback never requires this candidate
ceiling acknowledgment, and all original native/source/STOP/HOLD/CAS guards stay.
No new event type, required capability, service or release authority is introduced.

