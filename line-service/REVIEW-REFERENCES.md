# Retained typed review references

Use `review-reference.mjs` to inspect a source owner's retained references and
record a guarded, append-only disposition. This is not review recovery or a new
queue. It never launches, cancels, replaces or replays an attempt, rewrites a
journal, changes a watcher, or records a verdict. Old folds ignore the new
`review.reference-resolved` event. An upgraded line reconsiders its remembered
reference hold once per disposition, preserving the original observation.

Run from the owning project's canonical checkout, in its actual project
supervisor session. `BRAIN_SOURCE` is the accepted Brain bundle containing this
command (or the matching development source); `PROJECT_REPO`, `PROJECT_ORG` and
`PROJECT_NODE` are that project's own canonical repository, record and pinned
Node. The supervisor name must match the project's supported `promote.to` policy;
environment labels and `--role` alone grant no authority. Do not use Brain's
identity to operate on BCH.

For BCH's eight retained producers, its owner first runs these read-only entries:

```sh
for source_run in R-3582 R-3586 R-3587 R-3596 R-3597 R-3604 R-3619 R-3623; do
  HERDR_BRAIN_ROOT="$BRAIN_SOURCE" "$PROJECT_NODE" \
    "$BRAIN_SOURCE/line-service/review-reference.mjs" inspect \
    --repo "$PROJECT_REPO" --org "$PROJECT_ORG" --run "$source_run"
done
```

Inspection returns the exact landed targets, original readable reference bytes
and SHA256, retained reason, existing review targets, and discovery holds. It
reads only evidence inside the project's identity root. A missing, untyped,
foreign or redirected reference supplies no resolution proof. This command does
not change the record, runtime or saved policy.

For each positively identified reference, prepare an owner-local JSON file:

```json
{
  "item": "ENG-SOURCE",
  "run": "R-SOURCE",
  "head": "FULL_LANDED_HEAD_FROM_INSPECTION",
  "base": "FULL_BASE_FROM_INSPECTION",
  "reference": "/own/absolute/original-review-reference.json",
  "reference_sha256": "SHA256_FROM_INSPECTION",
  "disposition": "mapped-review",
  "review_item": "REV-EXISTING"
}
```

The supported dispositions have different positive proof requirements:

| Disposition | Required proof | Result |
| --- | --- | --- |
| `mapped-review` | Original reference explicitly names the existing review item or its single already recorded run, without competing native identity fields. Its complete immutable target equals the landed producer target, including range, diff and evidence. | The original recorded attempt retains responsibility and cap1. Normal launch guards still apply. |
| `superseded` | The same mapping plus exactly one recorded verdict for that review run and exact head. | The original verdict and its correction obligations remain authoritative. No new review. |
| `needs-review` | Original reference has an exact landed head and source run, an explicit `native_launch_attempted: false`, and serialized `open`, `start` or `worker` stage, with no native worker, session, process, watcher, review item/run, verdict or refusal evidence. The explicitly never-queued producer handoff described below is also supported. Omit `review_item`. | Only this proven unattempted reference ceases to hold ordinary queue admission. All other inventories and attempts remain guards. |

Supported older producer handoffs have schema `record-review-handoff/v1` or
`bch-single-record-review-handoff/1`, or no schema/type/kind/role and the structural
producer signature: `run`, a string `worker`, `producerEvidence`, and a producer
head location. `worker` must equal the source run's recorded producing agent,
without conflicting worker identity. These markers attribute the worker to the
producer; they do not prove absence of a review. A handoff remains a retained
typed reference until its guarded `needs-review` disposition.

Both top-level `queueAttempted: false` and `queueMutation: false` provide positive
never-queued proof for that producer type. Historical handoffs lacking the pair
use a record-backed proof instead, with all of these requirements:

- Exactly one original `report.ingested` event names the handoff. Its report file
  still matches the ingested SHA256 and the immutable landed target. A later
  rewrite cannot substitute for the ingested bytes.
- The existing owning line's `controls.jsonl` positively records `stop` (or
  `revert`) / `stopped` before that report checkpoint. Any intervening control
  edge, including `restart` / `starting` or an uncertain/refused control, ends the
  positive window. Missing, redirected, partial, foreign or unordered audit
  evidence refuses. Prose about STOP and the current STOP file are insufficient.
- The record checkpoint has no matching REV item or review/launch/verdict event.
  At disposition, the existing review inventories also have no competing queue,
  service intent, native/settle attempt, UNKNOWN receipt or direct review output.
  Only this exact original handoff is excluded from that inventory observation.

The immutable disposition binds the record sequence, ingested report checkpoint
and SHA256, and exact STOP audit prefix. Admission revalidates them; later audit
appends, including restart, preserve the historical proof. Later ordinary review
items and attempts retain their normal inventory guards. No attempt is removed
or reclassified by the observation.

The actual older variants use `queueAttempted: false`, `queueMutation: false`,
`review.queueAttempted: false`, `review.queueCommandAttempted: false`, or only
asynchronous/deferred review metadata. Those fields and human descriptions are
corroboration for the record-backed proof. Any populated queue/parallel-start or
waited-for-verdict flag must be false. Review strings and cap/suite/deferred
metadata describe the intended handoff, not a review identity or verdict.

A top-level `qualification` may retain the producing worker's own failed focused
test run. The recognized object has exactly eight fields: `exitCode` is 1;
`tests`, `pass`, and `fail` are non-negative safe integers, with positive `fail`
and `tests = pass + fail`; `node` is a version string such as `v22.22.3`;
`refusal` and `affectedControl` are non-empty strings; and `provingExecuted` is
false. The enclosing producer handoff supplies the verified producing worker and
source binding. Review-related text (`review`, `rev-`, `queue`, `pane`, or
`session`, case-insensitive) in either descriptive field, missing/extra fields,
malformed counts, and other qualification shapes remain UNKNOWN. In particular,
`review.qualification` and `native_qualification` retain their existing refusal.
The original failed test result stays unchanged; recognizing its producer scope
does not make it PASS or prove that no review was attempted. The existing queue
or historical record/STOP proof and competing-attempt guards still apply.

A top-level producer handoff `watcher` can be the dispatch-time process waiting
for that producer's own report, rather than a review attempt. Supported watcher
objects contain a positive integer `pid` and only the optional dispatch fields
`run`, `item`, `identity`, `log`, `release`, `to`, `target`, `recipient`, `retained`,
and `liveness`. The destination fields `to`, `target`, and `recipient` accept
non-empty strings. Optional `liveness` accepts only descriptive strings; its text
grants no authority and supplies no process or absence evidence.
Populated run/item fields must name the producer; a log must be its exact
`ORG/dispatch/R-SOURCE.watch.log`. Populated identity/log/PID fields must agree
with any recorded producer watcher binding. A watcher linked to a review run
through its run/item, recorded watcher identity, or reviewer recipient refuses;
so does `review.watcher`, an unknown shape, or any review/launch/verdict evidence.
No live process probe or absence inference is used.

These watcher handoffs **always** require the complete record-backed historical
STOP proof and competing-attempt inventories above, even when both queue flags
are false. Their `producer-record-no-attempt` receipt additionally contains a
typed `producer-report-watcher` observation binding the producer run and watcher
SHA256. Admission revalidates it alongside the unchanged original reference,
report checkpoint, audit prefix, exact range/diff and immutable evidence. The
watcher itself is neither modified nor restarted.

The retained range/diff proof has a hard **32 MiB per Git output stream** ceiling,
matching existing source discovery/capture. It hashes the complete UTF-8 diff
with the same trimming and SHA256 predicate as existing captures. Above that
ceiling it refuses with `REVIEW_PROOF_OUTPUT_LIMIT` and an explicit UNKNOWN
diagnostic; it never hashes truncated output, substitutes a weaker predicate,
or permits a disposition. Such a source needs a separate implementation change
to stream its proof, not a guessed hash or a replacement capture.

For this producer type, head aliases additionally include `ownedScope.head` and
`source`. All populated head aliases must identify one full commit exactly equal
to the landed target; duplicate identical aliases are allowed. Conflicting,
short, multiple or absent heads refuse. Any populated base aliases must equal
the captured base. These older locations do not fill in an unresolved landed
range, alter the target, or relax the existing captured diff/evidence checks.
Review identities, launch evidence, review item/run or verdicts contradict a
never-queued producer handoff and remain held. An explicit started/uncertain
native flag or conflicting source run/item also refuses.

Current STOP/HOLD still prevents disposition. This command never resumes the line
or changes that authority; its owner must use the existing authorized procedure.

Outside this positive producer proof, absent/TRUE native flags, uncertain native
outcomes, actual refusals, incomplete
or conflicting ranges, changed evidence, overlapping attempts, or a missing
explicit existing-review link refuse. A supervisor's prose or an absent process
does not convert UNKNOWN to zero-native proof. An UNKNOWN captured range remains
held for its owner to establish the original facts; it cannot be filled in by
guessing a new range. If inspection finds existing coverage/verdicts as it does
for Brain's historical retained cases, keep them rather than queueing a review.

Record a scoped decision with the existing record CLI. Use one stable ID per
reference, preserving it for an identical retry. Include the ID, source item/run,
full landed head, reference SHA256 and disposition literally in the decision:

```sh
HERDR_BRAIN_ROOT="$BRAIN_SOURCE" ORG_DIR="$PROJECT_ORG" "$PROJECT_NODE" \
  "$BRAIN_SOURCE/bin/org.mjs" note "$SOURCE_RUN" --decision \
  "Resolve $STABLE_ID $SOURCE_ITEM $SOURCE_RUN $FULL_HEAD $REFERENCE_SHA256 $DISPOSITION; preserve original attempt and history."

HERDR_BRAIN_ROOT="$BRAIN_SOURCE" "$PROJECT_NODE" \
  "$BRAIN_SOURCE/line-service/review-reference.mjs" resolve \
  --repo "$PROJECT_REPO" --org "$PROJECT_ORG" --run "$SOURCE_RUN" \
  --resolution "$OWN_RESOLUTION_JSON" --decision-seq "$DECISION_SEQ" \
  --id "$STABLE_ID" --role supervisor
```

Repeat the second command separately for each proven reference in each of the
eight runs. The output is `review_reference_resolved`; an identical retry returns
`existing: true`. Another disposition cannot replace it. The archive under
`evidence/review-references/STABLE_ID.json` preserves exact original bytes, target
and proof. Consumers revalidate the archive, original reference, landed range,
evidence and mapping at admission. The control serializes with the existing pass,
promotion and record locks and checks native supervisor, claim generation,
source/canonical head and clean CAS, STOP/HOLD and held/reserved subjects.

After a validated `needs-review` disposition, the next line pass can settle one
specific old `record-queue` failure automatically: a completed exit-3 command
with empty stdout, no signal/error, and the exact promotion-guard diagnostic
`record changed repeatedly while preparing a consistent read; no mutation attempted`.
That error comes from pure plan preparation before the record commit/append;
it is not a native refusal or an unreadable queue authorization. The exact
project queue path and whole diagnostic must match the saved receipt. No review
item, run or verdict may exist for that source, and normal review inventory,
landed target, claim, admission, STOP/HOLD and record CAS checks still apply.

Before one ordinary queue continuation, the existing journal saves a typed
`review-queue-no-mutation/v1` proof with original/receipt hashes, exact target,
record checkpoint and reference resolution sequences. The entire failed entry
stays in `history`; the proof stays in `queue_recovery` and the pass audit.
A lost/uncertain continuation, another contention, a genuine refusal, a changed
archive, an existing review, or any other UNKNOWN receipt cannot replay. No new
supervisor command, replacement reviewer, service restart or delivery is needed.
Brain's other retained outcome notes remain held unless their own proof fits.

Leave the existing line and saved callbacks in place. Its next ordinary pass
uses the normal record `queue-review` and dispatch path where eligible. Do not
manually queue a replacement, restart a service, or retry an original UNKNOWN
effect. Final release coverage and actual BCH acceptance remain with their
respective owners; these commands provide neither release nor adoption authority.
