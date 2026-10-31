# Record-first storage and a cold archive lifecycle

Proposed design, 30 October 2026. Producer: ENG-1141 / R-1546,
`lane-eng-1141-9aa54e-998e56` (Sol max). This is documentation, scanning and
unselected planning only. It changes no storage, runtime, brief, policy or pin.
The one Opus review belongs to the existing report queue after delivery; its
verdict and any slice amendments remain pending at this producer handoff.

## Decision requested

Approve a record-first contract, a provisional **14-day** minimum quiet period,
and the bounded implementation slices below for later selection. Approval of
this design does not authorize cleanup, key handling, adoption or deployment.
The record's folders hold active durable work. Cold storage receives sealed,
unreferenced historical bundles through the project's own lifecycle owner.
An archive is searched on demand; it is never a build, proving or agent cwd.

The large opportunity is changing what gets retained and where it is read.
Moving the same uncontrolled copies from `archive/` to `.org/evidence/` merely
renames the growth. Neither a smaller archive nor a successful compression
command demonstrates preservation, correct references or safe last use.

## Current evidence and boundaries

At inspected lane commit `a0440eaf0639215be3fdbbf58086b6599ddb92f9`,
`lib/render.mjs:30,482-485` instruct workers to save durable results in archives.
`lanes/README.md` repeats that rule. `lib/archive.mjs` resolves/display paths;
it is not a lifecycle implementation. Its default fallback does check whether
the default directory exists; the brief's stronger "never reads" shorthand
should not be interpreted as an exact source description.

The owning record already materializes `runs/<R>/brief.md` and `report.md`.
Ingestion additionally preserves `reports/<R>.md` and the report hash
(`bin/org.mjs:818,928-934`). Keep those existing contracts until their readers
are migrated. No event-log format change is proposed. Existing report fields
remain, but new bulk logs, scans and manifests go in files referenced by small
pointers, never as event bodies or enormous notes.

The metadata census found 5,465,922,543 logical bytes in Brain's record,
including 2,716,946,908 in evidence, 516,992,242 in runs and 1,771,214,413 in
line-service. Its live pass journal was 571,191,468 bytes. A later metadata
subtotal found 995,850,367 bytes in 1,818 closeout objects. These observations
have different times and are not one atomic snapshot. The companion
[scan report](record-first-storage-scan-20261030.md) provides classifications,
last-use limits, owners, approvals and evidence paths.

BCH's owner supplied a key-free summary of its 70.6 GiB archive. Brain did not
read BCH's record. Live proving material and keys are **do not touch until M2
completes**; M2 completion is a necessary boundary, not cleanup authority.

## Storage contract

`ORG` means the owning project's actual record directory, not another project's
record and not its event log. `COLD` is an explicitly configured, project-owned
root separate from all live working roots. Existing `archive.dirs` is a legacy
display declaration, not permission to classify, sweep or adopt those paths.
Resolve actual Git common-directory and record identity through existing
guards. A display label or configured path alone confers no authority.

| Material | Active write location and owner | Historical treatment |
| --- | --- | --- |
| Exact dispatched brief and final producer report | `ORG/runs/<R>/brief.md`, `report.md`; dispatch/worker and existing ingestion | One immutable run bundle after terminal obligations clear; retain the ingested report hash and any compatibility copy |
| Run-specific evidence, scans and logs | `ORG/runs/<R>/evidence/` (existing run-local artifacts remain valid); producer | Typed artifact manifest, relative names, provenance, bytes and digest; archive only ordinary non-sensitive artifacts |
| Evidence shared between runs/items | `ORG/evidence/<ITEM>/<R>/` or an existing explicitly referenced per-item location; owning producer | Separate bundle with explicit consumers/leases; a closed producer does not retire open consumers |
| Item brief/index | A small item-to-run/artifact projection in the record; record renderer | Stays searchable while bodies can be cold; no extra bulk copy in events |
| Ingested report compatibility copy | Existing `ORG/reports/<R>.md`; ingestion | Migrate every direct reader before retiring a replica; keep exact immutable report bytes/hash |
| Pass journal | Existing line partition and F1-owned live tail/checkpoints; line | F1 seals/rotates; lifecycle handles only sealed segments with stable coordinates |
| Closeout frames and objects | Existing line partition, `closeout-measurements.jsonl`, `closeout-objects/`; line | Retire frame+transitive object closure together; preserve all current and unresolved references |
| Source and builds | Actual claimed worktree, Git objects and declared disposable build/cache roots; native source owner | Record source commit/range and preservation receipts. Do not copy repositories or node_modules into records/archives by default |
| Scratch and temporary tarballs | Explicit disposable, run-owned workspace/cache location | Excluded from durable outputs. Closeout preserves unsaved work through its existing guarded mechanism; never bypass that mechanism |
| Proving assets and keys used by live work | Project owner's pinned operational store, outside COLD; security/prover owner | Record opaque handles and dependency/provenance references only; no default collector, hashing, relocation or deletion |
| Cold bundles | `COLD/segments/YYYY-MM/<segment-id>/` | Immutable payloads + streaming manifest + catalog reference; no live producer writes |

Proposed replacement for both archive-first brief lines:

> Save the brief, report and durable evidence in this run's record folders, and
> name their paths in the report. Keep shared evidence under its owning item
> with explicit references. Keep source, scratch, builds and live proving
> material in their declared working stores. The project lifecycle owner alone
> transfers eligible closed material to cold storage later.

This text, associated configuration/docs and brief tests belong to slice A.
Do not edit active saved briefs, jobs, runtimes or pins to apply it retroactively.
Existing preservation archives, release bundles and UNKNOWN attempts remain
protected under their original owner and exact receipt. Inventory them; do not
silently reclassify them as disposable copies.

## One lifecycle, with store-specific adapters

The common policy is **seal → protect → stage → verify → publish → retire a
recoverable hot replica**. It covers runs, item evidence, existing consumer
archives, F1 segments and closeout history. An adapter supplies its exact
reference graph and readers; no generic folder-age sweeper guesses them.

The existing finite close/report turn can nominate candidates. A bounded daily
reconciliation by the existing owning line can catch missed nominations. There
is no new model loop, daemon, service restart or worker housekeeping authority.
Initial planning limits are 100 bundles or 1 GiB copied per turn; make progress
resumable by bytes/files for one large bundle. Those limits and N=14 are policy
recommendations for review and consumer adoption, not claims about live settings.

The retention epoch is the latest relevant item closure, final report ingestion,
final review/correction resolution and explicit dependency-release timestamp.
Eligible time is that epoch plus 14 days. A missing epoch, reference or outcome
means protected/unknown. Later reopening cancels an uncommitted plan and starts
a new quiet period; timestamps on files never advance eligibility by themselves.

| Store | Additional eligibility and handling |
| --- | --- |
| Closed run/item folders | No open producer, review, correction, dependent item, reserved decision, lease or preservation/closeout obligation requiring their bytes. Shared artifacts are independently protected. Run/item identity and original report hashes survive |
| Legacy consumer archives | Owner first maps every candidate to record/run/source and live readers. Live keys, repo/build/scratch candidates and unmapped entries are held for an owner action; do not sweep or bulk-import them into record evidence |
| Pass journal | F1 alone rotates and maintains notice-audit/halt checkpoints. Preserve row bytes, segment ID, absolute logical byte range, generation and hashes. All active replay/recovery checkpoints must resolve before a sealed segment can become cold |
| Closeout frames/objects | Build roots from current measurement frames, every retained historical frame, diagnostic/review/correction evidence, unresolved effect/preservation receipts and external references. Traverse object-to-object references. Unknown/corrupt roots hold the complete affected closure |
| Other growing bookkeeping | Inventory `closeout.log`, measurement history, dispatch/settle/watch receipts and report replicas. Add typed adapters; keep live effects, callbacks, claim/native history and original UNKNOWN/refused attempts hot unless their readers explicitly support cold resolution |
| Derived caches | `record.snapshot`, `record.reader` and lookup caches are rebuildable projections with their existing owners, not archive evidence or an excuse to alter `events.jsonl`. Cache policy is separate from historical retention |

An open descendant protects the artifacts it consumes; a parent's done label
does not declare a whole subtree collectible. Missing explicit dependency
tracking fails closed. A future reader that needs historical evidence for active
work acquires a lease and materializes the required ordinary artifact into the
record before treating it as working input. On-demand historical reading/search
can stream from COLD without making COLD a proving/build working directory.
Keys and sensitive material use their owner's separate approved process.

## Pointer, catalog and on-demand lookup

Each cold segment has a streaming `manifest.jsonl` with project identity,
original relative path, item/run, role, source reference, byte count, digest and
payload location for ordinary non-sensitive files. Segment headers/trailers
bind entry count, logical byte totals, manifest digest and schema version.
Use bounded streaming reads, including for large manifests; do not repeat the
pass-journal whole-string failure. Proposed sealing limits are 1 GiB or 10,000
entries, whichever comes first; oversized artifacts can occupy their own
streamed segment. Compression is optional future storage policy, not a premise
of safety, byte accounting or random lookup.

Keep `ORG/runs/<R>/archive-ref.json` and a small item projection after retiring
hot bodies. A pointer binds schema, project/common-directory identity, item/run,
segment ID, manifest digest, original names/digests and publication generation.
Large per-file lists stay in the cold manifest; hot stubs target <=4 KiB.
Catalog shards roll at <=8 MiB and are indexed by month and item/run; rollover
avoids another permanently appended giant index. A disposable local lookup can
be rebuilt from sealed manifests. Catalogs/pointers are retained for the project
lifetime; their bodies/old shards can be cold without losing the current small
root and item/run lookup. No raw bulk goes into the record event log.

An illustrative API, not an implemented command, is:

```text
resolveArtifact(owningRecord, item, run, originalRelativePath, expectedDigest)
searchArchive(owningProject, itemOrRunOrLiteralPath, boundedWindow)
```

Resolution prefers verified hot bytes, otherwise validates the pointer,
manifest, expected project/digest and payload, then opens only that artifact.
Reject absolute/traversing manifest names, symlinks, redirected roots, foreign
identities, conflicting generations, changed payloads and unavailable cold
storage. An unavailable segment is a named unresolved retrieval, never "no
evidence" or permission to substitute another artifact. Search returns source
pointers and provenance; it does not infer decisions, authority or obligations.
This is a storage interface for ENG-1039/1040, not a second Stage 4 retriever.

Do not replace a `report.md` or `brief.md` with JSON or a textual stub that an
old reader might ingest as original evidence. Sidecar pointers plus resolver
migration are required. Keep raw hot replicas while any direct-path reader,
saved callback or consumer remains unported. Do not use symlinks to fake this
compatibility. Source report hashes and immutable stored reports remain exact.

## Crash safety and concurrency

The transaction identity is a stable tuple of project, bundle identity,
sealed source manifest digest and destination segment. New attempts cannot
replace an existing intent or UNKNOWN state. Durable step receipts live in the
owning record's lifecycle operation folder, not the event log's bulk payload.

1. **Plan and reserve.** Capture source generation, terminal/reference facts,
   paths and intended ordinary payload digests under the owning adapter's
   guards. Refuse sensitive candidates, symlinks, STOP/HOLD, foreign sources,
   unsupported dependencies and in-flight effects. Register a protected lease.
2. **Stage.** Copy sealed ordinary files to an exclusive destination staging
   directory, streaming them and recording verified progress. Sources stay
   readable. Never rename across filesystems as a pretend atomic transaction.
   Insufficient space, an I/O error or changed source holds the original plan.
3. **Verify and seal.** Compare every intended size/digest and the complete
   manifest; flush files and containing directories using the supported
   filesystem contract, then publish the immutable segment with exclusive,
   same-filesystem publication. Existing destinations must match the original
   intent exactly; conflicts remain held. No key/secret content enters this path.
4. **Publish references.** Recheck ownership, source generation and all live
   dependencies. Atomically publish the catalog generation and record pointer
   with a recoverable journal tying the two. An incomplete pair leaves hot
   bytes authoritative. No source replica is retired before both are durable
   and resolution succeeds through the published generation.
5. **Retire only a recoverable replica.** After compatibility readers and leases
   clear, repeat dependency/STOP/HOLD checks, verify the original plan/pointer
   and durable cold copy, then retire only the enumerated hot ordinary files.
   This is a later explicitly selected owner action, not this run. No cold
   expiry, irreversible purge, key deletion or unrelated tree removal is implied.

The reference/lease guard must serialize new consumers, reopen/correction
admission, pointer publication and hot-replica retirement. Acquire it outside
the record transaction; never acquire a storage guard while holding the record
lock or hold a record lock during copying/hashing. Respect the project's
existing outer maintenance/pass/promotion lock order. A new consumer either
pins the old hot generation before retirement or resolves/pins the committed
cold generation; it cannot race between the eligibility observation and unlink.
Prove this ordering in the adapter's affected concurrency controls before use.

| Interruption point | Authoritative bytes and resumption |
| --- | --- |
| During copy/verification | Hot originals and original plan remain authoritative. Resume only verified files under the same operation; partial destination never resolves |
| Segment sealed, no pointer/catalog pair | Hot originals still resolve. Finish publication using the original sealed manifest; do not duplicate the segment |
| Only one reference publication durable | Recover its journal to the matching generation or retain hot originals. A lone catalog or pointer cannot authorize retirement |
| Both published, hot replicas remain | Both are valid identical generations. Resume retirement only after fresh dependency/compatibility checks; reclaiming the duplicate is optional |
| During replica retirement | Every removed file already resolves through the verified cold manifest. Resume the enumerated remainder under the same intent; new leases/reopening stop further retirement |
| Corrupt/unavailable destination or UNKNOWN effect | Keep surviving sources, pointers and receipts. Report the original exception to the project supervisor; no replacement plan, silent fallback, purge or native retry |

Cold storage is retained indefinitely by default. Backups/disaster recovery and
any later expiry need an explicit owner policy and real reserved authorization
where data would be irrecoverable. Archived safety receipts are not discarded
to achieve a byte target. Byte-identical payload deduplication is possible for
ordinary evidence after approved hashing, but names/sizes never prove equality.

## A real closed item traced through the proposed lifecycle

This is a design walkthrough, not an executed move or a passing resolver test.
The real item is **ENG-1058**, run **R-1434**. At record cutoff 48808 it was
closed as done at `2026-10-31T01:08:15.431Z` (event 48576), with no child items.
The existing files are:

| Role | Current record source | Observed bytes |
| --- | --- | ---: |
| Brief | `runs/R-1434/brief.md` | 11,259 |
| Report | `runs/R-1434/report.md` | 42,106 |
| Per-item evidence | `evidence/ENG-1058-R-1434/`, 23 files | 1,288,436 |

Dispatch wrote the brief, the worker wrote the report, and the record retained
its ingestion copy/hash. Evidence includes prompt/delivery manifests and the
original record actions. The global r4.1 plan and slice prompts referenced by
active items are separate shared artifacts; this walkthrough does not sweep
them or assert that a closed producer makes them eligible.

If the owning adapter proves all byte consumers, review/correction and
preservation obligations clear, the earliest age boundary from this closure
alone is **14 November 2026, 01:08:15.431 UTC**. Later dependency resolution moves
it later. Eligibility of this real bundle today is **not established**. At a
future eligible turn, the plan enumerates the real brief/report/evidence paths
and original digests, stages them into a dated ordinary-evidence segment,
verifies them, then publishes `runs/R-1434/archive-ref.json` and an index entry
under `ENG-1058` / `R-1434` / original literal paths. `resolveArtifact` follows
that pointer to the exact original bytes; `searchArchive` finds their manifest
entries. Legacy raw paths remain until their readers migrate.

If an open review or correction references `prompt-manifest.json`, the evidence
bundle stays hot even after 14 days; the owner records the blocking source,
not a fake archive success. If a crash follows sealing but precedes pointer
publication, the original record files still resolve and the same operation
resumes publication. If it follows partial replica retirement, the already
published pointer resolves every removed path and the operation skips already
verified progress. Implementation must demonstrate these witnesses in an
isolated consumer; no real item was moved to illustrate this design.

## Keep working state out of archives

At brief generation, export and lifecycle nomination, inspect paths/types and
declared artifact roles. Deny cwd/output destinations under COLD for active
work. Reject repository trees (`repo-R*`, `.git`, checkouts), `node_modules`,
compiler/build output, scratch and live proof/key dependencies as historical
payloads. Existing recovery/release artifacts keep their original protected
authority; migrating them requires their actual reader/owner contract.
A filename detector is advisory for unknown sensitive material and cannot
prove that a file is key-free. Sensitive/unknown candidates require owner
classification before the ordinary-content verifier may open or hash them.

The guard reports item/run, path class, producer and the proper live store. It
never deletes, moves, repairs, hashes keys, changes a live pin or automatically
blocks unrelated work. A metadata census remains read-only and reports errors,
logical/allocated bytes, class coverage, references and unclassified bytes.
Last-use evidence comes from bound consumers/source/runtime references; atime,
mtime, age, duplicate names and missing Git grep matches are insufficient.

## Build slices and ownership

Standalone prompts and the exact filed IDs live in `ORG/runs/R-1546/slices/`
and `build-slices-final.json` (original receipts in `build-slices.json`). All
are filed under **ENG-1024, unselected**; filing
is no implementation/adoption authority. The reviewer partners by assessing
these boundaries and recording specific amendments/follow-ups in the same
single review. No parallel review or pre-code concurrence is required.

| Slice | Owned result and seam | Prerequisite/interface |
| --- | --- | --- |
| A — ENG-1153: record-first contract | Brief/report durable-path guidance, compatible artifact references and documentation; `lib/render.mjs`, archive/config display, brief controls | Can start independently after selection; does not move existing files |
| B — ENG-1154: sealed segments and resolution | Immutable ordinary-evidence manifest, catalog, pointer, bounded lookup and resumable publication; one storage module owner | Supplies schema/resolution before C/D can retire any replica; migrate existing raw readers |
| C — ENG-1155: closed record lifecycle | Eligibility/reference leases, run/item adapter, finite close/daily nomination and recoverable replica retirement | Uses A/B; no cleanup of current archives or irreversible expiry |
| D — ENG-1156: line-history adapter | Measurement-frame/transitive-object reachability and other typed bookkeeping retention; resolve F1's sealed segments | Uses B and ENG-1149/F1's actual contract. F1 alone owns journal rotation/checkpoints; no second rotator |
| E — ENG-1157: archive guard and consumer proof | Working-state guard, metadata classifier, isolated lifecycle/recovery/soak evidence and owner action/offer plan | Uses A-D where applicable; reuses ENG-1127's canary/offer owner; no BCH cleanup or adoption |

Brain source owners implement only selected slices. BCH's project supervisor
**supervisor-opus** owns its post-M2 storage/security/cleanup proposals. The
operator retains key deletion, irreversible deletion and other reserved effects.
Each consumer decides adoption through the existing canary/offer path; neither
"new items from Monday" nor a Brain design approves BCH activation.

## Evidence required before using the implementation

The design/scan run has an empty executable-check selection. No product,
release, live-acceptance or reviewer suites were run. Future selected producers
choose only affected controls and run them once via the existing lane runner;
the single Opus reviewer runs zero suites. Full final-release coverage and live
acceptance remain with their release/adoption owners.

Future controls must demonstrate exact original bytes after record→cold
resolution, literal item/run/path search, cross-filesystem staging, interrupted
publication and replica retirement, idempotent original-intent resumption,
reopening/lease races, open review/correction/live dependency holds, unavailable
or corrupt segments, unknown references, symlink/path escape rejection and
legacy raw-reader compatibility. D additionally proves historical measurement
reconstruction with shared objects and F1 checkpoint/window replay across cold
segments. E measures bytes by class with >=90% accounted, no secret-content
reads, bounded hot metadata, active archives receiving no new working output,
and separate Brain soak/installed consumer evidence under the exact candidate.

Report bytes retained/moved, duplicated hot replicas, unresolved dependencies,
unknown classification and actual retrieval results separately. A reduced
folder size without valid pointers, reproducible original evidence and owner
receipts is not success. The sole post-delivery review may produce linked
correction/fix-forward work; original verdicts and Majors remain obligations
before stable adoption, without holding finished producer source for a verdict.
