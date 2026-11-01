# Record obligations

The original event append is the durable obligation. `fold(events)` and
`loadRecordReader(org).state.obligations` derive the same index. No second queue,
new journal, acknowledgement append or materialization transaction exists.
Losing a snapshot or crashing before/after a projection write cannot lose the
intent: the existing reader verifies its source and rebuilds from the log. The
projection version includes the obligation code. Old folds keep their existing
behavior and ignore the additional interpretation.

ENG-1034 consumes this interface. The index does not change scheduling, dispatch,
review admission, installed services, watcher duties or effect authority. A
consumer must use its existing guarded entry with fresh source, ownership,
native, STOP/HOLD and attempt checks. A pending row is never a retry request.

```js
import {loadRecordReader} from '../../lib/store.mjs';
import {obligationId, obligationPending} from '../../lib/obligations.mjs';
const reader = loadRecordReader(org);
try {
  const row = reader.state.obligations.get(obligationId('review-handoff', run));
  reader.verify();
  // Retain only this subject. Pending is an observation, not launch authority.
  if (row && obligationPending(row)) observeOriginalSubject(row);
} finally { reader.close(); }
```

Keys are JSON arrays `[kind, ...originalSubject]`, not reading positions. Each row
retains its first source sequence/type/time, original run/start/claim, project,
consumer, wake facts and stuck owner. Consumer results retain their source and
the original target; a later fact does not overwrite the first recorded outcome.
Reports, landed heads and captured queue items remain separate facts on the
same producer handoff. Duplicate facts reuse the row. Later uncovered heads stay
pending alongside the original capture and outcome; they do not replace it or
authorize a fresh attempt. Report-only rows explicitly leave source eligibility
unproven. The authoritative `queue-review` command owns whole producer coverage,
disjoint later captures and cap1; the index does not make those judgments.

| Kind and original subject | Recorded outcome / limit |
| --- | --- |
| `report-intake`, run/hash/claim | Same run, start, claim, file and ingested hash. Earlier drafts superseded by a different ingest in the same scope retain their original hash, stay unresolved and are diagnosed unsupported with the superseding reference. |
| `review-handoff`, run | Original single-round queue item with matching producer/report capture, or native-landing capture. Every recorded landing head must remain covered; the queue command still validates provenance. |
| `closeout`, common/key/source sequence/type | Exact completed `closeout.evaluated` from the existing closer; resource receipt details are retained. |
| `closeout-binding`, run/source sequence | Explicit unsupported binding diagnosis and original owner. Later absence is not completion. |
| `closeout-wait`, common/key/wait ID | Exact producer descriptors and recorded statuses plus a completed parent `closeout.evaluated` for the same common/key/source. Worker-report statuses require the original claim and report reference; native-command and lane-removal statuses consume the closer's recorded `closeout.effect` completion reference. Both prerequisite orders work. Missing, failed, UNKNOWN, other producer types and defects stay pending and unsupported. Original statuses, descriptors and the parent reference are retained in the outcome; no native validation or attempt is replaced. Classification never acknowledges an effect. |
| `native-outcome`, common/key/source/intent | Exact intent-linked native result, positive never-started or original refusal. Unknown results remain pending; legacy settlement retains the UNKNOWN label. Git-removal and other unvalidated receipts stay unsupported. No executor or continuation is added. |
| `dispatch-outcome`, run/attempt/journal | Exact project/item/run/attempt/journal `dispatch.completed`, including an actual failed exit. |
| `source-completion`, run/report hash | Explicit conditional `item.closed` for that original run/report. An already-closed item without that exact receipt is historical and unsupported, retaining its close observation without inferring an outcome. Reopening clears that diagnosis. |
| `unsupported`, pending type/source sequence | Unknown `*.waiting`, `*.requested` or explicit `pending:true` facts are visible with their original payload and project-supervisor owner. |

The inventory is deliberately a record-fact inventory. Saved file-only service,
settle, watch and dispatch journals remain with their existing guarded owners;
their absence is not an empty-attempt proof. Unsupported rows are retained for
diagnosis, not labeled defective or automatically scheduled. No claims are made
about complete coverage of journal-only or future event formats.

`record obligations [--json] [--project COMMON_DIR]` opens the compact reader,
reports each kind's total/pending/supported/unsupported counts and oldest age,
and names exact rows and source position in JSON. The explicit census scans the
current index; per-subject consumers use `get(obligationId(...))` without
streaming/reparsing history on every hint. Always close the reader and reopen if
stale. A cursor or projection checkpoint acknowledges no obligation.

`event_to_observation_upper_bound_ms` includes historical backlog and read time;
`event_to_outcome_ms` measures only linked record timestamps and remains null
without a result or with invalid/reversed time. Neither claims installed
event-to-wake latency. ENG-1034 owns scheduling latency controls, and ENG-1033
owns wake timing. The focused obligation controls exercise duplicate facts,
both prerequisite orders, absent producer folders, corrupted/removed caches,
source/result/checkpoint crash boundaries and original UNKNOWN/refusal identity.
