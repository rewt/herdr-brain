# run-ownership/v1

A run has one owning controller in its canonical Git common-directory project
and canonical record. `run.claimed` binds those paths and the run to
`owner: {controller, release: {id, commit, root} | null, legacy}`. The event sequence
is the claim generation (`owner_generation` in `show --json`). Source development
uses its exact Git HEAD and `id: source`; installed jobs use the admitted bundle's
exact root, commit and id. Unclaimed runs have no additional JSON fields. Text
`show` and notice formats are unchanged. Status remains derived from events.

New Brain dispatch claims immediately after record start, before worker effects;
recovery repeats that claim. Watch arming verifies the same admission. Every
Brain entry, including first settle and supervisor restart, uses the claimed
runtime before considering a pin or `current`. Missing or changed bound releases
refuse with `RUN_OWNER_RELEASE_UNAVAILABLE`. A continuation (`--from-run`) inherits
the predecessor's complete owner under the record lock. Old owners drain by
default. An unclaimed run is **not** proof that a legacy controller stopped:
ambiguous watch/settle entries hold with `RUN_OWNER_UNCLAIMED`. Explicitly inventory
and claim legacy work before enabling Brain effects. There is no implicit settle
adoption path without an exclusive admission.

`record claim R-n --controller NAME [--legacy] [--release-root DIR]` claims under
the record lock. An identical owner is idempotent; another owner refuses with
`RUN_OWNED_ELSEWHERE`, naming its owner and generation. Legacy claims may have a
null release and inventory existing effects on their unchanged old path. Initial
Brain claims refuse existing outstanding legacy effects; dispatch claims at its
own new-run admission. Repeated report ingestion, inbox notice IDs, settle receipts
and promotion receipts retain their existing deduplication semantics.

Transfer additionally requires `--transfer-from NAME --expected-owner JSON
--expected-generation N --why TEXT`, comparing the entire current tuple and event
sequence. It records previous owner/generation, new owner and reason. Stale
requests, including a later incarnation with the same name, refuse with
`RUN_CLAIM_TRANSFER_REFUSED`. Transfer conveys no review or promotion authority;
old settlement/request receipts cannot be reused under a new generation.

Effect reservations serialize with transfer: operation/lane lock, then record
lock, then queue lock where needed. Under the record lock consumers recheck the
complete binding and write a durable intent into their operation receipt before
review, correction dispatch, enqueue, completion callback or notice delivery.
The record lock is released before transport or a model runs. V1 refuses transfer
until **all** outstanding effects drain: any unfinished/active settle, incomplete
dispatch or worker callback, enqueuing receipt, queued/current/interrupted
promotion (including validation/integration), unreconciled landing, cleanup,
uncertain delivery or pending callback. Receipts never expire by age or dead PID.
Recovery finishes only its original generation; uncertain effects never relaunch
after ownership changes. Watchers share a canonical-record lock across TMPDIRs;
on a moved claim they stop without delivery or cleanup. `watch --dry-run` is the
only passive comparison: no notice, ingest, process metadata, review, enqueue,
claim or cleanup.

A run-bound enqueue with `--claimed-by NAME` verifies the controller, executing
release and optional `--claim-generation N`; supervisor supplies both flags.
A caller without `--claimed-by` is legacy and is accepted only for unclaimed runs
or legacy claims. Queue members preserve their admission binding on restart.
`record claim` bypasses the prepared-batch write guard only for ownership
bookkeeping: its independent drain check cannot be overridden by
`ORG_GUARD_OVERRIDE`.

Older readers ignore `run.claimed` and unknown fields; this does **not** fence old
writers. BCH adapter obligations (outside this change): arm one watcher per run;
read `.owner` before legacy effects or disable/drain those callers and callbacks
for transferred runs; explicitly inventory in-flight runs with `--legacy` before
switching. Byte-identical `contrib/settle-watch.mjs` remains effectful only on
old-owned jobs. The supervisor submits this contract for acceptance; writing it
does not activate a controller, release or project switch.
