# Record snapshots and short transactions

## Compact read-only view

`loadRecordReader(dir)` in `lib/store.mjs` is an opt-in read-only alternative
for consumers that retain selected current work. `record show ID --compact`
uses it for an individual item or run, with the same text/JSON result as `show`.
It does not change service runtimes, watchers, mutation planners or their guards.

```js
const reader = loadRecordReader(dir);
try {
  const run = reader.state.runs.get(runId);
  const item = reader.state.items.get(run.item);
  // Keep selected facts, not Array.from(reader.state.items.values()).
  const position = reader.position;
  reader.verify(); // throws RECORD_READER_STALE if the log has changed
} finally {
  reader.close();
}
```

The state maps implement `get`, `has`, `size`, `keys`, `values`, `entries` and
iteration. Each lookup returns an independent exact folded value, including all
notes, revisions, ownership generations and reports. They are not writable Maps;
object identity across lookups is not part of this contract. Iteration decodes
one subject at a time. Consumers that collect all values still pay for all facts.
Graph/status renderers may collect those values and perform repeated lookups;
the compact flag is a control, not a promise of faster full-history rendering.

`reader.events({afterSeq})` streams complete authoritative events, including
unknown types. It scans the captured log prefix; it is not an indexed tail seek.
An event without a numeric sequence is conservatively included even with a
cursor. Finish or close an iterator before using its result: source changes
during a scan throw, rather than declaring a mixed view current. A torn EOF is
ignored and reported; malformed complete lines refuse. Valid EOF JSON remains
visible without a trailing newline.

The position contains reader/fold/runtime version, real source identity and
nanosecond signature, full-prefix digest, byte position, complete-line position,
valid EOF flag, event count, last sequence and last timestamp. `fresh()` checks
the current source signature; `verify()` throws on any append, replacement,
rewrite, truncation or missing source. An already-open view's indexed facts stay
at its captured position even after another reader replaces the projection.
These are observation controls for ENG-1032/1033, never mutation authority.
Fresh native, claim, source, CAS, STOP/HOLD and locked checks remain mandatory
through their existing mutation APIs.

`record.reader` is disposable. Its independently hashed subject blobs and
checksummed index are bound to the reader version, source identity and verified
log-prefix digest. A missing, stale-version, foreign or corrupt file rebuilds
from the append log; prefix rewrites cannot hide behind a projection. Compatible
appends extend the folded state. Rebuilds stream events and spill changed
subjects between batches of 128 events, without splitting an event's dependency
set. A subject whose bytes did not change is not written again, and a map that
an event scans stays decoded until the build ends. A finished build is published
even if the record moved during it: its digest covers the exact bytes it folded,
so the next open checks that prefix and extends it, or rejects it if the prefix
was rewritten. A build whose final line was torn is reused only while the record
is unmoved. Publication replaces an immutable generation atomically; concurrent
cold readers can build independently, and an older publication only causes a
later reader to apply more tail. Its spool is anonymous and its result file is
created last, so a killed build leaves at most that one short-lived file. No
cache lock confers authority. Read-only cache paths fall back to a temporary
generation removed on close. A finite watcher does not use this view: it reads
its run from the fold its ownership check already holds.

Resident decoded history is bounded by a batch's subjects (or one large event's
dependencies, or a map an event scans), the largest subject/line, graph/category arrays, and what the
consumer explicitly retains. The in-memory ID/offset index still scales with
the number of subjects; this is not a constant-space claim. Rebuild scratch and
the on-disk projection scale with history/current facts. Close readers promptly:
each owns two descriptors, and an open old generation retains its disk blocks.
There is no unbounded process cache, background loop or live migration.

The focused measurement is `test/record-reader-measure.test.mjs`, selected with
`RECORD_READER_MEASURE_SOURCE` (an isolated captured JSONL file) and
`RECORD_READER_MEASURE_OUTPUT` (durable JSON evidence). It compares one parent
and two concurrent transient children at two history sizes with identical
folded facts and active subjects. The larger input replays resettable real
historical payloads before the original log. Both sizes verify all folded facts
and all events against the legacy reader. It records warm aggregate idle RSS,
conservative summed process high-water marks, read
latency, reader counts and separate cold rebuild costs. This replay is not a live
service census or evidence of reduced installed-service memory. Native process
observation is excluded from sandboxed worker checks: simultaneous sampled peak
is explicitly null/unrun, not zero. Consumers and
ENG-1038 can use its costs; adoption belongs to their separately selected work.

## Existing full-history reader

`events.jsonl` is still the single authoritative record and write order. No log
format, sequence or claim-generation rule changes. Existing and pinned writers
can append as before. `loadEvents` retains its public `{ events, tornTail }`
result. `loadRecord` also supplies a folded state, shared by the CLI and line
observer instead of folding the entire history again.

`record.snapshot` is a private, disposable V8-serialized checkpoint containing
the complete newline-terminated prefix and its fold. Reads verify its checksum,
reader/fold source revision, runtime version, real log path, device/inode/birth
identity, byte boundary and SHA-256 of the authoritative prefix, then parse and
fold only the tail. Replacement, truncation, prefix edits, version skew or an
unusable snapshot cause full replay. Malformed complete log lines still refuse;
torn final input remains visible. A complete EOF event without a newline stays
in the tail until a compatible transaction supplies its newline. Checkpoint
publication is atomic, outside the record lock and best effort. Losing it never
loses record data. Readers can operate without permission to save a snapshot.

This first step keeps the complete event history in the snapshot for existing
callers that scan events. It deserializes that history and hashes the prefix on
each read; it does not claim constant-time reads or a compact live-set view.
Small tails do not rewrite the checkpoint; it refreshes after 128 new events or
1 MiB. The source hash binds the fold and its static dependencies; changes to
those dependencies invalidate snapshots without changing the log format.

`transact` loads and folds before taking the existing lock. Under the lock it
rechecks the exact log identity, size, modification and change times. If a writer
changed the source, it releases the lock and refreshes the snapshot plus tail
outside, then reacquires. This conservative path also detects prefix rewrites
with growth; it does not treat a changed size as proof of an append. A bounded
series of racing preparations refuses before invoking the commit callback.
Once current, the callback runs exactly once under the lock, receives
`(events, state, observation)`, checks current invariants, allocates final IDs,
and returns its additions. Append handles partial writes and fsyncs before
release. Torn-tail repair uses the already validated byte boundary and never
parses the full log under the lock.

Callers may explicitly opt into `prepare(state, events)` in the transaction
options. Preparation runs once, outside the lock, on isolated copies. Without
`subjects`, any intervening event conflicts. With a nonempty list of subject
IDs, unrelated appends may proceed, but changed subject references (including
claims, HOLDs, reports and unknown nested effect references), unscoped controls,
replacement or rewritten prefixes refuse before the commit callback. Declare
all read dependencies. Preparation is an observation, never authority: current
cross-subject graph checks, original effect, native/source/CAS guards and final
ID/sequence allocation still belong in the commit callback. Preparation is
never automatically replayed, including when it has an external side effect.

Existing callbacks have deliberately not been speculatively moved. CLI report
ingestion writes an immutable report file, queue review inspects Git, and
`protectRecordMutation` / `bindCloseoutSources` inspect current queues, Git,
configuration and native/source bindings. They remain under the record lock.
Legacy consumers that call `fold(events)` themselves or call `loadEvents` from
an outer `withLock` also retain that work. Those are residual slow paths; moving
them requires a caller-specific observation/freshness contract. A cached native
observation alone cannot authorize an effect. The line observer's Git and
STOP/HOLD checks remain fresh before effects.

Step 2 adds an explicit `planTransaction` path for the CLI's read-only event
derivation callbacks (add, block/unblock, note, ask/answer, set, close/reopen,
start, worker, abandon, lesson, report intake and queue-review). It prepares the
entire proposed mutation,
promotion queue protection and closeout bindings outside the record lock.
By default the planner runs once. Its full record revision is a conservative CAS
dependency: even an unrelated append invalidates the prepared plan. Only the
explicitly audited, effect-free CLI derivations opt into bounded re-derivation
on a source/read-set conflict (at most 32 attempts); guards refusing authority
are never retried. Commit effects and recovery overrides never replay. A nested
configuration audit revokes planner replay permission, preserving that original effect.
Final IDs, event order and graph/claim/HOLD decisions are valid only if that
exact revision still matches at append. The already encoded additions are
appended and fsynced under the existing lock, with the same tail-repair rules.

Read-only helpers use a scoped filesystem facade to collect file identities,
nanosecond versions, canonical paths, absences and directory listings. Descriptor
reads retain their opened path. Git queries additionally observe mutable refs,
packed refs, config origins, indexes and worktree registrations. The commit
checks those observations with filesystem metadata; it does not rerun Git,
parse configuration or scan queues under the lock. A changed observation refuses
before tail repair or append. The facade does not modify the global filesystem
API and has no effect outside an explicit planning scope.

Report intake defers its immutable report write to a synchronous commit hook.
Queue-review prepares its Git/queue/evidence checks outside, then rechecks its
actual native producer, owner and STOP/HOLD boundary in that same final hook.
Hooks run once after both CAS checks. Queue-review repeats read-set validation
after its fresh native authorization and before immutable publication. A native
refusal never replays the plan or its hook. Claims, native integration and existing outer `withLock` consumers
retain their original one-time callbacks and fresh native checks. They can still
dominate the all-acquisition p95. Non-replayable planning conflicts are explicit
refusals, with no alternate
executor or native retry. Source landing and fixture proof do not establish
the live p95 target; report a matching-source passive cohort separately, and
retain unknowns when existing pinned consumers have not loaded this source.

The first residual correction reuses the store-supplied, source-checked state in
the line-service notice, review boundary/error/health/result/completion commit
callbacks. Review health previously folded the same full history three times
inside its lock. The ownership reader also consumes the state returned by
`loadRecord`, retaining its nanosecond cache invalidation, caller isolation and
fresh Git/fleet/claim checks. No callback or live guard moves, and no external
observation acquires new authority. The ownership cache control counts actual
log opens, including descriptor/range reads, rather than assuming the loader
must use `readFileSync`.

The existing run-timing module writes a diagnostic companion,
`record-lock.timings.jsonl`, after release. Each line reports monotonic
`hold_ms` from successful lock-directory acquisition through removal, separate
`wait_ms`, outcome, actor, source revision, Node and host platform. Failed
diagnostic writes cannot change transaction results. This is neither a record
event nor a background sampler. Include sample count, collection window, source
and ordinary-transaction cohort when calculating nearest-rank p95; small or
mixed cohorts cannot establish the research target of less than 50 ms.

Source landing is separate from selected-consumer/live proof and release.
Nothing here installs a consumer, restarts a service, changes saved runtimes or
pins, partitions the record or redesigns the closeout consumer lock.
