# Herdr Brain pipeline map: one work item, commit to main to next item

As of 2026-10-26 23:23Z (18:23 CDT). Source: dev checkout `main` at 6871e80c, which the line service runs. Everything below comes from reading the code and the live logs: `.org/line-service/c8b8479c34b7b676f466/{passes.jsonl,effects.json,controls.jsonl}`, `.org/events.jsonl`, the dispatch journals, and BCH's `/Users/rewt/development/bastian/.org`. Anything I did not read directly is marked **INFERRED**. All file:line references are in `/Users/rewt/development/rewt/herdr-brain`.

## Headline

1. **The only hard gates between a worker's commit and main are in `lane promote`.** The lane and canonical worktrees must be clean, the promotion lock must be free, the branch must rebase cleanly, and the merge must be a fast-forward. Under the current operator waiver nothing else is enforced: no tests, no review, and no report. The exception is a worker that passes `--if-current-run`; then the record checks apply, and they include "a done report must already be recorded" (`promote/guard.mjs:45`).
2. **No reviews were queued after 17:00 CDT. The cause is a stray directory, not the cutoff.** Seven builds were ingested after the 22:26Z restart. All seven bind to a valid post-cutoff target; I re-ran `bindReviewTarget`/`postCutoffLanding` read-only to confirm.
   - ENG-632 was retained because of an earlier decision note that mentions review (seq 18612; `line-service/review.mjs:44`).
   - The other six (ENG-232, 240, 256, 258, 263, 385) threw `unmapped native/direct review delivery retained: …/herdr-brain/.lane-review-38bc858d…-r1` (`review.mjs:106`). Eight legacy `.lane-review-*` directories sit in the canonical checkout (Oct 25 22:37 to Oct 26 13:19). Any one of them blocks every review in the project. BCH has the same failure (`bch-cloak/.lane-review-1293c2c7…-r1`).
   - In the same pass, source completion then closed each item (`line-service.mjs:207-233`). Every later pass skips closed items as "historical" (`line-service.mjs:171`), so that review debt is permanently lost.
   - Even if a review item had been created, herdr-brain has no `reviewer` route and no `selection_policy`. `reviewQueueRoute` would throw `no selection_policy configured` at dispatch (`review-queue.mjs:26`, `lanes/routes.mjs:243-246`). The record has never contained a queued review item (zero `review_key` events).
   - On the caller's "about 15 items": the record shows 7 `item.closed` events after 22:00Z (15 since 17:00Z, five of them ENG-632 being re-closed after reopens) and 10 main commits since 17:00 CDT.
3. **Throughput is capped by the serial pass, not by session capacity.** One synchronous pass starts at most one worker (`line-service.mjs:293`). Since 22:26Z passes took 222-435 s (dispatch 189-268 s, ingest 35-66 s, `record close` 47-70 s). With a session cap of 12, a worker started only about every 6.5 min, and occupancy at 23:11 was 4. **The line is stalled now:** `dispatch:ENG-400` started 23:11:09Z, its journal is still at `open` with only a `memory_open` entry, and `pass.lock` is held by pid 50410, so no ingest or close can run.
4. **Most holds are permanent.** A failed effect is never replayed (`line-service.mjs:123-128`, `154`, `276`). That is right for launches (duplicate workers), not for ingest and close, which are already conditional and idempotent.

## Step table

| # | Step | Who | Preconditions and refusals (file:line) | Waits for, and why | Delays and caps |
|---|---|---|---|---|---|
| 0 | Pass start | Line service (launchd `--once`) | `pass.lock` with `recover:false`, wait 0 (`line-service.mjs:101`; `supervisor/notice-lock.mjs:25`). Refuses if the project identity changed, on service STOP, project STOP/HOLD, or a torn record tail (`line-service.mjs:84-87`, `147`). | The previous pass. Single writer: collision safety. | `StartInterval` 30 s (`service.plist`). Ticks during a long pass fail immediately. |
| 1 | Readiness fold | Line service (`lib/state.mjs`) | `itemStatus` (`state.mjs:359-385`): closed gives its close kind; any open run gives `active`; an unresolved blocker gives `blocked`. Blockers are links plus REV children (`273-276`). A done outcome gives `done`. A `blocked` outcome with all links resolved becomes `ready` again. | Nothing. Derived from events. | None |
| 2 | Selection and holds | Line service | Sorted by priority, queued reviews first (`line-service.mjs:269`). Requires `ready` (`270`). REV items must be queue reviews created after the cutover (`271-272`). Reserved items (role human, operator_reserved, reserved categories) and `meta.hold`/`held` are held (`35-38`, `273`). Route resolution (`39-44`): architect maps to task class `planning`, giving `unknown task class: planning` (`routes.mjs:247`; BCH, 159 holds today). A role with no same-name route throws `no selection_policy configured`. Each of these notes a hold and moves on to the next item. | Nothing. Reserved/hold is real authority; route errors are config gaps. | Effect key `dispatch:ITEM:<last run or created seq>` (`275`); never replayed (`276`). |
| 3 | Admission | Line service, then `dispatch/dispatch.mjs` | Session cap (`session-cap.mjs:222-246`): cap 12 from `.lane.json`, default 7 (`:14`). It counts every unreported run and every launch with an uncertain outcome (`164-200`). The unlanded cap of 8 (`unlanded-cap.mjs:10`) is now diagnostic only (`116-120`, `152-156`). It still blocked dispatch 22:00-22:11Z under the pre-36244fc1 code (168 holds today). A capacity refusal ends the pass's dispatch loop (`line-service.mjs:296`). | Free native session slots: resource and collision safety. | Admission lock wait 60 s × load factor (`session-cap.mjs:24`; `lib/deadline.mjs:7,15-18`). |
| 4 | Memory/proving gate, lane open, prepare | dispatch.mjs | STOP or HOLD gives `DISPATCH_STOPPED` (`dispatch.mjs:408-414`). `memoryGate` (`160-164`) runs `waitForProvingHold`, bounded by about 60 s × load factor, then `waitForMemory` with **no bound** (`lib/memory.mjs:72-74`; thresholds `54-66`). Then `lane open --git-only`, `lane prepare`, and a fast-forward to `--base` (`436-443`). | A BCH proving reservation (agreed policy). Memory pressure is INFERRED to be what is stalling ENG-400 now. Memory waits are ordering only and conflict with the recorded 10-18 rule that only proving cycles may block. | Proving wait about 60 s × factor; memory wait unbounded. |
| 5 | Record start and claim | dispatch.mjs, then `bin/org.mjs start` | Takes the session-cap lock, then `record start` with the dispatch metadata (`dispatch.mjs:463-490`); `start` itself refuses little (`org.mjs:663-742`). Then claims the run for the controller `brain` (`60-66`, `489`). If the outcome is unknown, `--recover-run` is required (`453`). | One run per request: collision safety. | About 3 s per record CLI write (INFERRED from the ENG-389 timeline below). |
| 6 | Worker launch | dispatch.mjs, then `lane dispatch` | Memory gate again, then the admission lock and a final recount (`528-549`). `lane dispatch` creates the Herdr tab and agent; it refuses on an unverified pane environment, a wrong cwd or a hook-review dialog (`lane.mjs:1290-1452`). An uncertain launch needs `--adopt` or `--fresh`; there is no automatic relaunch (`dispatch.mjs:523`). | The native agent being ready: collision safety (no duplicate worker). | Herdr readiness loops 0.5-1 s; about 40 s observed. |
| 7 | Record worker and watcher | dispatch.mjs, then `watch/watch.mjs` | `record worker` binds the identity exactly (`org.mjs:744-775`). The watcher recipient defaults to **the worker itself** (`dispatch.mjs:584`). The watcher only notifies; it never ingests. | Bookkeeping. | Start grace 60 s, retry 10 s (`watch.mjs:48-51`). |
| 8 | Prompt and session bind | dispatch.mjs | Codex hook dialog check (`609-620`), then `herdr agent prompt` (`638`). An unknown delivery outcome needs `--accept-delivered` or `--resend` (`606`). Binding is observed for up to 60 s (`232`, `643`). | Bookkeeping. | 60 s observation window. |
| 9 | Work, commit, focused check | Worker | The prompt asks for a focused `lane check --cmd` once (`dispatch.mjs:623`). Nothing enforces it. | Nothing. | None |
| 10 | Land on main | Worker (`lane promote`) | See "Landing preconditions" below. | Promotion lock: collision safety. Clean rebase and FF: data safety. | Lock wait 120 s × factor (`lanes/promotion-lock.mjs:10`). |
| 11 | Report and stop | Worker | Write the report, run `record check`, stop (`lib/render.mjs:443-447`). The report must name the delivered commits; review binding parses them (`review.mjs:148-157`). | Nothing. | None |
| 12 | Ingest | Line service, then `org.mjs ingest --if-current-run` | Only the item's last run is considered; the run, report file and workspace must exist (`line-service.mjs:150-151`). If an `ingest:R` key already exists, the run is **silently skipped forever** (`154`). The native agent must match its receipt (`156-159`) and be `idle`/`done`, otherwise `report-in-flight` (`160`). The record refuses a second, different report (`org.mjs:802-805`). | The worker going idle, plus the next free pass. The idle requirement is ordering only. | 35-66 s per ingest. R-871: worker done 23:06:18, ingested 23:09:09 because the pass was busy dispatching. |
| 13 | Review queue | Line service, then `org.mjs queue-review` | Skips closed items, legacy owners, missing workspaces, non-ENG items, and fixes under a review (`line-service.mjs:171-174`). Needs a cutover event (`175`; cutover seq 18762 at 21:31Z). Binding or cutoff errors are **counted as historical with no hold** (`177-180`). `reviewAttempt` inventory (`review.mjs:36-114`) returns "retained" (logged only) or throws (`201`, a hold). Creates a sibling REV item, deliberately not a blocking child (`review-queue.mjs:82-86`). | Nothing. Async by design. | One chance per item (see order problem 1). |
| 14 | Source completion (close) | Line service, then `org.mjs close --if-current-run` | Needs a done report, no blockers or questions, not reserved or held (`line-service.mjs:210-215`). Both worktrees must be clean with untracked files included, and the lane HEAD must be an ancestor of main (`222-225`). The record also refuses: not current run, not done, blocked item, open runs, or a reopen after the report (`org.mjs:620-632`). | Landing: data safety. Clean canonical: ordering. | 47-70 s. Today 364 repeat notes for R-768/R-786 (`not integrated`; never retried). |
| 15 | Closeout and cleanup | Kicked `supervisor/closeout.mjs drain` (detached), the line service, and housekeeping | Record writes publish closeout entries and kick a detached drain (`lib/closeout.mjs:328-404`). The line service runs its own `drain --keys --no-restart` (`line-service.mjs:236-249`). It collides with the kicked drain on `queue.lock`, giving `owner is live or unknown` (`retire-lock.mjs:59`; 45 holds today). The drain aborts whenever the main tip changes (`closeout-code.mjs:36-53`), i.e. after every landing. Removal also takes `lane-promote.lock` (`closeout-executor.mjs:136`). Housekeeping retirement has been skipped 16,036 times since 2026-10-25 18:20Z: the long-running process (pid 12807, started Oct 24) rejects `.lane.json` `settle.timeout: 0`, a value only newer code accepts (fd812792, landed at that minute). The stale loaded code is INFERRED. | Cleanup only. It never gates landing or dispatch. | queue.lock wait 10 s (`closeout.mjs:63-65`); drain deadline 180 s (`supervisor/closeout.mjs:20`). Today: 5 completed, 23 deadline, 8 code handoffs, 148 entries pending, 23 worktrees. |
| 16 | Next dispatch | Line service | After one complete dispatch the loop stops (`line-service.mjs:293`); the next candidate waits for the next pass. | Ordering only. Dispatch already recounts under its own lock. | About 1 worker per 5-7 min. |

ENG-389 dispatch (journal `bac025a8…`, R-872 events), 203 s: pre-checks 33 s, lane open and run start 28 s, claim 28 s, timing writes 9 s, launch and worker recorded 40 s, watcher 19 s, prompt and bind 31 s. About 20 record writes per dispatch; each also scans the inactive promotion queue (502 results, `lib/record-guard.mjs:139-152`). That this scan is the cost is INFERRED.

## What the worker is told, in order

The line-service ask (`line-service.mjs:288`): "Self-land OWN source and hand its immutable landed tuple/evidence to record queue-review; never start a parallel settle/lane review." The dispatch prompt (`dispatch.mjs:623-634`) then tells the worker, in this order:

1. Read the ask and the record brief.
2. Do the work and commit.
3. Run the focused check once through `lane check`.
4. Self-land through `lane promote`, with clean/rebase/FF guards (`628`).
5. Put the landed base and head in the report for `queue-review` (`627`).
6. Write the report to `runs/R-n/report.md`, check it and stop (`render.mjs:443-447`).

So the instructions say **land, then report**. `lane promote --if-current-run` assumes **report, then land**.

## Landing preconditions (`lane promote`)

- **CLI.** `--if-current-run` requires `--expected-head` and `--org` (`lane.mjs:2954`).
- **Memory wait.** Skipped under the waiver (`2618`).
- **Lock.** `lane-promote.lock`, waiting up to 120 s × factor (`2599-2614`).
- **Guard** (`guard.mjs:19-95`), run at `2635`, `2672` and around the FF at `2709`:
  - Always: canonical STOP absent (`29`); `--expected-head` equals the lane tip (`30-33`).
  - Only with `--if-current-run`, after which the guard runs the record checks:
    - the run must be known and must be ordinary work (`41-42`);
    - **`R-n requires a recorded done report; nothing merged`** (`45`). Under the waiver a `blocked` report also passes;
    - the run is not superseded (`46`);
    - the workspace and lane match (`47`) and the Git identity matches (`49`);
    - the outcome belongs to this run (`50`);
    - no open operator question (`53`);
    - not closed, no overlapping open run in the same workspace, no other open runs (`68-72`).
  - Waived checks: review PASS (`56`), open engineer children (`65`), blockers (`72`).
- **Git:**
  - lane and canonical worktrees clean; canonical on `main`; lane on its own branch (`2636-2643`);
  - if the lane is behind main, `--expected-head` refuses outright (`2646`);
  - otherwise `git merge-tree` checks for conflicts and refuses with the list of files (`2650-2654`), then the rebase runs. A replay failure leaves the paused rebase in the lane (`2656-2666`);
  - prepare and validation are skipped under the waiver (`2671`, `2682`);
  - the tip is rechecked (`2699-2708`), then `merge --ff-only` (`2709`). Nothing is pushed.

**Real cases.**
- R-865 (Brain) was refused at 22:18Z for running `--if-current-run` before its report (`.org/evidence/ENG-632/R-865/conditional-promotion-refusal.json`). It then landed without the flag.
- BCH R-3323 hit both ordering gates:
  - **17:45Z:** refused, no report yet. The worker wrote a BLOCKED report and stopped.
  - **17:49Z:** report ingested.
  - **17:50Z:** the supervisor authorized one fresh promotion (seq 46506). The prompt to the worker failed with kill EPERM.
  - **19:39Z:** refused again: `--expected-head`, and the lane was not rebased on current main (seq 46573).
  - **19:42Z:** manual rebase.
  - **19:48Z:** fast-forward (seq 46576, 46588).
  - That is 2 h 03 min from first refusal to landing, all of it ordering, none of it safety.

## Answers

**1. The minimal chain that must happen today.** Before the commit can exist, a lane must exist: dispatch steps 3-8 give each run a unique lane (`line-<item>-<n>`), a claim and a single worker. That is real collision safety. Then:

1. Commit.
2. Clean lane and canonical worktrees.
3. Promotion lock.
4. Conflict-checked rebase if behind.
5. Fast-forward.

Links that exist only for ordering or bookkeeping:
- the report before promote (with `--if-current-run`);
- the refusal to rebase under `--expected-head`;
- the focused check (requested, not enforced);
- the watcher and session binding;
- ingest waiting for the worker to go idle;
- review queueing, source completion and closeout (all after main);
- the memory wait at dispatch;
- one dispatch per pass.

**2. Splitting one item across several engineers.**
- *Several runs per item.* `record start` allows parallel runs and only prints a note (`org.mjs:737`). The line service never does it, because an item with an open run is `active` (`state.mjs:363`). Intake and source completion only look at the last run (`line-service.mjs:150`, `209`), so an earlier run's report is never ingested by the service. With `--if-current-run`, a superseded run cannot promote (`guard.mjs:46`).
- *Child items* come from report proposals (`org.mjs:817-831`). Blocking children make the parent `blocked`. Each child is dispatched as its own item in its own lane.
- *Landing order* is first come, first served on `lane-promote.lock`. Nothing orders sibling landings. `--unblocks` only orders dispatch (`dispatch.mjs:465-467`).
- *File collisions.* Nothing prevents two workers editing the same files: there is no file claim or affected-file admission, and AGENTS.md rules that out. Textual conflicts surface only at promote, as a refusal with the file list or a paused rebase that the worker must resolve. Semantic conflicts are not caught, because validation is waived.

**3. Modules exercised versus dormant.**
- *Exercised:* `line-service/` (line-service, review, review-queue up to the consumer check, cutoff, record-inbox); `dispatch/` (dispatch, session-cap, unlanded-cap as diagnostic, session-bind, hook-review); `lanes/lane.mjs` (open, prepare, dispatch, verify-agent, check, promote), `routes.mjs`, `validation.mjs`; `bin/org.mjs`; `lib/` (store, state, report, render, record-guard, closeout, retire-*, run-owner, memory, deadline); `test-slot/` (proving wait, `lane check`); `watch/watch.mjs`; the closeout drain; `supervisor/prompt-supervisor.mjs`, `notice-lock.mjs`.
- *Dormant, but still consulted as gates:*
  - the promotion queue/train: 0 pending, yet scanned and fail-closed on every record write (`record-guard.mjs:150-152`);
  - autopilot: disabled in `.supervisor.json`; branch at `guard.mjs:22-26,73-90`;
  - settle: never launched, but its receipts are scanned (`review.mjs:53-59`), its file hash is a review capability (`review.mjs:13-14`), and `.lane.json` `settle.timeout` broke housekeeping;
  - legacy lane review: refused under the waiver (`lane.mjs:2370`), but its `.lane-review-*` directories block every review (`review.mjs:106`; created by `lane.mjs:1646-1661`, kept by design);
  - the unlanded counter: still computed on every dispatch;
  - housekeeping: running, but its retirement has been dead since Oct 25;
  - legacy REV children, which still block a parent's close and retirement (`state.mjs:273-276`; `retire.mjs:168-169`). In BCH, ENG-2141 is blocked by REV-1160, and ENG-2124 by ARCH-765, which can never be dispatched.
- *Not in the flow:* `verify/` (no imports from the pipeline).

**4. Guard failures that stop or hold instead of retrying or logging.**
- *Line service:*
  - an occupied `pass.lock` refuses the whole pass (`line-service.mjs:101`);
  - STOP, HOLD or a torn tail (`85-87`);
  - any prior non-complete effect is retained and never replayed (`123-128`);
  - an existing ingest key is skipped silently (`154`);
  - a native identity mismatch or a vanished agent holds intake (`156-159`);
  - review holds (`188`, `201`) and silent historical skips (`171-180`);
  - source-completion holds (`214-215`, `220-228`);
  - closeout keys are never retried automatically (`243`, `249`);
  - dispatch holds for reserved items, legacy REV items and route errors (`272-273`, `278`, `285`);
  - a capacity refusal ends the loop (`296`).
- *dispatch.mjs:* STOP/HOLD (`410-413`); unknown start outcome (`453`); uncertain launch (`523`); stopped watcher (`593`); unknown prompt delivery (`606`); hook dialog (`617`). ENG-231's launch failure at 20:07Z left R-862 counted as an occupied session (uncertain launch) all evening (`session-cap.mjs:185-186,196-199`).
- *lane promote:* every `fail()` from `2628` to `2708`, plus all guard refusals (`guard.mjs:29-72`).
- *Record:* `record-guard` fails closed (`record-guard.mjs:150-152`, `162-164`); conditional close (`org.mjs:620-632`).
- *Closeout:* main-epoch change (`closeout-code.mjs:51`), 180 s deadline, `queue.lock` contention, retirement holds (`retire.mjs:161-169`, `429`).
- *Watcher:* STOP ends it permanently (`watch/README.md`).

## Order problems: removable or reorderable without losing collision or data safety

1. **A review gets exactly one chance before its item closes for good.** The review attempt and source completion run in the same pass (`line-service.mjs:168-203`, then `207-235`). After that, `item.closed` is skipped forever (`171`). Key review debt on the landed head from `report.ingested`, independent of item open/closed. Closing does not need to wait for anything.
2. **Any legacy `.lane-review-*` directory in the canonical root blocks every review** (`review.mjs:100-106`). Match only directories named after this item's own head or runs, or delete the eight inert directories (each holds only `.gitignore`). This dedup heuristic protects no landing.
3. **Binding and cutoff errors are hidden as "historical"** (`line-service.mjs:177-180`). Of 18 Brain reports ingested since 12:00 CDT, 8 fail binding in the read-only re-run ("baseline UNKNOWN", "delivered-source target UNKNOWN"). After the cutover none have failed, but future failures will be invisible. Make them a hold (a `note`) instead.
4. **Route config gaps act as permanent holds.** herdr-brain has no reviewer route or `selection_policy` (`review-queue.mjs:26`; `routes.mjs:243-246`). BCH's 276 ready architect items hit `unknown task class: planning` on every pass (`line-service.mjs:40-41`). Fixing the config is enough; no safety is involved.
5. **"Report before promotion" contradicts the prompt order** (`guard.mjs:45` versus `dispatch.mjs:627-628`). The collision-relevant checks are the current, non-superseded run, the matching workspace and identity, and no overlapping run (`guard.mjs:46-49`, `68-72`). None of them needs the report; require the claim instead. Today this gate only catches workers who opt into the stricter flag (R-865, BCH R-3323).
6. **`--expected-head` forbids the conflict-checked rebase that promote already performs** (`lane.mjs:2646` versus `2650-2668`). Accept the pre-rebase tip as the expected head, rebase cleanly, then FF. Data safety is unchanged: a failed replay still refuses.
7. **Ingest waits for an idle native agent and for the next free pass** (`line-service.mjs:156-160`). The watcher then prompts the worker with its own report notice (`dispatch.mjs:584`; R-871 watch log "supervisor lane-line-eng-385…", delivered 23:06:29Z). That can re-wake the worker (INFERRED; 3 `report-in-flight` events today). Ingest is conditional and idempotent (`org.mjs:802-805`), so it can run as soon as a valid report file exists. Point the watcher at the supervisor, or drop it.
8. **The pass is serial, starts one dispatch, and blocks synchronously** (`line-service.mjs:283-293`, `invoke` at `67-74`). A 3-4.5 min dispatch delays every other ingest and close, and the unbounded memory wait (`memory.mjs:72-74`) is stalling the whole line now (ENG-400). Run dispatch detached, with its journal as the receipt. Allow several dispatches per pass up to the session cap. Bound or remove the memory wait. Dispatch already does a locked recount, so collision safety is kept (`dispatch.mjs:545-549`).
9. **Idempotent effects are never retried.**
   - *What happens now:* retained holds (`line-service.mjs:124-128`), the silent ingest skip (`154`), and source completion keyed by report SHA (`217`) turn one transient failure into a permanent stop.
   - *Why replay is safe here:* `record ingest` and `record close --if-current-run` already refuse a stale or duplicate write (`org.mjs:620-632,802-805`).
   - *What to keep:* no-replay is needed only for native launches and prompts.
10. **Cleanup fights itself.** The line service's drain contends with the kicked drain (`closeout.mjs:63-65`). Every landing invalidates the drain (`closeout-code.mjs:44-53`), and housekeeping is dead on stale code. Cleanup never gates main, but it costs 17-23 s per pass and leaves 148 entries and 23 worktrees. Drop the line-service drain, and bind the closer to its own code identity rather than the main tip.
11. **Every record write pays for dormant subsystems.** It scans the inactive promotion queue (`record-guard.mjs:139-152`) and publishes or kicks closeout (`org.mjs:183-205`). This is INFERRED as the cause of about 3 s per write and about 60 s per dispatch. Skip the queue scan while `queue.json` has no pending or current entries.
12. **Legacy blocking review children and undispatchable blockers keep sources open forever** (`state.mjs:273-276`; `org.mjs:624-626`). BCH: 827 open items are `done` but unclosed, and ENG-2124 is blocked by ARCH-765, which cannot be dispatched. New reviews are already siblings (`review-queue.mjs:82-86`). Treat legacy REV children the same way for closing.
