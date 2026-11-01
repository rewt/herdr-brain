# One successor under the original Brain trial

This implements DEC-466's `probation-successor` preview/apply interface. Only the
actual recorded canonical native supervisor can execute it, from clean canonical
Brain main. It performs stopped configuration handoffs; every result declares
`runtime_started:false`, `stable_ready:false`. No trial, pin, READY, consumer
offer, shared mode, saved job, watcher or review callback is replaced.

Supervisor-herdr owns all real activation and R2 evidence. The release/canary
owners must seal a NEW exact candidate containing this protocol and ENG-1307.
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
# NEXT_ROOT must be the future exact immutable protocol-bearing release root.
# Do not substitute current, main, cfc, or a newly rebuilt recovery.
```

First use OLD_ROOT's existing supported stop and `probation-switch` to establish
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
