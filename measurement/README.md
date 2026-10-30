# Consumer lifecycle baseline

`bin/measure-lifecycle.mjs` is a dependency-free, model-free historical reader.
It prints JSON to stdout and never changes a record, runs a native command, or
closes anything. Redirect output only to your own evidence directory.

```sh
node bin/measure-lifecycle.mjs --events /project/.org/events.jsonl \
  --project /project/repository/.git \
  --from 2026-10-30T00:00:00Z --cutoff 2026-10-30T22:30:00Z \
  --hand-actor supervisor-name > /own/evidence/baseline.json
```

Use the configured project's **real Git common directory**, not a display label.
Explicit timestamps include a timezone; both endpoints are inclusive. UTC-day
and local-day windows differ. Starts are `run.started` events with that recorded
`meta.dispatch_project`. The default line actor is `line-service`; repeat
`--line-actor` and `--hand-actor` to declare others. Hand means owner-initiated
dispatch, not proof that a human personally typed a command. Other actors are
unknown. Starts count allocated attempts, including failures; session-bound
starts are reported separately. Legacy starts without a project binding are
listed as unscoped, never silently assigned to this project.

The run table includes starts in the window and carry-in runs whose report was
observed or ingested in the window. Latency and resource summaries use only that
**report cohort**. Report origin is the first matching original-watcher
`report.available.observed_at`, joined to run start, claim generation and ingested
report hash. This is a report *observation*, an upper bound on writing time; file
mtime, ingestion time and current folder absence do not substitute for it.
An ingested report without that origin remains in the denominator as unknown.
Ingestion throughput is counted by ingest event time, separately from starts.

Item closure requires `item.closed.completed_run` and `as: done`; older manual
closures lacking attribution are unknown. Folder/session retirement requires an
actual `closeout.effect` cited by a typed `closeout.evaluated` resource, joined by
run, project, source seq/type, allocation key, effect ID and ordering. Tabs require
the closed session receipt's explicit tab ID. Repeated evaluations count once.
Explicit kept resources are pending with their recorded owner/reason; no receipt
and no explicit hold is unknown. Unknown owners stay null for the owning line to
resolve. Per-run pending rows and owner/reason groups are included. Resource
counts are per run, not a count of unique physical tabs shared across runs.

Latencies use milliseconds, the ordinary median and nearest-rank p90. Counts show
known and unknown denominators. Missing, negative and not-yet-observed durations
are null, never zero. Censored runs remain unknown and are not included in the
quantiles; compare completion coverage alongside speed to avoid survivor bias.
Unreported starts remain visible in `runs`, outside the report cohort.

Optionally pass `--census FILE` for an existing closeout measurement v1/v2 frame.
The content-addressed reader verifies referenced object hashes. The project,
observation time and record sequence must fit the cutoff. The saved Herdr and
folder observations appear separately with their original time and coverage;
they never prove a retirement action or timestamp. No live native reads occur.
Copy the decoded frame into your evidence if the service's latest file can move.

Only explicit `closeout.manual-assistance` events count as recorded hand nudges.
Historical records do not journal all prompts or rescues, so the total is unknown
even when the explicit count is zero. Free-text notes cannot establish a complete
count. This tool measures evidence; it does not repair that instrumentation gap.

Save the input event snapshot and census with your evidence. Output records a
hash of selected events, census inventory hash, cutoff and sequence fence. Repeat
with `--through-seq N` from the first output to freeze the event boundary. The
same inputs/cutoff/fence produce identical bytes. Malformed JSON and out-of-order
sequences fail closed; events with missing timestamps inside the fence remain
available for joins and are listed diagnostically. No current clock is consulted.

Focused checks: `node test/helpers/run.mjs test/consumer-lifecycle.test.mjs` through
the owning clean committed lane's `lane check --cmd`. Full release suites and
live acceptance belong to the release owner.
