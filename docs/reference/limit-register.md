# Reached limits and measured latency

This register records Brain's reached consumers at **2026-10-27 16:20:34 UTC**,
from source `f2d7630e7aadc2dfc80bf608d3a20285ec5aed72`, existing diagnostics and
saved requests. It changes documentation only. Values are observations, not
permission to stop, restart, recover, replace a reviewer or release anything.

[The captured observations](../evidence/ENG-671/R-943/observations.json) contain
source/installed file hashes, distribution counts, consumer groups and the
hash-addressed archive of original diagnostic projections. The archive is
`/Users/rewt/development/rewt/.org/evidence/ENG-671/R-943/passive-samples.json`.
Every numerical sample below comes from retained work; no suite or benchmark
was executed to populate this register.

## Which implementation is reached

| Consumer | Observed selection and version | What it establishes |
| --- | --- | --- |
| Lane/source | The source commit above, Node **20.19.4**; `lane config` resolves canonical `.lane.json` and `.lane.validation.json`, parent routes and fleet worktree root | Source defaults and actual project overrides. An old installed bundle is a separate consumer. |
| Installed default | `~/.local/share/herdr-monitor/current` resolves to `releases/rc-20261025T230221Z-c160b32b6b`, commit `c160b32b6bc36cd93baab307d30cdff11b1de467` | Read-only file inspection. Its test wall/freeze defaults match the rows below; it has **no `line-service/line-service.mjs`**. This does not prove an in-flight process loaded these bytes. |
| Saved line installation | `.org/line-service/c8b8479c34b7b676f466/service.plist` selects canonical development source, pinned Node, `--once --to brain-chat`, interval **30 s** | The installation receipt still says `stopped` at 2026-10-26 17:19:24 UTC. Newer heartbeat/pass records show actual executions. Neither receipt alone establishes current launchd loaded state; that state is **UNKNOWN**, without probing or changing the service. |
| Actual Brain passes | Five completed passes name source `f2d7630e…`, between 16:10:22 and 16:19:43 UTC, and report **nine starts** | Actual Brain line execution evidence. `source_head` is recorded at pass start, not an attestation of every subsequently loaded child/module. This documentation landing has no live/release PASS claim. |
| Own saved dispatch/watcher | Run R-943's original dispatch selects canonical source, Brain claim generation **23396** and worker `lane-line-eng-671--3bbfc9-ff7caa`. Its existing watcher is PID **55691**, birth `1793117724:702573` | The saved watcher and callback remain unchanged. A saved binding is evidence, not fresh authority for a native effect. The recorded exception address is **UNKNOWN**; no supervisor recipient is inferred. |
| Other saved consumers | Original dispatch jobs, `settle/R-n.json` and `watch/R-n.json` only; route snapshots and launch fragments excluded | The evidence preserves paths, digests, stage, requested timeout and saved runtime. **527** settle jobs retain `timeout: 1800` (515 complete; 11 reviewing; one validate), **six** retain `timeout: 0` (three complete, three reviewing). Of the 1800-s jobs, **274 lack a release binding**; their actual timer semantics remain UNKNOWN. Historical stage is not current liveness. |

The source version and installed selection are observations in this snapshot.
Saved consumers keep their own runtime, options and uncertainty; changing a
default never retroactively changes them. No pin, job, watcher, other-identity
file or BCH state was changed or exercised.

## Limits by meaning

`S` below means the captured source version; `I` means the installed c160 bundle.
Links identify the actual source definitions. `UNKNOWN (n=0)` means the captured
receipts supply no matching measurement, never a zero-duration observation.
All ratios use like units; a base-only comparison is explicitly identified.

### Elapsed execution and response allowances

| Reached path / consumer | Default, override and effect | Measured latency / ratio |
| --- | --- | --- |
| [Gate resolver](../../test-slot/limits.mjs), [runner](../../test/helpers/runner-limits.mjs); S and I | Gate wall **0**, file **0**, suite **0**: no elapsed execution stop. Legacy timeout declarations/runner flags remain readable but do not arm those clocks. Canonical validation declares `timeout_seconds: 0` for all tiers; an explicit legacy positive wall setting still resolves to zero in this resolver. | No finite denominator; ratio **N/A**. A long completed test or gate is not an AND-freeze episode. |
| [Source line child](../../line-service/line-service.mjs), [foreground command](../../dispatch/foreground-command.mjs); S | `invoke` and foreground wrapper use `timeout: 0`; foreground child is watched by the AND predicate below. The retained `childTimeoutMs=120000` parameter has **no use** in the function and is not a reached cap. | Per-child response distribution **UNKNOWN (n=0)**. Whole-pass duration cannot substitute for it. |
| [Dispatch child](../../dispatch/dispatch.mjs); S | A phase1 request uses `timeout: 0`; the non-phase1 path retains **120 s**, bounded by an observation deadline when supplied. Session-observation work separately uses the saved 60-s window below. The original request determines the path; no continuation is replayed here. | Response distribution **UNKNOWN (n=0)**; no claim that every old job uses phase1. |
| [Line source Git reads](../../line-service/line-service.mjs), [release/project reads](../../lib/releases.mjs); S | **10 s** per synchronous Git response. This is a child response bound, not a worker lifetime or source-ownership expiry. Native launch observations in [lane](../../lanes/lane.mjs) bound a call to `min(60 s, remaining deadline)` when a deadline is supplied. | Matching response distribution **UNKNOWN (n=0)**. No end-to-end-pass ratio to these clocks. |
| [Native process lookup](../../lib/processes.mjs); S | Load-scaled **2 / 4 / 8 s**, at most three attempts, only for read-only OS timeout. Refused, partial or malformed replies do not become retries. | Response distribution/load sample **UNKNOWN (n=0)**. No signal or process probe was performed for this register. |
| [Retirement native exit observation](../../lib/retire.mjs); S | Default **60 s**, capped at 60 s if caller changes `exitTimeoutMs`; polling at most 250 ms. Observes the original identity-bound exit intent; expiry retains uncertainty. | Original exit acknowledgement distribution **UNKNOWN (n=0)**. |
| [Closer](../../supervisor/closeout.mjs); S | Bare `drain` default is **180 s**. Exact named `--deadline 0` means unbounded; source line calls that exact form separately for session and physical cleanup. An unnamed unbounded/session-only drain is rejected. | Matching cleanup distribution **UNKNOWN (n=0)**. A historical deadline or later source does not prove an old owner's outcome. |

[Load scaling](../../lib/deadline.mjs) uses
`max(1, load1 / min(4, availableParallelism))`, with a finite timer ceiling of
`2^31 - 1 ms`. It applies only where the caller invokes `loadTimeout`; it does
not describe every response timer. The selected receipts do not retain each
caller's load sample or inherited environment, so effective scaled allowances
and effective utilization ratios remain UNKNOWN. No CPU/load values are guessed.

### Measured silence AND inactivity

| Reached path / consumer | Default and override | Evidence and interpretation |
| --- | --- | --- |
| [Watch predicate](../../test-slot/watch.mjs), [shared default](../../test-slot/limits.mjs); S and I | **199.580020875 s** of uninterrupted silence **AND** confirmed inactivity. `MONITOR_TEST_SLOT_FROZEN_SECONDS` accepts bounded fractional seconds; **0 disables** this predicate. Missing/changed process audit resets inactivity; runnable or changed CPU/process state is activity. A fresh owned birth identity still precedes any signal. | Existing ENG-625/R-822 `measurement.json` selected one complete actual TAP case, **199580.020875 ms**, from R-621 `validation.tap:1563`, SHA-256 `f371a2d5…`. The case completed with an assertion failure; it was not a passing case or timeout. The retained scan's 1,436,140 raw candidate blocks include copies and are **not** an independent sample count. Distribution p50/p95 and actual freeze-episode count are **UNKNOWN**. Case/threshold ratio is exactly **1**, calibration only; it does not measure inactivity. |
| Same watch, silence notice; S and I | **900 s** notice threshold, project `idle_timeout_seconds` or caller `idleSeconds` can override; 0 disables the notice. Silence alone never authorizes a signal. Nominal audits at most **30 s** apart, shortened for smaller thresholds. | Silence distribution **UNKNOWN (n=0)**. Neither the selected completed-case maximum nor whole-pass latency proves silence or CPU inactivity. |

The historical freeze measurement's original report binds the case to candidate
`b470ce271d2aa4fb3de111a3945c8dd64b2a4381`; no independent per-case execution
receipt existed. Its retained-case census excluded censored timeouts, aggregates,
fixture durations and duplicates as new observations. The snapshot preserves
those limitations and the exact measurement-file digest. No new freeze,
watchdog, reasoning service or attempt-count automation is introduced.

### Native session identity, claims and ownership clocks

| Reached path / consumer | Default, override and consequence | Actual measurement / ratio |
| --- | --- | --- |
| [Session binding](../../dispatch/session-bind.mjs), [identity validator](../../lib/worker-identity.mjs); S (same window in I) | Saved `prompted_at + 60000 ms`; observation is additionally bounded by a monotonic 60 s. A positive observation must fall inside that saved window; replay of the exact proposed fact can occur later. Expiry does not establish absence, end a worker, release a claim or permit another launch. | **57** positive source-root bindings on 2026-10-27: min **2.443 s**, p50 **20.815 s**, p95 **33.651 s**, max **37.066 s**; p95/60 = **0.56085**. Positive completions only; unbound/unfinished attempts are censored, not zero. Own R-943: **4.075 s**. |
| [Run owner/claim](../../lib/run-owner-guard.mjs); S | Exact controller, release identity and claim generation; **no TTL**. A 60-s session deadline, idle age or old journal cannot transfer ownership. Fresh native/claim/source/CAS/STOP/HOLD checks remain at mutations. | Duration/limit ratio **N/A**. Own saved generation above is not a lease expiry. |
| [Session controller lease](../../sessions/runtime.mjs); S and I | Exclusive `sessions/controller.lock`, exact owner token; **no timeout or automatic stale recovery**. An abandoned lease requires inspection. | Lifetime distribution **UNKNOWN (n=0)**; no elapsed denominator. |
| [Session authorization](../../sessions/authorization.mjs); S and I | Explicit future `expiresAt`, checked on use; no default duration. It bounds the particular authorized scope, not the associated agent's lifetime. | Relevant authorization interval/use latency **UNKNOWN (n=0)**. Old config-home adoption scopes remain unchanged. |
| [Proving reservation](../../test-slot/reservations.mjs); S and I | `expiresAt` clamped to acquisition + **6 h**; `expectedEnd` defaults to expiry at the lower-level API. Test-slot's expected duration defaults to **4500 s**, separately overridable. Expiry ends this reservation's admission effect, not its native process or ownership. Unknown reservation identity remains unknown. | Current proving interval distribution **UNKNOWN (n=0)**. No proving reservation or resource sample was created. |

### Lock contention, admission and resources

| Reached path / consumer | Default, actual override and consequence | Actual measurement / ratio |
| --- | --- | --- |
| [Record lock](../../lib/store.mjs); S | Load-scaled contention **10 s**, unidentified initialization grace **30 s** using the same sample. Explicit `recover:false` refuses immediately without probing/recovery. These are separate from time **holding** the record lock. | **340** actual released acquisitions from 16:10:20.817–16:20:29.196 UTC, source-version `3e377cd0…`: wait min **0.032 ms**, p50 **0.126 ms**, p95 **138.941 ms**, max **4065.731 ms**. p95/10-s **base** = **0.0138941**; effective load-scaled ratio UNKNOWN. 335 callbacks returned and five threw; neither is a product test verdict. Acquisitions that never released are not timed here. |
| [Promotion lock](../../lanes/promotion-lock.mjs); S | Promotion callers pass **120 s**, load-scaled. Generic `acquireLock` default remains **0** for unrelated callers; lock age is never sufficient recovery authority. | Matching wait/hold distribution **UNKNOWN (n=0)**. |
| [Notice lock](../../supervisor/notice-lock.mjs); S | Default immediate; recovery serialization uses **5 s**, load-scaled unless a hard deadline is supplied. Original owner/source/native refusal remains authoritative. | Matching contention distribution **UNKNOWN (n=0)**. |
| [Session admission](../../dispatch/session-cap.mjs), [admission allowance](../../lib/deadline.mjs); S | Load-scaled **60 s** caller wait; native birth/contender identity required. Proving waits use a finite caller admission deadline, not a worker execution cap. New unrelated reservation files cannot reset the caller's monotonic deadline. | **67 granted** source-root admission pairs on 2026-10-27: min **0.603 s**, p50 **5.402 s**, p95 **42.773 s**, max **67.039 s**. p95/60-s **base** = **0.712883**. Effective load factor and failed/unfinished waits UNKNOWN; 67.039 s is not proof of exceeding the effective allowance. These clocks include the helper's existing entry/grant bookkeeping. |
| Same session capacity | Defaults build **7**, review **3**; canonical `.lane.json` overrides build to **12**. `dispatch.max_review_sessions` and `max_total_sessions` can override review/shared ceiling. Actual separate pools yield **15** total. Uncertain native/session occupants retain capacity. | Latest retained capacity row, 16:19:23 UTC: review **1/3**, shared **11/15**. Instant count ratios **0.333 / 0.733**, not latency or CPU demand; no distribution is inferred. |
| [Unlanded accounting](../../dispatch/unlanded-cap.mjs); S | Legacy default **8**, exception cap **3**, configurable `dispatch.max_unlanded`. The running-worker path returns `cap:null`, `count:null`, with historical-unlanded entries explicitly not counted. Review accounting is separate. | Historical labels are not an extra active-line admission gate. Current unlanded distribution UNKNOWN; no duplicate launch or legacy retry follows from this row. |
| [Test admission](../../test-slot/test-slot.mjs), [tickets](../../test-slot/ticket-queue.mjs); S and I | `--wait` overrides `MONITOR_TEST_SLOT_WAIT_SECONDS`, then legacy wait env; unset **0** means immediate admission. Ticket expiry uses arrival + wait, not command lifetime. Shared work has no legacy exclusive-slot wait; declared proving retains its actual reservation/resource checks. | Matching test/proving wait distribution **UNKNOWN (n=0)**. No blanket test run was selected. |
| [File concurrency](../../test/helpers/runner-limits.mjs), `package.json.resources`; S and I | At most **4** files, `max(1,floor(4/loadFactor))`. Declared `M_bytes` and `C` for Brain scripts are **null**, not zero. This cap does not bound transitive native threads/CPU. | Actual concurrent CPU/memory demand and per-call load factor **UNKNOWN**. No synthetic CPU estimate or new admission threshold. |
| [Memory/proving admission](../../dispatch/dispatch.mjs), [memory probe](../../lib/memory.mjs); S | The normal source line's legacy-named memory phases wait on genuine proving reservations. Native memory probes retain **2 s** response allowances; legacy pressure thresholds still exist for callers of `waitForMemory`. The own landing waiver skips promotion memory waiting. A declared proving memory floor remains its actual profile's choice. | Which old saved consumers currently reach legacy pressure waiting, and their measured demand, remain UNKNOWN. A source helper's existence does not prove the normal line calls it; no guard or resource floor was removed here. |

### Planning targets, schedules and work budgets

| Path / consumer | Value and effect | Passive evidence / comparison |
| --- | --- | --- |
| Adopted ENG-666 record work; [lock diagnostics](../../lib/run-timing.mjs) | **p95 hold <50 ms** is a target, not an acquisition timeout or permission to kill an owner. | Same **340** acquisitions: hold min **0.505 ms**, p50 **136.320 ms**, p95 **375.389 ms**, max **6205.644 ms**. p95/target **7.50778**: target **not reached in this sample**. Existing ENG-666/REV-32 own the storage change/review; this register does not claim their task complete or create a second fix. |
| [Line pass](../../line-service/line-service.mjs); S | **480000 ms** work allowance, default `maxStepsPerStage:8`; constructor can override. Budget defers new scan work, then READY admission gets an independent allowance. It never stops an active child. Starts default to actual configured build cap (**12** here), separately overridable by constructor `maxStarts`. | Five f2d passes: min **21.931 s**, p50 **37.310 s**, p95/max **266.906 s**. Whole-pass p95/480 **0.5561** is context only: the whole-pass clock is not either stage clock. No stage-budget violation is inferred. |
| Same line, long-pass alert | **600 s** elapsed creates a record alert after work returns; not a stop/restart deadline. Repeated normalized failures default to **three** occurrences before the ordinary notice, while every raw occurrence is preserved. | f2d whole-pass p95/600 **0.4448**; nine reported starts across five completions. Earlier heads are grouped separately in the evidence; results are not a controlled performance comparison. |
| [launchd schedule](../../line-service/launchd.mjs); S saved plist | Source default and saved `StartInterval` **30 s**; installer `--interval` can override. A schedule is not a maximum pass duration or a loop in core. | Actual service loaded state UNKNOWN. Executed passes above are positive evidence; no restart/status mutation or second watcher. |
| [Watch notices](../../watch/watch.mjs); S and I | Start grace **60 s**, load-scaled; idle grace **0**, long notice **3600 s**, retry-after **10 s**, delivery attempts **5**, all CLI-overridable. These are notice/response policy, not worker lifetime or claim expiry. New record-only callbacks and old saved recipients retain their existing contracts. | Matching notice-delivery distribution **UNKNOWN (n=0)**. R-943's original watcher/recipient are retained. |
| [Review configuration](../../settle/config.mjs), [record queue](../../line-service/review-queue.mjs); S | Project/default `timeout:0`, cap **1**, one formal correction; roughly **1800 s** planning target and **zero reviewer suites** under the adoption. Saved legacy positive timeouts are recorded separately above, without replacement. | Review latency distribution **UNKNOWN (n=0)**. One async record queue review is the handback path; pending/UNKNOWN attempts occupy their original budget. No verdict is required to land. |
| Adopted implementation/review limits | Two failed fix attempts test a premise; three or a newly exposed issue stop/reframe. First reds, setup slips, assertion counts and pre-existing main failures are not failed fixes. Line/size advice remains planning only. | No fix attempt in this documentation change. No Phase2 runtime attempt-count automation, file-size gate or new execution service. |

## Evidence reuse and removed work

This change removes the obsolete response-limit enumeration from
`load-deadlines.md`, which still described finite file/suite watchdogs and an old
response regime as a single current policy. That entry now links here.
The replacement names the reached consumer and kind of clock before comparing
latency; future handbacks can reuse the captured count/source/UNKNOWN facts
instead of repeating the timeout census or running a benchmark to fill gaps.
Fresh mutation guards still run at the effect itself.

Engineering handbacks name the exact obsolete check, loop, receipt, route or
other repeated work their change removes, with its replacement/evidence; if
none is removed, say so. This is subtraction evidence, never a changed-line,
file-size or readiness gate. This register removes documentation/re-audit work;
it does not claim a runtime loop was deleted.

This is a finite snapshot. Reuse it with its recorded consumer version; update
an affected row when actual source selection or real-work receipts change.
UNKNOWN is neither zero, PASS, native absence nor authority to replay a request.
No new diagnostics collector is installed; existing record-lock timings, pass
journal, dispatch timing sidecars and immutable measurement evidence suffice.

The pre-change document and diagnostic input digests are archived under
`/Users/rewt/development/rewt/.org/evidence/ENG-671/R-943/`; source preimage is the
full commit at the top. A plain Git revert of this exact landed documentation
commit restores the prior entry and removes these new files. Preserve the
original report and evidence. No runtime/pin rollback or BCH adoption is implied;
final release and live acceptance remain with their actual coordinator.
