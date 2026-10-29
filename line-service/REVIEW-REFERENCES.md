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
| `needs-review` | Original reference has an exact landed head and source run, an explicit `native_launch_attempted: false`, and serialized `open`, `start` or `worker` stage, with no native worker, session, process, watcher, review item/run, verdict or refusal evidence. Omit `review_item`. | Only this zero-native reference ceases to hold ordinary queue admission. All other inventories and attempts remain guards. |

Absent/TRUE native flags, uncertain native outcomes, actual refusals, incomplete
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

Leave the existing line and saved callbacks in place. Its next ordinary pass
uses the normal record `queue-review` and dispatch path where eligible. Do not
manually queue a replacement, restart a service, or retry an original UNKNOWN
effect. Final release coverage and actual BCH acceptance remain with their
respective owners; these commands provide neither release nor adoption authority.
