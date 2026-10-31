# Supervisor absence and duty coverage

`bin/evaluate-retirement.mjs` is the SR4 annex to the existing installed-runtime
observation. It calls ENG-1137's `evaluateSoak`, which calls ENG-1130's lifecycle
reader, and joins saved ENG-1038-style native-session, source/report and next-owner
handover evidence. It consumes ENG-1140's actual `lifecycle.manual-nudge` schema.
There is no second soak, journal, scheduler, live inspection, model or executor.

```sh
/path/to/node-v20.19.4 bin/evaluate-retirement.mjs --manifest retirement.json > coverage.json
```

Exit 0 means a result was produced. `status` is `READY`, `INCONCLUSIVE` or `FAIL`;
only `READY` has `ready: true`. This is evidence coverage, never authorization to
retire a supervisor, clear HOLD, reset UNKNOWN, replay a callback, activate a
candidate or certify BCH. `fixtureOnly` is propagated; a fixture result proves
only the predicate. Installed acceptance and permission for a real absence
window remain with their actual owners. This build runs no real absence window.

The CLI verifies every manifest artifact's raw SHA256 before consuming it and
verifies the existing trial's evidence through the shared saved-soak reader.
The original A2 installed-canary packet and A3 probation archive are hydrated
from verified bytes; inline replacement statuses do not override them. The
observations packet is also loaded from verified bytes, not an inline copy.
Raw saved observations still need owner review: hashing an assertion proves its
identity, not its truth or native authority. A positive result requires the
actual capture/audit sources, not a filled template or plausible summary.

## Manifest and observations

The retirement manifest has `schema: brain.retirement-input/v1` and these fields:

| Field | Content |
| --- | --- |
| `project`, `candidate`, `window` | Identical to the existing [soak input](CANARY-SOAK.md), including installed full commit/tree, root, manifest/inventory hashes, Node executable/version, protocol/configHome, UTC endpoints and opening/closing sequence fences. |
| `configSha256`, `configEvidence` | SHA256 and verified artifact ID of the exact saved installed configuration bytes, independently of configHome's compatibility version. Every native-coverage segment repeats the hash and full candidate tuple. |
| `record` | Absolute owning record `path`, `start_seq`, `through_seq` and `events_sha256` from the reused lifecycle projection. The event snapshot includes earlier history needed for joins. |
| `evidence` | Map ID → `{path, sha256}` for every original saved input and supporting source. Paths resolve relative to this manifest. Trial references resolve relative to the trial file. |
| `trialEvidence`, `eventsEvidence`, `observationsEvidence` | IDs naming the original soak input JSON, frozen event JSONL and retirement observations JSON. Do not substitute an already evaluated PASS summary for the trial. |
| `plan` | Pre-window `authoritySeq`, actual `authorityOwner`, explicit intended `eligibleItems`, `normalOwners`, accepted `recoveryOwner`, independent `observerOwner`, `checkInAt` and `checkInRecord`. The check-in is at or after the planned cutoff. These facts grant no binding or permission. |
| `fixtureOnly` | True for scripted fixtures; never remove this label to claim installed acceptance. |

Before the actual interval, the real authorized owner records a decision note
binding the plan to its exact scope. Its text is `Brain absence window authorized:
SHA256`, where SHA256 hashes `canonical({project, record: record.path, candidate,
configSha256, window, plan})` with `messages/schema.mjs` and SHA256. `authoritySeq`
is that note's sequence; it must be no later than the opening fence and its
timestamp no later than the interval. `authorityOwner` must match its actual
recorded author. The observer verifies that author's authority against the
owning intent and reserved decision; the evaluator does not derive authority
from a label. Construction/selection of SR4 is not that absence authorization.
The recovery owner must accept SR3's independent discovery/restoration duty and
check-in record before the experiment, including the line-unavailable case.

Each proof below is `evidence: [ID, ...]` referring to verified manifest
artifacts. Missing proof is inconclusive. The observations packet contains:

| Field | Required saved observations |
| --- | --- |
| `planning` | Proof, `recoveryAccepted: true`, `observerIndependent: true`, `unitMixAccepted: true`. Save the real owners' pre-window acceptance and original observer/job ownership. No new schedule is inferred. |
| `absence` | Proof, `from`, `cutoff`, `complete: true`, ordered gap-free `segments`. Each segment has proof, `from`, `cutoff`, `nativeComplete: true`, full `candidate`, `configSha256` and `standingSessions: []`. Complete capture coverage must span the entire interval; endpoint snapshots are insufficient. Idle/sleeping/paused standing sessions are still present. Disclose any finite custodian and its separately authorized bounded duty in raw observations. |
| `nudges` | Proof, `schema: lifecycle.manual-nudge`, exact `from`/`cutoff`, `complete: true`, all actual `actions`, and `entries`. Each entry needs proof, exact interval and `complete: true`. Entries: `start`, `resume`, `prompt`, `retry`, `review-hand-filing`, `hand-close`, `hold-relay`, `recovery`. These are audit entry paths, not new constraints on the journal's free-text stage. Retain future capture plans under `future`; they never fill current gaps. |
| `effects` | Proof, `complete: true`, observed integer `lost`/`duplicates`, `rows` inventory including carry-in obligations and original attempts. Each row has proof, original `id`, actual `owner`, `next`, `status`. Any status other than `done`, including UNKNOWN/refused, prevents READY. Original typed native failure events also prevent READY. |
| `callbacks` | Proof, `complete: true`, full `rows` inventory of legacy supervisor jobs/watchers/callbacks. Each has proof, original ID/recipient, `owner`, `next` and `disposition: drained` or `handed-off`; a handoff also needs `accepted: true` and actual supported handoff evidence. Sent/ACK alone is insufficient. Do not retarget saved callbacks. |
| `obligations` | Proof, `complete: true`, all pending `rows` with proof, `owner`, `next`, severity/status and any `dangerous` flag. Every Major needs `status: corrected` and specific `correctionChecks` IDs. An unsettled dangerous obligation blocks READY. An unowned obligation fails the window. |
| `checks` | Unique named proof-bearing `{id, status}` rows, retaining original failed/unrun controls. FAIL fails the window; UNRUN/unknown is inconclusive. These are saved producer controls; the evaluator executes no suite. |
| `duties` | Exactly one proof-bearing row per D01–D16 in the [accepted design](../docs/design/supervisor-chat-retirement.md), with planned actual `owner`, `mode: live \| scripted \| unexercised`, `negative` and `recovery` check IDs. Live rows identify completed cohort `runs`. D03/05/07/08/11/13/15 require live coverage. Other duties may use installed-scripted evidence. Every unexercised limit remains visible and prevents full readiness. |
| `handovers` | Proof-bearing causal chain described below, using the original native bindings and immutable reports. |

Nudge silence is never a completeness proof. The reused lifecycle result retains
its `hand_nudges.total: null` historical limit. The annex separately reports the
current capture claim, explicit journal rows with occurrence time, actor and
recorder, and future coverage. It includes journal interventions on any scoped
run, not just the ten fastest ordinary units. Missing observations, absent
journal coverage, no relevant demand and unknown/censored clocks are inconclusive.

Each handover names `fromRun`, `toRun`, `kind`, `reportSeq`, `causeSeq`, proof,
and proof-bearing `context: {recordOnly: true, reportSha256}`. Save the actual
delivered record-only context/journal and source capture; no transcript/resumed
conversation can fill the requirement. Native session IDs must differ, the new
session must not have been bound previously, and report delivery precedes input.

- `producer-review`: `causeSeq` is the original review `item.added` event, whose
  `meta.review_source_run` and `meta.review_target.reportHash/head` join the
  producer's immutable report and source. The queue follows the report and
  precedes reviewer start. Original cap1/zero-suite evidence stays in the soak.
- `next-work`: `causeSeq` is the previous owner's linked folder cleanup effect,
  preceding new input. `context.causal: true` and raw next-work/admission evidence
  establish causality; coincident timestamps alone are insufficient. Its
  `fromRun` must be the first handover's reviewer, and the new ordinary owner
  differs from the producer. Two unrelated starts cannot pass.

The existing soak still requires its exact candidate's installed canary, landing
checks, all-start cohort, reports, run-attributed closures, real typed native/Git
cleanup receipts, physical observations, finite closeout turns and turnover
evidence. The annex also requires at least 90 minutes and ten genuine completed
ordinary units from the planned eligible demand. Review runs, `meta.review_fix_of`
corrections and explicitly marked `runs[].retirementKind: observation` rows are
counted separately. Neither a failed run nor a late pending run disappears.
Known, unknown and censored latency counts, original failures, unrun checks and
Major obligations remain in the returned soak/observations, not a second engine.

## Interrupted evaluation and handback

An evaluation is a finite pure calculation. It can restart from a checkpoint
without changing a record, pin, HOLD, session, effect or input file:

```sh
node bin/evaluate-retirement.mjs --manifest retirement.json --checkpoint > checkpoint.json
node bin/evaluate-retirement.mjs --manifest retirement.json --resume checkpoint.json > resumed.json
```

The checkpoint hashes the complete hydrated immutable input, including all
evidence identities and raw event content. A changed input is refused, not
silently resumed with a new cohort. The checkpoint boundary is before the pure
calculation; no long-lived job or second journal exists. The same verified input
produces identical output with or without resume. Keep outputs outside inputs.

On FAIL/INCONCLUSIVE, the result names the accepted SR3 recovery owner and check-in
record. The existing observation owner records and routes that exact interval
through the original durable supervisor inbox. This reader sends nothing and
never clears HOLD, resets UNKNOWN, retries refused input, restores a process or
starts a new window. Retain actual refusal/UNKNOWN receipts and original notice
IDs. Any real restoration is manual assistance and invalidates zero-rescue for
that interval. A later window needs a new separately authorized scope.

Focused construction check (one lane check command on the clean committed
candidate, pinned Node 20.19.4):

```sh
node test/helpers/run.mjs test/retirement-coverage.test.mjs test/canary-soak.test.mjs
```

The mixed-cohort fixture, separate nudge/assistance/callback/UNKNOWN/drift/native
coverage negatives and interrupted checkpoint recovery prove construction only.
`RETIREMENT_WITNESS_DIR` saves the scripted packet and byte-identical recovery
output during that check. A genuine installed absence interval, real owners'
approval, live duty coverage and restoration are UNRUN until separately observed
by their existing owners. ENG-1038/R-1540's existing development audit also
explicitly leaves installed/live acceptance unproven; do not relabel it here.
