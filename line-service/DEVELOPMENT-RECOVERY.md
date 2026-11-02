# Initial Brain A3 recovery

For a later exact candidate under the SAME original trial, use the connected
[successor protocol](PROBATION-SUCCESSOR.md). It retains this sealed recovery
unchanged and uses the new canonical tool for successor effects. Frozen trial
and recovery tools do not acquire the new parser or history reader.

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

```sh
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-complete --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --dry-run
```

Ordinary completion and withdrawal on corrected source require a READY explicit
project pin selecting the settled installed root, compatible records and valid
installation/plist history. A preview refuses before ending the trial if that
continuation is absent; a successful preview changes no authority. Apply the same
command without `--dry-run` only under the coordinator's existing authority. It
rechecks the continuation and leaves ordinary admission available. The later
upgrade/history handoff and login registration remain ENG-1340's obligation.

On failure, stop through the current installed root's normal owner and **keep
the original trial active** for recovery. For the installed successor history,
the working rollback is canonical Brain source `probation-successor --rollback`,
with the original trial ID, current successor as `--from-root`, and original
sealed recovery as `--target-root`. Follow the exact preview/decision/apply and
separate recovery restart in [the successor procedure](PROBATION-SUCCESSOR.md).
The initial pre-successor drill uses `probation-switch` above. Ordinary
`upgrade --rollback` applies to an accepted installed predecessor, not this
development bootstrap. Do not replace an existing rollback ID or UNKNOWN attempt.

Deliberate revocation remains possible with corrected canonical source:

```sh
"$BRAIN_NODE" "$BRAIN_SOURCE/line-service/launchd.mjs" probation-withdraw --repo "$BRAIN_SOURCE" --org "$BRAIN_RECORD" --id "$TRIAL_ID" --emergency
```

It can end admissions during STOP/HOLD with no admissible fallback.
It does not stop the service, cancel captured work, change saved callbacks or
authorize a fresh recovery restart/return. Route that containment and its lost
continuation to the supervisor. Never replay a refused native effect. Frozen
candidate/recovery tools are unchanged and may still offer unconditional ending.

Live successor canary, installed pass, recovery restart/pass and candidate
return remain UNRUN by the implementation engineer. Fixtures prove mechanics,
not real recovery. Supervisor-herdr owns those live effects and exact R2
receipts; supervisor/A4 own R3 (>=10 units, >=90 minutes, shared mode OFF), and
the coordinator owns any later exact-candidate consumer offer. Full coverage
remains actual background evidence or explicitly UNRUN.
