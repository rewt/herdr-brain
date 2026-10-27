# Record snapshots and short transactions

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
