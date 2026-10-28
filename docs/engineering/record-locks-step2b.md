# Record lock preparation and remaining effects

`prepareRecordGuard` derives read-only authority from one parsed/folded record
outside its lock. Its single-use execution checks the full record signature and
observed files after acquiring the lock. A conflict runs no effect and never
replays the native observation. Batch guards prepare all members first and check
all sources only after every distinct record lock is acquired. Unknown events
remain full-record CAS inputs; no event schema or old-fold behavior changes.

The owning command keeps its operation/promotion/queue locks and native checks.
This is preparation, not a lease that authorizes a later unguarded action.

| Path | Preparation outside record lock | Still serialized |
| --- | --- | --- |
| `lib/run-owner.mjs` fenceOwner / claimRun | Namespace, fold, ownership generation, receipt/queue reads | Durable reservation write / claim append |
| `promote/own-worktree.mjs` | Fresh native worker, project, source, claim, HOLD and question checks | Exact source/file CAS and supplied FF operation |
| `promote/guard.mjs` single / batch | Git, configuration, completion and readiness derivation for all members | All record/file fences and FF |
| `promote/promote.mjs` enqueue | Native worker, claim, release, record admission sequence | Queue lock wait and durable queue commit; ordering remains record then queue |
| `line-service/phase1.mjs` results / completion | Service binding, immutable bytes, verdict/corrections, queue and closeout derivation | Prepared append/fsync; initial boundary retains fresh Git status |
| `lib/landing-receipt.mjs` | Native binding, claim, commit list/parents, Git and queue preparation | Fresh worktree status and append; no invented landing time |
| `lib/closeout-unsent.mjs` | Loaded-code verification, reflog proof and source/queue ownership checks | Proof append; no native action or UNKNOWN outcome replay |
| `lib/store.mjs` initOrg | None (small local initialization) | Initial config write |

Legacy `transact` remains an effectful single-shot API. Other consumers include
configuration-audit publications, closeout-executor intent/result callbacks,
closeout handoffs/recovery and retirement, decision applications, review recovery,
cutover/runtime migration, and dispatch completion/binding. They are not blanket
converted: immutable archive/configuration/native actions need their own audited
preparation and commit boundary. In particular, native decision applications and
closeout intents retain their current authority. These paths and the serialized
FF/queue/status effects can still exceed 50 ms. The existing service and saved
runtimes are not restarted or rewritten to manufacture adoption evidence.

Successful acquisitions retain the timing journal. `owner-reservation`,
`own-promotion`, `promotion-guard`, `batch-promotion` and `promotion-admission`
identify formerly anonymous outer callbacks. The source fingerprint continues to
identify the store/fold implementation, not a claim about every loaded module.
Use source path, immutable head and collection window together.

Recovery requires a positive PID and an ESRCH probe. A live/reused PID, EPERM,
missing or malformed PID remains UNKNOWN regardless of age. New writers must
publish their PID before running a callback. Reclaimers serialize inside the
exact dead directory, recheck its inode and owner, and rename it to a private
detached path before deletion. A stale reclaimer or old releaser cannot delete a
new lock using its old identity. Dead reclaimers can be recovered recursively;
an unidentifiable initializer/reclaimer or excessive recovery depth stays held
for inspection. Explicit `recover:false` callers still neither probe nor recover.

Latency acceptance uses passive real-load cohorts, all acquisitions as well as
matching source, nearest-rank p95, sample counts and UTC windows. Acquisition
telemetry alone does not count failed lock attempts and cannot prove a working
day with zero lock-busy refusals. No short cohort is full acceptance or a release
PASS. Producer checks are selected once through lane check; independent review
uses the owning report and existing record queue, with no reviewer suites.
