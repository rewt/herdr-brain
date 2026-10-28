# Herdr Brain 0.2.0 coordinator handback

Prepared by ENG-856 / R-1213 for **supervisor-herdr**, the canonical release
coordinator. Authority and gate definitions remain
[CLOSE-ON-REPORT-PERMANENT](../contracts/CLOSE-ON-REPORT-PERMANENT.md), especially
Stage and release, Ordered implementation item 3, and Proof and observation.

**Release, adoption and permanence acceptance are OPEN / NOT MET.** This packet
prepares the package version and evidence; it is no build, activation, live PASS
or authorization to change services. Keep ENG-856 open until every required gate
has actual attached evidence. Implementation handback and shipping do not close
the sustained acceptance obligation.

## Source and producer evidence

The narrow closeout stabilization release remains at the front of Stage 2, with
no new broad stage or dependency on the Stage 3 message bus. Immutable snapshots
include their existing base history; add only closeout slices, necessary
compatibility/packaging and corrections to this candidate.

| Input | Immutable source / owning evidence |
| --- | --- |
| ENG-853 guard, landing and append-only closer work | `8249d8dd`, `3f5d229f`; `.org/runs/R-1191/report.md` |
| ENG-854 allocation binding, ingestion and independent finite turn | `d71b6fbfa7d3ffae7f4f57ddc3cc0d80b1ce43c0..b945b139856cb50f87d7ef733c7e8e3719ea74c9`; `.org/runs/R-1194/report.md`, `.org/evidence/ENG-854-R-1194/` |
| ENG-864 measurement/oracles and three historical inventories | `b945b139856cb50f87d7ef733c7e8e3719ea74c9..f579b38650fcdad65582a0fdb2230e94a06efce9`; `.org/runs/R-1204/report.md`, `.org/evidence/ENG-864/R-1204/` |
| ENG-866 installed measurement without archived docs | `f579b38650fcdad65582a0fdb2230e94a06efce9..752abf08048c19797ecc14f5a9a1684b6869961c`; `.org/runs/R-1207/report.md`, `.org/evidence/ENG-866/R-1207/` |
| ENG-855 typed independent resource progress and live resumption | `752abf08048c19797ecc14f5a9a1684b6869961c..f73f89a405460dda33dbed65982fb3ed9946c872`; `.org/runs/R-1203/report.md`, `.org/evidence/ENG-855-R-1203/` |
| This release preparation | immutable base/head, source diff, mapping and receipt references in `.org/evidence/ENG-856/R-1213/producer.json` and `.org/runs/R-1213/report.md` |

`.org` here is `/Users/rewt/development/rewt/.org`. Reuse producer receipts once;
offline fixture results and the single partial live close in R-1203 do not prove
native whole-cohort acceptance, final coverage or a sustained window.

## Corrections required before release

REV-184 / R-1208 is **FAIL**, preserved unchanged. Its one formal correction is
**ENG-873**, not a new review chain. The release coordinator must attach each
specific correction check and its immutable source/runner/TAP evidence:

| Finding | Required evidence / present limit |
| --- | --- |
| Installed history ENOENT | ENG-866 supplies the copied installed-product/no-docs/default-loader control and its original failure plus passing correction receipt. Reconcile that evidence against this Major; optional missing histories must stay explicitly unknown/non-green. |
| Obligation source differs from terminal report | Same-run/project/allocation late `cleanup.bound` and `item.closed` receipt-backed success; foreign run/project/key must not be borrowed. Specific correction UNRUN by this preparation worker. |
| Legacy history makes a real window pass unreachable | Explicit candidate/window cutoff with pre-cutoff legacy rows retained in absolute counts and separate historical coverage; receipt-backed post-cutoff pass, then an injected post-cutoff failure prevents pass. Incomplete Claude history remains an unresolved historical gate. Specific correction UNRUN here. |
| Audit volume and repeated cohort scans | Retained full membership/receipt references with bounded append frames on 3,000 members over two turns, plus bounded 30,000-event execution. No discarded history or torn-tail rewrite. Specific correction UNRUN here. |

Carry R-1208's four Minor findings too: absent-pane equality, live branch/ref
cross-checks, vanished-process coverage handling and import-time Git cost. Use
ENG-873's recorded correction checks and the existing affected runner selection;
retain original failures and do not replay passing controls solely for receipts.
No fixture-only green or prose assertion closes a Major. Do not select an
activation-eligible candidate while required corrections lack specific evidence.

## Candidate identity and coordinator execution

`package.json` is prepared as **0.2.0**. Keep candidate IDs
`rc-YYYYMMDD-SHORTSHA`; a version string grants no identity or pin authority.
The existing release evidence directory is
`.org/evidence/STABLE-RELEASE-20261027/`. Its
`v020-release-mapping.md` holds this preparation's full source tuple and the
coordinator's candidate/acceptance ledger. No candidate is selected or built by
R-1213. The final candidate may need ENG-873 and other required corrections.

For **each actually selected candidate**, the coordinator records candidate ID,
full commit, committed package version, actual base/head and included fixes,
then links the build, full-suite and live evidence in that existing directory.
Each candidate ID maps to exactly one full commit and package version. Preserve
failed candidates and partial builds. Exactly one accepted candidate becomes
0.2.0. After acceptance, corrections require a new version and candidate. Do not
rename, rebuild or relabel the already active date-based release; no release
helper, manifest schema or trust-pin change is needed for the package label.

After checking correction evidence, from the canonical supervisor release
context with pinned Node **20.19.4**, select/tag the immutable candidate using
the existing release workflow. The coordinator runs:

```sh
PATH="/Users/rewt/.nvm/versions/node/v20.19.4/bin:$PATH" \
  env -u HERDR_BRAIN_ROOT bash herdr/release.sh build "$CANDIDATE" --live
```

This invokes the candidate's declared release gate (currently
`npm run test:slot && node test/helpers/full-pass.mjs`) and then actual live
acceptance. Do not run a separate full gate merely to duplicate the build's
receipt. Retain the exact command, environment/source identity, native execution
completion, file counts, failures/unrun controls, log and live summary. A failed
or interrupted candidate is not READY and its attempt is never replaced.

The full suite **must include** ENG-853's previously unrun
`watch/test/watch.test.mjs`, `test/closeout-contention.test.mjs` and
`test/closeout-lifecycle.test.mjs`. Verify their actual file-completion evidence
in the full run; selection or an old producer fixture is not execution.

The coordinator also retains disposable candidate failure/recovery evidence
for wake loss, ingest/source crash boundaries, process/service restart, late
session binding, concurrent consumers, main/source movement, partial effects,
real refusal, lost-reply UNKNOWN, STOP/HOLD and dirty work/unlanded branches.
Retain intent/completion IDs proving no uncertain replay, wrong occupant close,
lost dirty bytes, unlanded ref deletion or guard bypass. Exercise the metric
oracles by injecting manual close, missing inventory, false prose refusal and
cohort exclusion, each independently preventing green. An existing live summary
does not imply these extra controls ran: attach their actual evidence explicitly.

Only after full required coverage, Major corrections and actual live acceptance
may the coordinator activate under existing authority. Preserve rollback/source
and installed-launcher checks with the accepted mapping. Brain's owner alone
adopts/changes Brain services or pins; BCH's owner, **supervisor-opus**, alone
adopts/changes BCH services or pins and runs BCH's own compatibility checks.
Workers do not restart watchers/services or alter saved jobs/runtimes.

## Reading the measurement tool

The existing tool is `line-service/closeout-measurement.mjs`, exported
`recordCloseoutTurn({project, org, env, now})`; ENG-855 calls it after the finite
turn outside record/native locks. No new model, daemon or operator push is
needed. The owning service must demonstrate a complete observation at every
turn and no more than **60 seconds** between observations, including slow review,
restart and cutover. A silent/stopped service supplies no evidence.

Find the owning per-project path with the exported
`measurementDirectory(org, project.identity)` (identity is the real Git common
directory). Retain `closeout-measurements.jsonl` and its referenced raw
cohort/inventory/effect receipts, `closeout-measurement.json` as the display
projection, and existing `passes.jsonl` measurement diagnostics. ENG-873 may
bound frames with immutable references; follow those references, retaining their
hashes, rather than treating a latest projection as the whole observation.

For each sample/window inspect source commit/module hash, record first/cutoff,
observation time/cadence, `coverage.native/git/process`, `failures`, `cohort`,
`historical`, `exclusions`, `aggregate` and `slices`. The current implementation
has the blocking defects above: its `green` is not yet a usable sustained-window
verdict. Even corrected local green never certifies release or permanence.

| Gate | Evidence to read and required result |
| --- | --- |
| Complete accounting | Full allocation denominator, every final outcome, abandonment and terminal dispatch failure; `accounted / denominator = 100%` in the immutable first bounded turn, independently closed or typed-kept session/folder/branch and preserved author evidence. Later progress cannot repair first-turn accounting. |
| Separate clocks | Hash/claim/start-bound original `report.available`, ingest, first disposition, exact session-close and folder-removal receipt times. Expose availability-to-ingest and ingest-to-first-disposition separately; derive the latter from those two retained timestamps. Bare mtime, later scan and missing original time remain UNKNOWN. |
| Latency | Availability-to-first-disposition and eligible session-close p95 <=120,000 ms; eligible maximum <=300,000 ms. Report actual maxima, separate resource clocks, genuine hold intervals and every exclusion; never reset origin on resume, eligibility or source movement. |
| Absolute retained resources | `open_over_2h = 0`, `clean_retained = 0` after completed drain, `orphan_processes = 0` in finished vacant lanes. Include historical and safety-held resources. Dirty work is listed with its actual owner. Separate transient in-pass backlog. |
| Assistance and safety | `manual_cleanup = 0`, `unexplained_disappearance = 0`; exact automated receipts for disappearance. Zero wrong-occupant closes, lost dirty bytes, deleted unlanded refs, UNKNOWN replay or STOP/HOLD/refusal bypass, from the underlying effect evidence. Absence is not success. |
| Holds | Every hold has exact scope, evidence, actual owner, first-seen age and an actual completion producer or admitted pre-effect route. Publish counts and oldest ages, including excluded holds; no fictitious subscription. A justified old finished session or clean kept folder still fails its absolute-zero gate. |
| Slices | Every numerator, denominator, latency and oldest age split by project, Codex/Claude and line/supervisor dispatch. Unknown stays visible; an empty required slice provides no coverage. |
| Busy-hour reliability | Candidate source for >=10 actual landings in one hour. Retain expected final-notice IDs and actual terminal delivery receipts: zero missing notices and zero operations ending on retryable guard conflicts. No inference from an empty conflict sidecar. Old-runtime/UNKNOWN results are not candidate successes. |

Read raw linked effect/hold/resource rows as well as summary fields: safety,
notice delivery, exposure and some separate clocks have no standalone certified
summary verdict. Missing coverage or missing receipts remains UNKNOWN/non-green.
Publish through existing project diagnostics/digest and attach proof to ENG-856.

## Historical recovery handoff

ENG-864 already archived the three separate inventories under
`docs/evidence/ENG-864/` and `.org/evidence/ENG-864/R-1204/`:

| Scope | Preserved denominator / coverage |
| --- | --- |
| R-1176, through seq 30764 at 19:24:45Z | 26 clean finished folders, 42 run references; four finished sessions >2 hours. The 25-row original-identities file is a different census. |
| Sol research, through seq 30910 around 19:40–19:42Z | 30 named retained allocations, separate from 75 direct targets / 61 empty / 60 preceding valid binds. |
| Claude research | 163-report aggregate with 18 named examples; exact aggregate membership/cutoff UNKNOWN. The claimed 89 manual removals are research classifications, not verified effect receipts. |

R-1213's `backlog-original-owners.json` and `.md`, under
`.org/evidence/ENG-856/R-1213/`, group these exact memberships by named recorded
original allocation producer and recovery reason. They cite start/claim/native
binding and current record evidence at their stated cutoff, without claiming a
fresh native/process census or current physical retention. Overlapping cohorts
are not summed. R-1163 remains separately unprompted/nonfinal; R-1178 remains a
separate unexplained disappearance. Missing owner identity stays UNKNOWN.

Deliver that grouped packet once to **supervisor-herdr** through the existing
supervisor channel. The named original producer must supply exact original
completion or admitted never-started evidence, or finish its own authorized
teardown. No refusal/UNKNOWN clearance, generic cwd/uid kill, manual sweep or
hand close is authorized. Keep unresolved original scopes and missing Claude
membership visible in absolute accounting. Backlog resolution remains a gate.

## Continuous proof windows and completion

All windows below are **UNRUN / NOT MET by R-1213**. Attach start/end, candidate
mapping, record cutoffs, full cohort and sliced totals, sample/receipt references,
coverage gaps, holds, incident/reset history and actual owner for each window.

1. After required preactivation evidence, Brain's owner runs the accepted
   candidate pilot for **>=72 continuous hours AND >=100 actual closeouts**,
   whichever takes longer. Both harnesses and both dispatch origins must be
   represented, including overnight work, an owner-controlled restart, release
   cutover and the >=10-real-landings busy hour with notice/guard evidence.
2. BCH's owner then adopts under its own checks and records **>=48 continuous
   hours AND >=100 actual closeouts**, with the same slices/exposure coverage.
3. Then observe **seven consecutive days meeting every zero/count/latency measure
   in both projects simultaneously**, with the same coverage and no manual help.

Low traffic extends windows; synthetic load is not authorized. Any unexplained
close/disappearance, hand sweep, invariant breach, missing coverage or
closeout-affecting source change resets the affected window. Restarts qualify
only with complete owner-controlled continuity evidence. Retain failures and
old windows; do not reset clocks to conceal them. Continue observation afterward
and reopen regressions from their exact evidence scope.

ENG-856 stays open until corrections, release/adoption evidence, original-owner
backlog recovery and all mandatory windows are actually met. Hand this worker's
immutable landed range/evidence to ONE asynchronous other-family record
queue-review (cap1, zero reviewer suites). The existing line service owns that
dispatch; the existing watcher targets supervisor-herdr. No parallel settle/lane
review, verdict wait before landing or replacement of UNKNOWN attempts occurs.
