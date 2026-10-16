# Foreground log journal and detectors

ARCH-33 stage 5, offline first slice. Node built-ins only. This module reuses
`messages/schema.mjs`, `messages/classify.mjs` and the private partition resolver
in `messages/journal.mjs`. It adds no model, daemon, background loop, socket,
Herdr subscription, session, delivery path or record mutation. `brain/` remains
the separate foreground lesson digest. Existing notice text and delivery owners
are unchanged.

## Commands

```sh
node logs/logs.mjs replay --root /private/tmp/log-replay --identity example --common-dir /canonical/project/.git --from-shadow --shadow-root /private/tmp/shadow-fixture --from-record --org /private/tmp/record-fixture --json
node logs/logs.mjs view --root /private/tmp/log-replay --identity example --common-dir /canonical/project/.git --since 2026-10-16T00:00:00Z --workspace workspace-uid --session session-uid
node logs/logs.mjs retain --root /private/tmp/log-replay --identity example --common-dir /canonical/project/.git
node logs/logs.mjs coalesce --root /private/tmp/log-replay --identity example --common-dir /canonical/project/.git
node logs/logs.mjs repair --root /private/tmp/log-replay --identity example --common-dir /canonical/project/.git
```

Every command finishes in the foreground. There is no `--follow`. All mutating
CLI commands require `--root` and write only beneath it. `--from-record` also
requires `--org`; neither a record nor an input is discovered by following an
event's path. Replay refuses an output root inside the selected record. Inputs
are explicit, read-only sources. Without `--shadow-root`, shadow input uses the
existing stage 7 resolver. There is no live collector or activation step here.

`view` never creates a directory or repairs a file. Its optional default, and
the library's default, are exactly the stage 7 partition:
`<identity-root>/.herdr-brain/logs/<identity>/<sha256(canonical-common-dir)>/`.
An explicit `root` wins over `BRAIN_SHADOW_ROOT`; only an unmarked project uses
the existing fixture-HOME/per-user fallback. Logical identity comes from
`--identity`, `BRAIN_IDENTITY` or the identity marker. A linked worktree uses its
canonical Git common directory, not its label. Tests always supply disposable
roots or the existing offline helper's root. The isolation guard observes all
partition files, including segments and subscriber cursors.

`--since` filters producer `occurredAt` in UTC. Workspace and session filters
also retain linked detector observations. Event cursor order is acceptance
order; producer time and cross-source replay sorting confer no global order.
`view --json` returns envelopes. Replay JSON contains counts only, sorted maps,
bytes/events per UTC day, the maximum sliding one-second burst, counts by
type/kind/path, would-route counts, detector hit/unknown counts, direct shadow
line count, source gaps, retention floor sequence and torn-tail evidence. It
contains no message bodies or event IDs. Retrying a frozen input into the same
root gives the same summary. Actual model wakes, savings, quota, producer spool
size and fsync latency are not measured by this offline slice.

Without `--json`, replay additionally prints **shadow output**: exactly one
source-linked `[log-shadow]` line per obvious rule/version/condition represented
in the retained journal. These lines are never sent or appended to
`shadow.jsonl`. Re-running a viewer/replay can display the same retained line;
this is not a delivery receipt or an exactly-once notification transport.

## Durability and recovery

`LogJournal` stores `brain.log/v1` envelopes in sequenced
`segment-0000000000000001.jsonl` files, separate from both `shadow.jsonl` and
`.org/events.jsonl`. Directories are 0700 and files 0600. The shared resolver
rechecks private storage paths; file opens refuse symlinks and nonregular or
nonprivate targets. No body, report, source or decision reference is opened by
the writer, detector or viewer. These local files are identity-owned
observations, not authenticated cross-identity enrollment or authority.

One immediate exclusive `log-writer.lock` covers a partition's short writer
transactions. Contention fails; no wait, retry loop or stale-lock stealing is
installed. An accepted append validates an immutable snapshot, rebuilds keys
from segments, writes the complete line, fsyncs the file and fsyncs its directory
before acknowledgment. An identical event ID/producer tuple returns the stored
cursor; changed content under either key fails. A complete line left by a
failed fsync is synced again before a retry is acknowledged. There is no
separate mutable deduplication index.

`append()` returns its durable commit result and cursor even if the later
detector or retention pass fails. Such errors appear in `followUp` as
`{phase, error}` entries; they do not undo acceptance or require a new producer
key. A retry returns the original cursor and retries maintenance. A detector
failure postpones retention too, preserving its source evidence for recovery.

A trailing incomplete line is reported with file, byte offset, length and
SHA-256. Appends refuse it and preserve all bytes. Invalid complete records,
middle tails, missing segments above the retention floor, duplicate keys and
inconsistent epochs stop reading; they are never skipped. `repair` handles only
the incomplete final tail: it durably archives the **whole original segment**
as a content-addressed `.evidence` file before truncation, fsyncs the repaired
segment and journals `service.journal.repaired`. Existing matching evidence is
reusable after an interrupted repair. It does not repair corrupt middle data.
Evidence files are outside automatic retention and require explicit owner
disposition. After a crash-left lock, inspect its PID and actual owner before
explicitly removing it; no product command guesses that a lock is stale.

`LIMITS` in `journal.mjs` names the starting policy: 16 KiB per stored envelope
(shared schema limit), 1 MiB segment target, 256 MiB or seven days per partition,
100 events/64 KiB per subscriber batch, and five-second progress windows.
Retention runs after append/replay and can also run explicitly. It removes
whole oldest segments. A new fsynced `service.retention` control records the
floor, removed sequence ranges/count/bytes and a producer-watermark checkpoint
**before** deletion. Interrupted deletion is completed from that control on
the next retention transaction. The checkpoint has bounded JSONL rows in a
private, immutable, content-addressed file; it is fsynced before the journal
control commits its digest, byte size and producer count. Orphan checkpoint
bytes alone are never a commit. Reads verify the latest committed checkpoint;
retention preserves it and reclaims superseded checkpoints only after the new
control is durable. Legacy inline watermark controls remain readable. This
keeps every control within the 16 KiB envelope bound regardless of producer
cardinality, and retention can continue through producer/session churn.
Failed checkpoint writes leave private temporary evidence; publication uses a
fully fsynced file, so an incomplete temporary cannot block a later retry.

File creation/control overhead is retained;
the byte ceiling is enforced by deleting whole segments and reserving space for
the new control, not by truncating an event. It counts segment bytes only;
shadow data, subscriber cursors, watermark checkpoint metadata and preserved
repair evidence are separate. The checkpoint's total size grows with retired
producer cardinality; it is not constrained to one envelope or counted as event
history. An impossibly small byte ceiling still reports a maintenance error
before committing deletion. Retention never
touches authoritative reports, outboxes, holds or record state.

Deduplication is supported within retained history. Removed producer sequence
high-water marks survive in the committed checkpoint. An old producer at/below its mark
gets `reconciliation required`, rather than silently appending a duplicate.
Out-of-order keys below a pruned high-water mark also require reconciliation.
This is not an indefinite event-ID index. A consumer cannot reconstruct lost
history from a current snapshot; retention explicitly bounds detector evidence
as well. Keep canonical source records for recovery.

This implementation is explicitly **offline only**: every append rebuilds keys
by reading and parsing the whole retained journal under the writer lock, and
the detector and retention passes repeat full reads. Checkpoint metadata is
also read/rebuilt in full; blocker/refusal scans can be quadratic in event count.
At the 256 MiB target, one append can therefore parse hundreds of MiB several
times. These are correctness/replay limits, not service throughput claims.
Before any separately authorized service step, add an incremental index/cache
revalidated against segment identity and size, with crash-safe checkpoint/commit
recovery and measured metadata/storage costs.

`subscribe(id, {cursor, acknowledge, limit})` returns bounded entries, next
cursor and floor. Cursors are `(epoch, sequence)`; a zero sequence means before
the first event. A too-old or foreign-epoch cursor returns an explicit gap and
current floor, with rebuild instructions. `acknowledge: true` atomically fsyncs
only that subscriber's cursor in its 0600 file; other subscribers advance
independently. No consumer holds a lock while it processes a returned batch.

`coalesce` adds lossless `service.events.coalesced` annotations for two or more
typed routine progress notices from the same session/incarnation in a fixed
five-second window. Annotations record count and exact sequence ranges;
previously covered sources are not counted again. Original events remain
available to detectors and replay. Controls, critical notices and untyped
inputs are never coalesced. This slice does not discard progress bodies.

## Detectors and routing

`RULES` in `rules.mjs` contains named, versioned constants. Every accepted source
event is evaluated by the foreground pass **outside** the append lock.
`append` runs the pass after persistence; bulk `replay` evaluates the accepted
sequence after import. A retry or `reconcileDetectors()` recovers a crash
between source acceptance and observation persistence, including all-duplicate
replays. Detector observations use deterministic IDs and are not recursive
inputs. Existing observations seed recurrence and direct-line identity across
retained evidence. They never schedule, promote, reset, release or retire.

| Rule v1 | Threshold and required evidence | Hit path |
| --- | --- | --- |
| Common blocker | At least 2 distinct `lane`s, same validated `causeKey`, within 2 hours inclusive | triage |
| Stall | `process: stopped`, `report: absent`; validated `watch-no-report`; or `process: idle`, `openRun: true`, absent report and `idleSince` more than 30 minutes ago | direct |
| Resource refusal | At least 2 distinct `requestId`s with `admission: refused`, same `resource` and `causeKey`, within 1 hour inclusive | triage |
| Review loop | Round 3 or later; or stable `findingKey` returning in another round in the same `reviewChain`/item | triage |
| Stuck queue | `queueState: pending`, stable `jobId` and `pendingSince` more than 60 minutes ago | direct if unexplained; triage with hold/owner evidence |
| Cost spike | Usage strictly above 2 times a supplied recorded route baseline, same route and usage unit | triage |

The cost multiplier is an explicit provisional calibration choice: the adopted
design specifies “well above” but no numeric multiplier. A baseline needs
`{route, unit, usual, ref}`; usage needs `{unit, value}`. Absent, incompatible,
zero or invalid baseline/usage is **unknown**, never zero or an inferred
subscription price. The threshold is advisory and cannot refuse work.

Only supported typed events with `payload.validated: true`, or validated
`session.message.v1` evidence, supply detector inputs. The typed event vocabulary
is `worker.observation`, `resource.admission`, `review.round`, `review.verdict`,
`queue.receipt`, `run.usage`, `run.report.available`, `record.dispatch.receipt`
and `record.watch.receipt`. Arbitrary future payloads stay inert. A source
validation assertion is observational evidence, never authentication or control
permission. Cause/finding identities are stable keys, never substring matches.

`ParkedAwaitingReview`/`parkedReview: true` and expected hold evidence protect
parked workers from stall hits; their original events remain visible. Unknown
or contradictory idle/report evidence produces an explicitly unknown
observation for interpretation. Stop attempts use run plus incarnation/attempt,
so a second attempt without a report remains a separate condition. Rule,
version and condition identify a finding; unique source IDs track recurrence
and material changes. Observations bound source IDs to 64/4 KiB and retain a
digest when longer evidence is represented. Full sources remain in the journal
within retention. Duplicate source IDs do not create another hit.

`route` reuses the stage 7 classifier: supervisor eligibility is displayed as
`direct`, explicit fyi/ack/hold/release remains `rule`, routine operational
traffic remains `triage`, and platform telemetry stays in rules/viewer.
Unrecognized or unvalidated operational evidence remains visibly `unknown`.
Detector records themselves are telemetry; only their selected hit evidence
is eligible for a future direct exception or triage batch. No traffic is
delivered and no batch/model is created here.

## Offline inputs and tests

Shadow replay imports accepted entries only, stripping writer/shadow metadata
while preserving the original producer key. Duplicate and conflict attempts
are not imported. Record replay uses the existing `loadEvents` reader and
`fold` read-only in event order. It selects `run.started` dispatch receipts,
`report.ingested` availability/outcomes and typed evidence from `report.extra`,
and the `process_end`/`dispatch_waits` fields in `run.updated.meta`. Verdicts use
the record fold's trim/uppercase normalization; `review_scope` maps to
`reviewScope`. Review role/verdict evidence identifies the review chain and
round for loop detection. It never selects nonexistent record receipt types.

Timing metadata is parsed with the existing `timingEvent` allowlist and matched
to the current run/item/lane. Stable timing IDs avoid repeats when an update
contains earlier receipts. Invalid/mismatched timing metadata stays explicitly
unknown. Process-end evidence retains idle/done/gone, with report presence only
when already ingested at that point in the record; lack of ingestion is
**unknown**, not proof of a missing report file. Wait metadata retains memory
gate entry/granted/stopped/failed outcomes. A generic failed gate carries no
specific admission refusal/cause key, so it cannot establish a resource-refusal
hit. Those stronger facts still need explicit typed source evidence, such as
the accepted shadow notices. No note, prompt, arbitrary metadata, report prose,
or referenced report/body file is read into the mirror.
Known source loss, including a source reader's torn tail, becomes a stable
`service.source.gap`; no source is repaired. The `sourceGap()` helper also
accepts explicit source loss/range/count observations for offline adapters.

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/logs-journal.test.mjs test/logs-rules.test.mjs test/logs-cli.test.mjs test/offline-herdr.test.mjs
```

Fixtures cover writer contention, fsync acknowledgment/failure, restart dedup,
conflict, actual process exit with a torn tail, repair evidence, middle
corruption, retention floors/gaps, independent durable subscribers, source
loss, every threshold edge, the three synthetic motivating shapes, parked
review, source deduplication, direct shadow output, filtering, lossless progress
annotations and repeatable read-only replay. No test calls a model or Herdr.
