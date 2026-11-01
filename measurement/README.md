# Consumer lifecycle baseline

The saved-input soak producer can also emit the offer's probation stage from
the verified original trial archive, without hand-written status wrappers:

```sh
node bin/evaluate-canary-soak.mjs --events /own/evidence/events.jsonl \
  --trial /own/evidence/trial.json --probation-output /own/evidence/probation.json \
  > /own/evidence/assessment.json
```

Use a fresh output path; existing probation output is never replaced. The stage
retains the archive path/hash and binds the exact assessment bytes and candidate
tuple. FAIL/INCOMPLETE assessments produce the same nonpassing stage status.
The offer reader accepts the installed canary and soak's native `candidate.commit`
binding, checks consistent tuples, and verifies the probation archive and assessment
binding. This command performs no service, trial, offer, activation or release effect.

Supervisor retirement adds a read-only [duty/absence coverage annex](RETIREMENT-COVERAGE.md)
to the existing installed soak; it creates no second observation service.

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

Explicit `closeout.manual-assistance` and `lifecycle.manual-nudge` events count as recorded hand nudges.
Historical records do not journal all prompts or rescues, so the total is unknown
even when the explicit count is zero. Free-text notes cannot establish a complete
count. The supported journal below makes prospective interventions measurable;
it cannot establish that every intervention was recorded.

The owner performing a manual lifecycle prompt, rescue or recovery is responsible
for journaling it promptly in the owning project:

```sh
ORG_ACTOR=your-worker node bin/org.mjs nudge --id R-123:report:prompt-1 \
  --run R-123 --project /project/repository/.git --actor assisting-owner \
  --occurred-at 2026-10-31T08:00:00Z --stage report \
  --action 'Prompted the worker to finish its report' \
  --reason 'The report had stalled' --evidence /own/evidence/prompt.txt
```

Use one stable ID per actual intervention, and reuse the exact arguments for a
retry. The locked append writes once; a changed payload or intervention actor under
the same ID is refused. A new intervention needs a new ID. Record it promptly,
including failed interventions and their later recovery as separate actions.
Do not journal the same action again if an existing manual-assistance event
already records it. The command records what happened; it executes no prompt or
recovery and grants no native authority. `--actor` attributes the actual assisting
owner; the store's `by` separately preserves the recorder. Neither grants native
authority, and a retry retains the original recorder.
Stage, action, reason and evidence are required descriptive text; they are not
inferred from notes. Run binding, real Git identity and record ownership must
match; unscoped/foreign runs and times before run start or after recording fail.

The promotion write guard also covers this journal: if the run's item or its
parent belongs to an open promotion, `record nudge` can refuse with
`promotion write guard REFUSED` without appending. Save the intervention's exact
arguments and evidence in your owned evidence directory, then retry after that
promotion is refused, times out, or completes reconciliation. A green check or
fast-forward alone may still leave reconciliation pending. Keep the same stable
ID, actor and original `--occurred-at`; do not use `ORG_GUARD_OVERRIDE` just to
journal an intervention. The assisting owner remains responsible for recording
the deferred entry. Its occurrence time can precede recording, but projections
whose cutoff or sequence fence precedes the append still exclude it. Capture a
later projection to include the entry; earlier snapshots remain incomplete.

The projection's `hand_nudges.journal` retains each journal event's stable ID,
project, run, actor, occurrence time, recording receipt, stage, action, reason and
evidence. Journal events use occurrence time inside the window and must also have
been recorded by the cutoff/sequence fence. Legacy events retain recording-time
semantics. `recorded` combines the two explicit sources; `total` remains null.
This changes neither the canary rescue policy nor any consumer's runtime or hooks.

Save the input event snapshot and census with your evidence. Output records a
hash of selected events, census inventory hash, cutoff and sequence fence. Repeat
with `--through-seq N` from the first output to freeze the event boundary. The
same inputs/cutoff/fence produce identical bytes. Malformed JSON and out-of-order
sequences fail closed; events with missing timestamps inside the fence remain
available for joins and are listed diagnostically. No current clock is consulted.

Focused checks: `node test/helpers/run.mjs test/lifecycle-nudge.test.mjs test/consumer-lifecycle.test.mjs` through
the owning clean committed lane's `lane check --cmd`. Full release suites and
live acceptance belong to the release owner.

Recorded live witnesses use the existing finite line turn and result-only item
notes; see [live witness specifications and evidence rules](LIVE-WITNESSES.md).
