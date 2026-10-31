# Storage census and proposed owner actions — 30 October 2026

ENG-1141 / R-1546. Brain producer/verifier:
`lane-eng-1141-9aa54e-998e56`. This report records metadata observations and
proposals only. No existing data was moved, deleted, rewritten or compressed.
Scanned input files were not opened, read, hashed or decompressed. Key/secret
contents were never read. Ordinary design/record/source documents used for
context are separate from the metadata scan.

## Provenance, units and limits

Brain's original census ran **2026-10-31 01:31:09.593–01:31:15.850 UTC**
(30 October, 20:31 CDT). Its roots were the owning record
`/Users/rewt/development/rewt/.org` and the configured Brain source
`docs/reports` and `docs/archive`. Record evidence/proposals are already inside
the first root and are not counted twice. The scanner used `os.scandir` and
non-following stat only. Its own new outputs were excluded from the baseline;
the assigned brief was included. No links were followed, and there were no
enumeration/stat errors. Root/per-file metadata were observed on live stores,
without locks or an atomic snapshot.

Durable evidence under `ORG/runs/R-1546/`:

- `scan-brain-metadata.py` and `brain-metadata-scan.json`: original method,
  counts, class totals, top groups, 160 largest files per root, timestamps,
  name-only sensitive candidates and hardlink aliases.
- `derive-scan-tables.py` and `scan-tables.json`: classifications refined from
  those saved names (known record caches and compressed logs), with the
  original census unchanged; one additional closeout-object subtotal observed
  at **01:33:24.400 UTC**. It also used only metadata.
- `record-context.json`: record cutoff **48808**, source digest, actual run
  claim/worker, active F1 ownership and the real closed-item trace.
- `source-evidence.json`: exact source/input and evidence hashes, including the
  approved key-free BCH relay, for reuse by the single reviewer.

Logical bytes count each regular-file path. Allocated bytes are `st_blocks *
512`, also per path; they are not an assertion of unique physical/APFS space
or compression/dedup savings. Links and directory sizes are excluded from byte
denominators. MiB/GiB use powers of 1024. Metadata classification is by
namespace/name/type, not by reading payloads or deciding archival eligibility.
Atime/mtime never prove the last live read, nor absence of an open file/consumer.

## Brain accounting

| Non-overlapping root | Logical bytes | Allocated bytes | Files / directories / links | Classified bytes |
| --- | ---: | ---: | --- | ---: |
| Owning record | 5,465,922,543 (5.091 GiB) | 5,681,336,320 | 75,631 / 10,135 / 1 | 99.9993% |
| Source `docs/reports` | 13,815,474 (13.175 MiB) | 16,601,088 | 1,217 / 170 / 0 | 99.0360% |
| Source `docs/archive` | 10,425 | 24,576 | 4 / 1 / 0 | 100% |

Classification exceeds 90% for each Brain root, without counting unknown bytes
as a known class. Substores below are overlapping views of the record, not
additional disk usage:

| Growing record substore | Logical bytes | Allocated bytes | Files | Namespace classes covered |
| --- | ---: | ---: | ---: | --- |
| `evidence/` | 2,716,946,908 | 2,833,022,976 | 51,185 | Evidence/history plus name-identified package, repo/dependency and sensitive candidates; no unclassified payload bytes by this namespace rule |
| `runs/` | 516,992,242 | 530,448,384 | 5,584 | Run evidence/history and any name-identified special classes; live status is separate |
| `reports/` ingestion copies | 11,536,302 | 14,561,280 | 1,490 | Record report history |
| `proposals/` | 682,746 | 765,952 | 38 | Record planning/evidence |
| `line-service/` | 1,771,214,413 | 1,810,100,224 | 2,336 | Operational bookkeeping, including historical evidence; not all cold-eligible |
| Live `passes.jsonl` (inside line-service) | 571,191,468 | 587,649,024 | 1 | Pass audit; live checkpointed input |
| `closeout-objects/` (later subtotal) | 995,850,367 | 999,530,496 | 1,818 | Closeout evidence objects; reachability unassessed |

All the growing record stores are included; 100% namespace classification of
record evidence is not proof that every payload is historical or safe. The
global special-class totals below prevent repository/package candidates being
hidden as ordinary reports. The later object subtotal must not be subtracted
from the earlier line total as if both were a frozen census.

| Record class (mutually exclusive) | Logical bytes | Meaning and restriction |
| --- | ---: | --- |
| Record evidence/history | 2,431,847,888 | Exact record namespaces; active dependencies not assessed globally |
| Line bookkeeping | 1,771,214,413 | Live and historical frames, objects, checkpoints and receipts |
| Scratch **or package candidates** | 730,808,832 | 26 tar/zip/scratch-named files; includes runtime/release packages, not 730 MB of proven disposable scratch |
| Other record/evidence/logs | 327,994,090 | Includes events and operational histories; no event-log-format change or sweep proposed |
| Repository/dependency-copy candidates | 83,473,320 | 1,331 paths under `.git`, `node_modules` or `repo-R*`; does not count every surrounding checkout as this class |
| Known disposable record caches | 120,516,080 | `record.snapshot`, `record.reader`; source names confirm derived projections |
| Sensitive-name candidates | 28,158 | 13 paths; mostly names such as `docs/reviews/identity-keys/*.md`. This is not proof of real key material or absence of other keys |
| Unknown metadata class | 39,762 | 17 regular files; no eligibility claimed |
| **Total** | **5,465,922,543** | No content inspection or content deduplication |

For source reports, 8,920,642 bytes are ordinary report/evidence paths and
4,761,656 are 19 compressed `.jsonl.gz`/`.log.gz` historical log names identified
from the original census. The remaining 133,176 bytes are unknown (0.964%).
No compressed file was opened. All four source archive files are historical
pilot documentation/scripts by namespace. Git-tracked historical source files
require an owned source change if a later migration is selected; they are not
untracked data for a housekeeping deletion.

The record has four observed hardlink aliases. They are a duplicate-storage
overlay, not another class or reclaimable byte promise. Repeated captured event
logs, runtime tarballs and checkouts are **duplicate candidates only**: different
cutoffs and preservation contracts may make every copy necessary. No content
hash comparison or cleanup was performed.

## Large Brain items, last-use evidence and proposed actions

Times below are UTC metadata observations. The full raw rows retain atime and
mtime without using them as last-use proof.

| Item | Size / mtime / atime | Dependency or last-use evidence | Proposal, owner and approval |
| --- | --- | --- | --- |
| Live line `passes.jsonl` | 571,191,468 B; 01:31:01 / 01:31:05 on 31 Oct | `line-service.mjs` appends and replays it using `notice_audit_offset`; active F1 ENG-1149/R-1541 | **Keep live tail.** F1 owner alone seals/rotates without losing row/checkpoint coordinates; lifecycle may later relocate only sealed, unreferenced segments under selected policy |
| `evidence/ENG-1149/R-1541/real-copy/passes.jsonl` | 570,870,990 B; 01:26:30.949 / 01:26:30.517 on 31 Oct | F1 is active at captured record cutoff; this is producer witness material | **Do not touch.** F1 owner retains it through its review/correction/release obligations; later ordinary evidence lifecycle requires explicit dependency clearance, not a duplicate label |
| `closeout-measurements.jsonl` | 164,898,745 B; 01:30:52.714 / 01:30:52.714 on 31 Oct | Live writer and measurement readers in source; per-frame object graph remains in use | D owner designs frame sealing + exact historical reconstruction; no age-based deletion. Selected source/retention policy needed |
| `closeout-objects/` | 995,850,367 B, 1,818 files; later subtotal | `readCloseoutMeasurement` validates strict `closeout-objects/<hash>.json` paths and transitive objects; current refs are not a reachability census | **Keep all for now.** D must migrate the reader and collect the complete retained-frame/recovery reference closure before relocation or recoverable replica retirement |
| `evidence/STABLE-RELEASE-20261027/` | 423,991,396 B | Release/candidate checkouts and live-evidence namespaces. Current pin/rollback/consumer last use is unknown to this scan | Release owner inventories references and can reduce redundant copies only after proving all original release/rollback receipts resolve. No current cleanup authority |
| `evidence/ENG-536/` | 414,146,585 B | Large historical evidence namespace; actual last use and consumers unknown | Its evidence owner classifies references before C nominates it; preserve original reports/attempts. No deletion recommendation from size alone |
| `evidence/ARCH-38/R-744/runtime.tar` | 87,276,032 B; 22 Oct 15:35:13 / 15:36:34 | Runtime package by path; whether referenced by recovery/rollback is unknown | Owning release/preservation owner decides keep or later cold relocation. Package classification alone never means scratch removal |
| `evidence/ENG-931/R-1324/older-live-plan.json` | 77,849,840 B; 29 Oct 10:08:48 / 19:35:35 | Captured plan name suggests evidence, not a proof of obsolescence | Evidence owner establishes consumers; ordinary cold retention after eligibility; no rewrite of prior evidence |
| `evidence/ENG-1130-R-1525/` | 124,074,442 B, including BCH/Brain captured logs | This is already Brain-owned captured evidence; no BCH root was read for this scan. Last consuming review/correction unknown | Retain immutable capture provenance. C/D owner can archive only after the record reference graph clears |
| Repeated captured record logs | Several 49–52 MB originals in the largest-file list | Names/sizes and different capture paths establish candidates, not content equality or dispensability | Owning producers retain witness cutoffs; future ordinary hashing/dedup requires selected non-sensitive policy and exact shared references |
| `record.snapshot`, `record.reader` | 80,607,180 B + 39,908,900 B | Owning source declares them disposable projections; they were recently maintained | Keep under existing cache owners/bounds; no need to archive copies or change the event log. No cache deletion executed |
| `runs/` and ingested reports | 516,992,242 B + 11,536,302 B | All brief/report consumers, saved callbacks and original ingested hashes must remain valid | A/B/C owners migrate readers before cold transfer; retain active reports. Do not discard the ingested replica simply because another path exists |

This census found no confirmed large live proving/key store inside Brain. A
path-only scan cannot certify absence of secrets or identify unmarked key files.
Sensitive-name candidates remain unopened and require owning classification.

## BCH: reuse of its own owner's scan

Source producer: **bch-phase3-chat under the BCH identity**, approximately
**20:15–20:25 CDT on 30 October**, recorded on **BCH G-20**. The BCH project
supervisor **supervisor-opus** relayed it; **supervisor-herdr** supplied the
approved key-free summary at
`ORG/evidence/ENG-1141-BCH-ARCHIVE-SCAN-20261030.md` (ENG-1141 notes 48770,
48775, 48781). The original BCH `REPORT.md` / `archive-inventory.json` are
owner-held provenance pointers, **not read by Brain**. Supervisor-herdr explicitly
directed reuse, no new scan, and no wait for the metadata addendum.

The original request `R-1546:exception:bch-owner-scan` was durably queued
(exit 3, `delivered:false`, `queued:true`, inbox owner PID 47065). The subsequent
supervisor replies supply the evidence; they do not retroactively change that
original native receipt into a delivery success. No retry/replacement was made.

The owner reports **70.6 GiB**, **12,155 top-level entries** (3,196 directories,
8,959 files). Seventeen entries >=200 MB total **63.5 GiB**. The producer used
names, sizes, types, timestamps and BCH-source grep references; no key contents
were opened/hashed and no material was moved.

| Class | Reported GiB | Last-use/reference evidence | Proposed post-M2 action and actual authority |
| --- | ---: | --- | --- |
| Live proving material | ~16.8 | `keys/relation-r2-reproof-16-6-v2`, `aggregate-canonical-v3`, `aggregate-proofs-L1-20260910`; pinned BCH source/Chipnet pool-key graph reads these | **Do not touch until M2 completes.** Then BCH owner may propose byte-identical relocation to a pinned operational location, with dependency and security/pin approval. Archive shrinkage from relocation is not disk reclamation |
| Older key sets | 21.6 | v1-20260908 (340 files, 10.8 GiB), v1dev (249 files, 10.8 GiB); three remaining BCH references, including proof-artifact refs and evidence script | Still referenced, not stale by age. BCH owner must resolve readers first. Any key deletion is a **reserved operator decision**; cold relocation likewise needs BCH security/storage authority |
| Build output in evidence | ~16.7 | `target/*.o`, `*.a` in ENG-2206 (6.0), ENG-2348 (5.6), ENG-2357 (4.8), ENG-2240 (0.3); owner describes rebuildable output | BCH engineering owner may propose reduction only after checking no evidence/prover binds these exact files and reproduction is retained; unrecoverable removal needs operator approval |
| Scratch tarballs | 4.8 | 105 tarballs in scratch-tarballs (3.7) plus an August proof tarball (1.1); no BCH-main references reported | BCH owner conducts name/dependency review after M2. Missing grep matches are not proof of no live readers; preserve proof-bound or unknown payloads. Cold-store or remove only with actual owner/irrecoverable-data authority |
| Repository copies | ~0.9 | 13 copies, five with node_modules (~73 MB each) | BCH owner proves commits, untracked work, native/preservation receipts and future rebuild inputs are retained. Presence of a remote/main commit alone does not prove no unique data; then propose reduction under actual authority |
| Small key/proof records and other historical evidence | **~9.8 residual** | Summary identifies small key/proof records <1 GiB; other history is the remainder. Precise split and last use unknown | Preserve and classify with BCH owner. Non-sensitive historical evidence may later enter the adopted lifecycle; mixed/key/unknown payloads stay protected |

The first five named classes sum to **60.8 GiB** (86.12% of the rounded total).
The **9.8 GiB residual** is derived, not an independently measured category;
it groups the owner's remaining small proof/key records and historical evidence.
The rounded class table accounts for the reported total at that coarse level.
**An exact-byte >=90% BCH classification witness remains UNKNOWN**, not PASS.
The 63.5/70.6 top-entry quotient is 89.94%; rounding can straddle 90%, so it
cannot independently establish that threshold. No raw inventory is accessed to
pretend otherwise.

Exact scan start/end, allocated bytes, recursive file/directory/link counts,
errors/concurrent changes, per-large-item atime/mtime, explicit unknown-class
bytes and exact class totals are **unknown in the relay**. Supervisor-herdr has
requested an owner addendum. Its next event is the same owner's key-free
addendum, not another scan or a blocked wait. A future report can append that
evidence while preserving this producer's original observation and limits.

There is a material arithmetic discrepancy in the supplied summary: subtracting
all five classes gives approximately **9.8 GiB**, consistent with "about 10".
Keeping the 21.6 GiB older keys instead gives **31.4 GiB**, not the relayed
"about 26". These are scenario arithmetic on rounded owner estimates, not
approved savings or an exact cleaned archive target. The BCH owner should
reconcile its scenario before any action. Also, relocating 16.8 GiB of live
material reduces archive occupancy without reducing total project storage.

The statement "new BCH items write to the record from Monday" is an owner
proposal, not Brain activation authority. BCH decides its own path-only changes,
canary/adoption and any cleanup after M2. Brain's unselected plan cannot authorize
them. No human decision is currently pending: this run is presenting a concrete
plan for later consideration, not requesting deletion now.

## Handoff

Read the [lifecycle design](record-first-storage-lifecycle.md) with this census.
The one report-queue Opus review should challenge the classifications/unknowns,
real closed-item trace, safety/reader compatibility and the five standalone
unselected build slices. Its verdict and any correction remain downstream;
this producer runs no second review or verdict wait. Release, current watchers,
original native attempts and consumer activation owners remain unchanged.

Executable-check selection is empty for the design/metadata scope. Product,
release, live-acceptance, real migration/pointer resolution and reviewer suites
are **UNRUN**. Metadata observations and report validation are not producer test
suites, and no lane gate or synthetic validation receipt is created for them.
