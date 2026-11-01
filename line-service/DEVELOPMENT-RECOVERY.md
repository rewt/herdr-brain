# Initial Brain A3 recovery

This extends the existing Brain-only probation authority with a typed
`development-recovery` predecessor. It does not issue READY, a project pin, a
consumer offer, or a consumer adoption exception. The ordinary installed-root
A3 authorize/upgrade/rollback path remains supported.

Only the actual clean canonical Brain product source can issue the initial
authority, and only its recorded native `promote.to` supervisor can operate it.
The original development installation and cutover must still match. Project
STOP/HOLD, the service's own STOP, positively absent native job, original record,
pass/control/promotion locks, source/native/record CAS and record compatibility
are checked at effects. None of these commands stops or starts a native service.
The supervisor performs those separately at its authorized safe boundary.

The immutable recovery payload is derived from committed product inventory,
including data, executable modes and every required runtime module. Brain is
dependency-free. Its pinned Node executable remains installed at its original
absolute path; its bytes, version, platform and architecture are bound and
rechecked. Recovery does not read mutable canonical product files. Source
commit/tree/common directory, full inventory, manifest digest, original
installation/plist bytes, original cutover, and separately derived recovery
installation/plist bytes are retained in the original trial's scope/archive.
The recovery root is derived under the owning record's service directory; a
label, environment selector or consumer configuration cannot nominate it.
Payload files and directories are read-only, separately copied without links.

The old cdaf bundle cannot consume this protocol. The release/canary owner must
seal and record a successor containing these readers on ENG-1170 and obtain its
exact installed Layer 1 canary. Predecessor evidence is not successor PASS.

## Authorize without changing the controller

The examples use pinned Node and absolute, exact roots. Substitute the real
successor and original trial ID. `BRAIN_RECORD` is the discovered Brain record.
All decision notes use the existing recorded supervisor actor and owning R2
item. Copy each returned `required_decision` verbatim, retaining its actual note
sequence; do not compute or invent an authority string.

```sh
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-authorize --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --development-recovery --from-root "$BRAIN_SOURCE" --target-root "$CANDIDATE_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-authorize --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --development-recovery --from-root "$BRAIN_SOURCE" --target-root "$CANDIDATE_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
```

Preview returns `plan_sha256`, `scope_sha256`, `required_decision` and the full
`scope.previous`: `kind`, `release.root` (save as `RECOVERY_ROOT`), source
commit/tree/files, `inventory_sha256`, `manifest_sha256`, Node SHA256,
`original` and `derived`. Apply returns `authorized`, the immutable authority
archive file/SHA256, exact candidate, `runtime_started:false` and
`stable_ready:false`. The archive and sealed payload precede the authorization
event. A failed seal leaves its original intent; no replacement trial or replay.

## Entry, recovery and return within the same trial

Each switch is its own explicit stopped effect, with a fresh preview, its exact
recorded decision, and an immutable unique effect ID. The initial switch must
be development -> candidate. Later switches alternate the exact candidate and
recovery roots. No replacement trial is needed or allowed for the drill.

Entry, after supported stop and successful original authorization:

```sh
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id initial-entry --from-root "$BRAIN_SOURCE" --target-root "$CANDIDATE_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id initial-entry --from-root "$BRAIN_SOURCE" --target-root "$CANDIDATE_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

After observing the actual installed pass and preserving controller/child and
callback provenance, the supervisor separately stops the candidate. Recovery:

```sh
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" stop --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id recovery-drill --from-root "$CANDIDATE_ROOT" --target-root "$RECOVERY_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id recovery-drill --from-root "$CANDIDATE_ROOT" --target-root "$RECOVERY_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

After observing the actual recovery-runtime pass, return:

```sh
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" stop --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id candidate-return --from-root "$RECOVERY_ROOT" --target-root "$CANDIDATE_ROOT" --dry-run
"$BRAIN_NODE" "$BRAIN_SOURCE/bin/org.mjs" note ENG-1170 "$REQUIRED_DECISION" --decision
"$BRAIN_NODE" "$RECOVERY_ROOT/line-service/launchd.mjs" probation-switch --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --trial "$TRIAL_ID" --id candidate-return --from-root "$RECOVERY_ROOT" --target-root "$CANDIDATE_ROOT" --authority "$DECISION_NOTE_SEQ" --expected-plan "$PLAN_SHA256"
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" restart --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD"
```

Switch preview returns `plan_sha256` (also `archive.sha256`), `scope_sha256`,
`recovery_sha256`, exact `runtime`, and `required_decision`. The recovery digest
binds the entire typed predecessor, including original and derived bytes. Apply
returns `switched:true`, original `trial`, effect `id`, immutable archive file and
SHA256, the two scope/recovery digests, `stopped:true`, `runtime_started:false`.
The `line-service.probation-switched` completion event links the decision,
previous history sequence and exact roots. The archive precedes every config
write. Incomplete/UNKNOWN effects fence all IDs and startup, including original
development startup when the first switch did not finish. No hand restoration,
root/pin edit, automatic repair, native replay or replacement authority is used.

## Withdrawal, preservation and handoff

The trial's authority-owning item stays open until `probation-complete`, even
after its implementation report or live witness is done. Authority recorded on
a run belongs to that run's item. Record close/drop and hold/reserved changes
that fence this owner (including its ancestors) are refused while the trial is
active; the refusal names the trial and the supported `probation-withdraw` /
`probation-complete` commands. This leaves the item and trial admission intact.
Do not close the item to end a trial: withdrawal/completion is a separate action
of the recorded native supervisor. Withdrawal is the failure-containment path;
completion is the normal end after accounting for the trial.

```sh
"$BRAIN_NODE" "$CANDIDATE_ROOT/line-service/launchd.mjs" probation-withdraw --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID"
```

Withdrawal closes new controller/worker admission for this trial; captured
workers, watchers and review consumers retain their original root and callbacks.
It does not stop a service, cancel work or rewrite any saved job. A stopped
switch to recovery may still contain a withdrawn trial, but withdrawal does not
authorize a fresh recovery restart or candidate return. Perform the deliberate
restart/pass/return drill while the original trial is active. On a real failure,
withdraw and route the original exception to its supervisor; never replay a
refused native effect. `probation-complete` ends the exception only after the
owner accounts for the trial. Ordinary qualified pin admission remains separate.

Live successor canary, installed pass, recovery restart/pass and candidate
return remain UNRUN by the implementation engineer. Fixtures prove mechanics,
not real recovery. Supervisor-herdr owns those live effects and exact R2
receipts; supervisor/A4 own R3 (>=10 units, >=90 minutes, shared mode OFF), and
the coordinator owns any later exact-candidate consumer offer. Full coverage
remains actual background evidence or explicitly UNRUN.
