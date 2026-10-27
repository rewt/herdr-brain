# Pipeline timings: where wall-clock time goes per run (Brain and BCH)

Read-only analysis, data read 2026-10-26T23:29Z. Sources: Brain record `/Users/rewt/development/rewt/.org/events.jsonl` with repo `/Users/rewt/development/rewt/herdr-brain`; BCH record `/Users/rewt/development/bastian/.org/events.jsonl` with repo `/Users/rewt/development/bastian/bch-cloak`; line-service `passes.jsonl` under each record; main-branch reflogs; settle journals (`<record>/settle/R-*.json`); evidence directories by mtime. No project files were changed. Scratch scripts are in `$TMPDIR/pt` (`analyze.mjs`, `render.mjs`, `dsteps.mjs`, `evid.mjs`).

Windows: **A** = 2026-10-23T00:00Z to the read time (95.5 h). **B** = 2026-10-25T23:07Z (the latest Brain release activation) to the read time (24.4 h). All times are UTC unless marked CDT (UTC-5).

## Summary

- **Idle engineers are the largest sink, not engineering.** No engineer run was active for 53.8 h of 95.5 h in Brain (A) and 38.6 h of 95.5 h in BCH (A). In B the figures were 16.5 h of 24.4 h (Brain) and 12.7 h of 24.4 h (BCH). During all of that idle time the record held at least one ready item that a run later picked up. The four longest gaps (12.6, 9.7, 7.7 and 7.1 h) fall overnight CDT, and each starts right after a blocked or done report.
- **Worker time is short and stable.** From "prompt sent" to report ingested took a median of 18.8 min (Brain A), 19.0 min (Brain B) and 17.3 min (BCH B). From `run.started` to "prompt sent" took a median of 15 s in Brain A. In B it took 99 s (Brain) and 75 s (BCH). When the line service dispatches, the whole dispatch effect up to "prompt sent" takes a median of 3.1 min (Brain) and 3.8 min (BCH).
- **Code used to reach main hours after the work finished; since B it reaches main in minutes.** In Brain A the median from "prompt sent" to the run's first commit on main was 82.6 min (p90 11.5 h), and in 43 of 62 attributed runs the last landing came after the report. In Brain B the median is 8.3 min (p90 20.9 min) and 1 of 18 landed after the report. In BCH A the median from run start to first commit on main was 60.1 min (p90 10.9 h); in BCH B it is 10.3 min.
- **Close-out after the report is slow and highly variable.** From report ingested to item closed: Brain A median 108.6 min, p90 11.5 h; BCH A median 95.5 min, p90 23.0 h; BCH B median 5.6 h, p90 19.5 h. Brain B has a median of 105 s, because most closes there are automatic within 1–2 min, but its p90 is 12.5 h: R-851 and R-852 waited for a morning decision.
- **Blocked runs are mostly process, not engineering.** Engineer runs that ended blocked: 28 of 95 (Brain A), 101 of 266 (BCH A) and 31 of 50 (BCH B). In BCH B, blocked runs used 16.1 run-hours against 6.6 for done runs. By keyword, the primary reason is engineering in only 1 of 28 (Brain A) and 15 of 117 (BCH A, review runs included) blocked reports. The rest are scope/authorization, guards and permissions.
- **Small items now carry more overhead than work.** The six line-service Brain runs since 17:00 CDT (R-866..R-871) had these medians: dispatch 3.4 min, worker process 2.6 min, then 4.9 min from worker exit to report ingested and 1.1 min from report to close. The line service dispatches at most one run per pass, and in BCH a pass takes a median of 5.7 min. That allowed 7.45 (Brain) and 9.14 (BCH) dispatches per running hour in the requested window.

## Method and assumptions

- **Window A start.** The request said "2026-10-23 00:00" with no time zone, so 00:00Z is used. Day buckets are UTC days.
- **Run classes.**
  - *review*: route `review*`, or item REV-/role reviewer.
  - *research*: route `research*`/`monitor`, or item RES-/ARCH-.
  - *engineer*: everything else, including IMPL- and runs with no route.
  - Stage tables cover engineer-class runs. A run belongs to a window by its `run.started` time.
- **Stage markers.**
  - "Prompt sent" is the first `note.added` on the run whose text starts with `Dispatch: prompt sent`.
  - "Dispatch pre-start" starts at the earliest `dispatch_waits`/`dispatch_admission_waits` entry, which can come before `run.started`.
  - "Worker process exit" is the last watcher `process_end` recorded before the report. R-819, R-825 and R-828 have 2–4 exits each, which fits resumed sessions.
  - "Item closed" is the first `item.closed` at or after the report.
- **Landing on main.**
  - The landing time is the main reflog time at which a commit first became reachable from `main` (`git rev-list old..new` per reflog entry).
  - A commit is attributed to a run only if it is named in the run's own report, its worker's `session.message.v1`, its `retirement.release` head, a `Promotion:` note or the line-service `source-complete` head, or is on `refs/heads/lane/<lane>` / `archive/*<lane>`. Its author time must also fall between `run.started` and the report.
  - Rebased commits are matched to their main equivalent by identical author time and subject.
  - Runs with no attributable commit are UNKNOWN; they either did not land or the commit could not be matched.
- **Engineer working (proxy, as requested).** An engineer counts as working from `run.started` to `report.ingested` or `run.abandoned`.
  - Runs still open at read time that had a prompt sent within the last 6 h count as active until the read time: R-872, R-3345, R-3346.
  - R-862 is excluded. Its line-service dispatch was held before any prompt was sent.
  - This proxy treats a worker waiting on a pending report as busy, and does not count supervisor or chat work.
- **Ready work.** "Ready" means ready by the record's own rules (an indexed port of `lib/state.mjs` `itemStatus`), not approved by anyone.
  - Status is replayed event by event: closed, open runs, blocking links, REV children, report outcomes and failed verdicts.
  - Goals, HUM- items and items with `meta.hold: true` are excluded.
  - It does not model supervisor priority, the unlanded cap or operator approval.
  - "Ready work that was later dispatched" counts only ready periods that ended with a run starting on that item.
- **Medians and p90.** The median is the 50th percentile (mean of the two middle values when n is even). p90 is nearest-rank. Run-hours add up time per run, so they overlap in wall-clock time.
- **Evidence files.** Counts are regular files by modification time (mtime): Brain `/Users/rewt/development/rewt/.org/evidence` and BCH `/Users/rewt/development/bastian/archive`. A file rewritten later counts on its last day. This research folder is included in the Brain 10-26 count.
- **Blocked clusters.** These are keyword clusters, as requested. They are coarse and are given both as a primary label and as "any mention".
- **Line-service window.** As requested, it starts at 2026-10-26 17:00 CDT (22:00Z), 1.5 h before the read time. The Brain service's first logged pass was 17:18Z (12:18 CDT) and BCH's was 18:33Z, so a whole-lifetime table is given as well.


## 1. Per-run stage timings (engineer-class runs)

Engineer class = every run whose route is not `review*`/`research*`/`monitor` and whose item is not REV-/RES-/ARCH-. Runs are assigned to a window by `run.started`. Median is the 50th percentile (mean of the two middle values for even n); p90 is nearest-rank. n = runs where both endpoints exist.

### Brain, window A (since 2026-10-23T00:00Z)

Runs started: 98 total, 95 engineer-class. With "prompt sent" note: 94. With report: 91. Abandoned: 2. Still open (no report/abandon): R-862, R-872. Landing attributed: 63 (method sha 61, lane-ref 2; of which matched via rebased equivalent 26).

| Stage | n | median | p90 | max |
|---|---:|---:|---:|---:|
| Item created -> first run started (first run of item only) | 43 | 2.3m | 463.9h | 500.6h |
|   ... item created inside window A | 32 | 51s | 27.1m | 32.3h |
|   ... item created before window A | 11 | 463.7h | 475.1h | 500.6h |
| Dispatch pre-start (first memory/admission wait -> run.started) | 95 | 2s | 23s | 2.8m |
| run.started -> "Dispatch: prompt sent" | 94 | 15s | 100s | 33.0m |
| Dispatch total (first wait or run.started -> prompt sent) | 94 | 17s | 2.2m | 33.0m |
| Line-service dispatch effect start -> prompt sent | 9 | 3.1m | 4.1m | 4.1m |
| Prompt sent -> last worker process exit before report | 86 | 11.9m | 51.5m | 13.8h |
| Last worker process exit -> report ingested (ingest lag) | 85 | 92s | 27.2m | 11.4h |
| Prompt sent -> report ingested (worker time) | 91 | 18.8m | 63.6m | 13.9h |
| run.started -> report ingested (fallback when no prompt marker) | 91 | 18.9m | 64.3m | 13.9h |
| Prompt sent -> first attributed commit on main | 63 | 82.6m | 11.5h | 22.2h |
| run.started -> first attributed commit on main | 63 | 95.4m | 11.5h | 22.2h |
| Last attributed landing -> report ingested (negative = landed after report) | 62 | -60.6m | 18.8m | 46.2m |
| Report ingested -> next item.closed | 84 | 108.6m | 11.5h | 21.1h |

### Brain, window B (since 2026-10-25T23:07Z)

Runs started: 22 total, 22 engineer-class. With "prompt sent" note: 21. With report: 20. Abandoned: 0. Still open (no report/abandon): R-862, R-872. Landing attributed: 19 (method sha 18, lane-ref 1; of which matched via rebased equivalent 0).

| Stage | n | median | p90 | max |
|---|---:|---:|---:|---:|
| Item created -> first run started (first run of item only) | 12 | 463.0h | 475.1h | 500.6h |
|   ... item created inside window A | 1 | 13.0m | 13.0m | 13.0m |
|   ... item created before window A | 11 | 463.7h | 475.1h | 500.6h |
| Dispatch pre-start (first memory/admission wait -> run.started) | 22 | 22s | 34s | 2.8m |
| run.started -> "Dispatch: prompt sent" | 21 | 99s | 2.4m | 2.8m |
| Dispatch total (first wait or run.started -> prompt sent) | 21 | 2.0m | 2.8m | 3.5m |
| Line-service dispatch effect start -> prompt sent | 9 | 3.1m | 4.1m | 4.1m |
| Prompt sent -> last worker process exit before report | 17 | 14.1m | 40.0m | 55.3m |
| Last worker process exit -> report ingested (ingest lag) | 16 | 5.5m | 37.0m | 39.1m |
| Prompt sent -> report ingested (worker time) | 20 | 19.0m | 65.2m | 69.5m |
| run.started -> report ingested (fallback when no prompt marker) | 20 | 20.3m | 66.4m | 71.0m |
| Prompt sent -> first attributed commit on main | 19 | 8.3m | 20.9m | 55.5m |
| run.started -> first attributed commit on main | 19 | 9.6m | 22.1m | 57.0m |
| Last attributed landing -> report ingested (negative = landed after report) | 18 | 8.9m | 42.1m | 46.2m |
| Report ingested -> next item.closed | 19 | 105s | 12.5h | 12.6h |

### BCH, window A (since 2026-10-23T00:00Z)

Runs started: 462 total, 266 engineer-class. With "prompt sent" note: 48. With report: 263. Abandoned: 1. Still open (no report/abandon): R-3345, R-3346. Landing attributed: 173 (method sha 153, lane-ref 20; of which matched via rebased equivalent 100).

| Stage | n | median | p90 | max |
|---|---:|---:|---:|---:|
| Item created -> first run started (first run of item only) | 129 | 3.5m | 53.5h | 792.2h |
|   ... item created inside window A | 93 | 117s | 2.3h | 47.0h |
|   ... item created before window A | 36 | 18.0h | 433.0h | 792.2h |
| Dispatch pre-start (first memory/admission wait -> run.started) | 49 | 19s | 41s | 6.2m |
| run.started -> "Dispatch: prompt sent" | 48 | 75s | 2.3m | 2.9m |
| Dispatch total (first wait or run.started -> prompt sent) | 48 | 94s | 3.2m | 7.3m |
| Line-service dispatch effect start -> prompt sent | 11 | 3.8m | 4.4m | 4.5m |
| Prompt sent -> last worker process exit before report | 24 | 8.6m | 28.3m | 40.1m |
| Last worker process exit -> report ingested (ingest lag) | 23 | 4.7m | 41.0m | 53.0m |
| Prompt sent -> report ingested (worker time) | 47 | 17.3m | 62.9m | 101.6m |
| run.started -> report ingested (fallback when no prompt marker) | 263 | 17.0m | 40.5m | 114.4m |
| Prompt sent -> first attributed commit on main | 29 | 8.8m | 27.9m | 2.2h |
| run.started -> first attributed commit on main | 173 | 60.1m | 10.9h | 43.0h |
| Last attributed landing -> report ingested (negative = landed after report) | 173 | -45.0m | 6.4m | 49.5m |
| Report ingested -> next item.closed | 186 | 95.5m | 23.0h | 46.1h |

### BCH, window B (since 2026-10-25T23:07Z)

Runs started: 54 total, 50 engineer-class. With "prompt sent" note: 48. With report: 48. Abandoned: 0. Still open (no report/abandon): R-3345, R-3346. Landing attributed: 29 (method sha 20, lane-ref 9; of which matched via rebased equivalent 3).

| Stage | n | median | p90 | max |
|---|---:|---:|---:|---:|
| Item created -> first run started (first run of item only) | 11 | 432.8h | 788.2h | 792.2h |
|   ... item created inside window A | 1 | 47.0h | 47.0h | 47.0h |
|   ... item created before window A | 10 | 432.9h | 788.2h | 792.2h |
| Dispatch pre-start (first memory/admission wait -> run.started) | 49 | 19s | 41s | 6.2m |
| run.started -> "Dispatch: prompt sent" | 48 | 75s | 2.3m | 2.9m |
| Dispatch total (first wait or run.started -> prompt sent) | 48 | 94s | 3.2m | 7.3m |
| Line-service dispatch effect start -> prompt sent | 11 | 3.8m | 4.4m | 4.5m |
| Prompt sent -> last worker process exit before report | 24 | 8.6m | 28.3m | 40.1m |
| Last worker process exit -> report ingested (ingest lag) | 23 | 4.7m | 41.0m | 53.0m |
| Prompt sent -> report ingested (worker time) | 47 | 17.3m | 62.9m | 101.6m |
| run.started -> report ingested (fallback when no prompt marker) | 48 | 18.7m | 64.0m | 102.7m |
| Prompt sent -> first attributed commit on main | 29 | 8.8m | 27.9m | 2.2h |
| run.started -> first attributed commit on main | 29 | 10.3m | 29.2m | 2.2h |
| Last attributed landing -> report ingested (negative = landed after report) | 29 | 6.4m | 39.6m | 49.5m |
| Report ingested -> next item.closed | 26 | 5.6h | 19.5h | 22.0h |

### 1a. Run-hours by class and outcome

Sum of run.started -> report ingested / run.abandoned, open runs excluded. The dispatch and ingest-lag columns cover all classes, and only runs that have the markers. BCH has markers only in window B, so its A and B values are the same runs.

| Project | Window | engineer done | engineer blocked | engineer other | review | research | dispatch total (sum of first wait/start -> prompt) | last worker process exit -> report ingested (sum) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Brain | A | 41.8h | 34.9h | 2.1h | 0.2h | 0.2h | 1.6h (n=96) | 30.8h (n=86) |
| Brain | B | 7.8h | 2.7h | 0.0h | 0.0h | 0.0h | 0.7h (n=21) | 3.2h (n=16) |
| BCH | A | 51.9h | 44.5h | 0.6h | 55.9h | 3.7h | 1.7h (n=52) | 5.1h (n=24) |
| BCH | B | 6.6h | 16.1h | 0.0h | 0.4h | 0.4h | 1.7h (n=52) | 5.1h (n=24) |

### 1b. Where dispatch time goes (window B, all runs with a "prompt sent" note)

| Step (sequential) | Brain n | Brain median | Brain max | BCH n | BCH median | BCH max |
|---|---:|---:|---:|---:|---:|---:|
| line-service dispatch effect start -> first memory gate wait | 9 | 34s | 42s | 11 | 46s | 63s |
| first gate wait -> run.started | 21 | 22s | 41s | 52 | 18s | 6.2m |
| run.started -> run.claimed | 21 | 32s | 74s | 52 | 21s | 49s |
| run.claimed -> admission lock granted | 15 | 17s | 43s | 24 | 14s | 48s |
| admission granted -> worker pane recorded | 15 | 35s | 56s | 24 | 32s | 56s |
| worker pane recorded -> watcher recorded | 21 | 12s | 22s | 52 | 11s | 28s |
| watcher recorded -> prompt sent | 21 | 10s | 20s | 52 | 10s | 21s |
| prompt sent -> session bound | 15 | 12s | 23s | 24 | 11s | 19s |
| prompt sent -> line-service dispatch effect finished | 9 | 15s | 25s | 11 | 18s | 21s |

Each dispatch is a chain of 10–45 s steps (memory gates, claim, admission lock, pane launch, watcher, prompt). The line service runs one such chain at a time inside its pass.

## 2. Queue gaps and idle engineers

Proxy: an engineer counts as working from run.started to report.ingested or run.abandoned (see assumptions). "Ready" is record-ready.

| Project | Window | Window hours | Hours with >=1 engineer run active | Hours with zero engineer runs | Hours with zero runs of any kind | Zero-engineer hours while ready work that was later dispatched was waiting | Mean count of record-ready items (became ready inside A) during zero-engineer time |
|---|---|---:|---:|---:|---:|---:|---:|
| Brain | A | 95.5h | 41.7h | 53.8h | 53.7h | 53.8h | 13.0 (min 2, max 21) |
| Brain | B | 24.4h | 7.9h | 16.5h | 16.5h | 16.5h | 19.4 (min 19, max 21) |
| BCH | A | 95.5h | 56.9h | 38.6h | 30.1h | 38.6h | 51.1 (min 1, max 74) |
| BCH | B | 24.4h | 11.7h | 12.7h | 12.4h | 12.7h | 66.9 (min 65, max 68) |

Concurrency (hours spent at each number of simultaneously active engineer runs):

| Project | Window | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7+ |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Brain | A | 53.77 | 19.22 | 7.46 | 14.99 | 0.06 | 0 | 0 | 0 |
| Brain | B | 16.51 | 4.82 | 2.98 | 0.06 | 0 | 0 | 0 | 0 |
| BCH | A | 38.63 | 23.03 | 19.9 | 8.05 | 3.66 | 1.6 | 0.49 | 0.13 |
| BCH | B | 12.72 | 4.87 | 3.8 | 1.58 | 1.15 | 0.26 | 0 | 0 |

Longest zero-engineer gaps (window A):

- Brain: 10-23T03:46Z -> 10-23T16:24Z (12.6h; after R-776 done; ended by R-777 started by supervisor-herdr); 10-26T04:20Z -> 10-26T14:02Z (9.7h; after R-851 blocked; ended by R-853 started by supervisor-herdr); 10-25T18:45Z -> 10-26T03:27Z (8.7h; after R-850 blocked; ended by R-851 started by human); 10-24T07:26Z -> 10-24T10:44Z (3.3h; after R-789 done; ended by R-790 started by supervisor-herdr); 10-23T23:03Z -> 10-24T01:38Z (2.6h; after R-785 done; ended by R-786 started by supervisor-herdr); 10-23T18:51Z -> 10-23T21:25Z (2.6h; after R-782 done; ended by R-783 started by supervisor-herdr)
- BCH: 10-26T05:49Z -> 10-26T13:34Z (7.7h; after R-3308 blocked; ended by R-3310 started by supervisor-opus); 10-25T06:50Z -> 10-25T13:56Z (7.1h; after R-3256 blocked; ended by R-3257 started by supervisor-opus); 10-23T21:45Z -> 10-24T00:12Z (2.4h; after R-3023 done; ended by R-3027 started by supervisor-opus); 10-24T07:04Z -> 10-24T09:03Z (2.0h; after R-3089 done; ended by R-3091 started by human); 10-23T07:51Z -> 10-23T09:47Z (1.9h; after R-2922 done; ended by R-2928 started by supervisor-opus); 10-25T23:36Z -> 10-26T01:24Z (1.8h; after R-3293 blocked; ended by R-3295 started by supervisor-opus)

Ready-to-dispatch waits: record-ready periods that ended with a run starting. Waits are clipped at the window start, because the replay starts there; items already ready at the start are "carried backlog".

| Project | Window | Episodes | median wait | p90 wait | max | of which item became ready before A (carried backlog) | median wait, became ready inside window |
|---|---|---:|---:|---:|---:|---:|---:|
| Brain | A | 71 | 3.3m | 92.2h | 95.1h | 12 | 65s (n=59) |
| Brain | B | 19 | 18.5h | 23.9h | 24.0h | 11 | 67s (n=8) |
| BCH | A | 303 | 72s | 6.0h | 95.1h | 21 | 61s (n=282) |
| BCH | B | 22 | 17.9h | 23.6h | 24.0h | 9 | 16.2m (n=13) |

Report ingested -> next run.started in the same project (any item), and -> next run on the same item:

| Project | Window | Reports | median to next dispatch (any item) | p90 | median to next run of same item | p90 | reports with no later run of same item |
|---|---|---:|---:|---:|---:|---:|---:|
| Brain | A | 95 | 7.1m | 119.3m | 13.1m (n=47) | 10.8h | 48 |
| Brain | B | 20 | 11.1m | 9.7h | 42.8m (n=8) | 10.3h | 12 |
| BCH | A | 460 | 117s | 21.3m | 22.2m (n=162) | 7.5h | 298 |
| BCH | B | 52 | 13.5m | 83.8m | 40.2m (n=29) | 2.6h | 23 |

## 3. Outcomes

| Project | Window | Class | done | blocked | needs_human | failed | abandoned | open (no report) | total |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| Brain | A | engineer | 61 | 28 | 1 | 1 | 2 | 2 | 95 |
| Brain | A | review | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| Brain | A | research | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| Brain | B | engineer | 16 | 4 | 0 | 0 | 0 | 2 | 22 |
| BCH | A | engineer | 161 | 101 | 0 | 1 | 1 | 2 | 266 |
| BCH | A | review | 163 | 16 | 4 | 5 | 3 | 0 | 191 |
| BCH | A | research | 2 | 0 | 3 | 0 | 0 | 0 | 5 |
| BCH | B | engineer | 17 | 31 | 0 | 0 | 0 | 2 | 50 |
| BCH | B | review | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| BCH | B | research | 1 | 0 | 0 | 0 | 0 | 0 | 1 |

Blocked-report reasons, keyword clusters. Primary = first matching cluster (in the order listed) over the headline plus the FIRST blocker; "any mention" counts every cluster matched anywhere in headline + all blockers (a report can hit several).

| Project | Window | Cluster | primary | any mention | example runs (primary) |
|---|---|---|---:|---:|---|
| Brain | A (28 blocked) | permission/sandbox | 3 | 5 | R-818, R-850, R-857 |
| Brain | A (28 blocked) | guard/refusal | 8 | 18 | R-794, R-819, R-829, R-837, R-840, R-851 |
| Brain | A (28 blocked) | stale/superseded | 2 | 5 | R-830, R-831 |
| Brain | A (28 blocked) | scope/supervisor/authorization | 14 | 25 | R-803, R-825, R-826, R-832, R-833, R-834 |
| Brain | A (28 blocked) | engineering (tests/build/deps/defect) | 1 | 16 | R-790 |
| Brain | A (28 blocked) | other/unclassified | 0 |  |  |
| Brain | B (4 blocked) | permission/sandbox | 1 | 1 | R-857 |
| Brain | B (4 blocked) | guard/refusal | 3 | 3 | R-851, R-852, R-853 |
| Brain | B (4 blocked) | stale/superseded | 0 | 1 |  |
| Brain | B (4 blocked) | scope/supervisor/authorization | 0 | 4 |  |
| Brain | B (4 blocked) | engineering (tests/build/deps/defect) | 0 | 0 |  |
| Brain | B (4 blocked) | other/unclassified | 0 |  |  |
| BCH | A (117 blocked) | permission/sandbox | 18 | 21 | R-2930, R-2959, R-3027, R-3028, R-3030, R-3035 |
| BCH | A (117 blocked) | guard/refusal | 27 | 47 | R-2981, R-3094, R-3155, R-3198, R-3201, R-3227 |
| BCH | A (117 blocked) | stale/superseded | 9 | 13 | R-2940, R-2945, R-2995, R-3057, R-3194, R-3331 |
| BCH | A (117 blocked) | scope/supervisor/authorization | 43 | 84 | R-2886, R-2910, R-2912, R-2915, R-2950, R-2968 |
| BCH | A (117 blocked) | engineering (tests/build/deps/defect) | 15 | 73 | R-3006, R-3039, R-3040, R-3095, R-3215, R-3220 |
| BCH | A (117 blocked) | other/unclassified | 5 |  | R-3096, R-3183, R-3236, R-3282, R-3326 |
| BCH | B (31 blocked) | permission/sandbox | 4 | 6 | R-3299, R-3300, R-3319, R-3320 |
| BCH | B (31 blocked) | guard/refusal | 16 | 20 | R-3293, R-3295, R-3296, R-3297, R-3298, R-3301 |
| BCH | B (31 blocked) | stale/superseded | 4 | 5 | R-3331, R-3340, R-3341, R-3343 |
| BCH | B (31 blocked) | scope/supervisor/authorization | 5 | 22 | R-3309, R-3313, R-3324, R-3325, R-3327 |
| BCH | B (31 blocked) | engineering (tests/build/deps/defect) | 1 | 16 | R-3335 |
| BCH | B (31 blocked) | other/unclassified | 1 |  | R-3326 |

Recurring blocker signatures, by exact pattern match over headline, blockers and summary of blocked reports. A report can match several signatures. Only signatures with at least one match are shown:

| Signature | Brain A | Brain B | BCH A | BCH B | examples |
|---|---:|---:|---:|---:|---|
| "source/witness preparation only", functional proof held | 7 | 0 | 0 | 0 | R-825, R-826, R-830, R-833, R-834 |
| Herdr workspace w3PD repository identity mismatch at review launch | 2 | 2 | 0 | 0 | R-851, R-852 (R-853 reports the same refusal in other words) |
| Git worktree metadata lock creation refused (index.lock, ORIG_HEAD.lock, rebase-merge) | 1 | 0 | 7 | 3 | R-818, R-2930, R-2959, R-3299, R-3300, R-3319 |
| sandbox refusal or stop (pattern hits after reading each: R-3191 and R-3197 mention "sandbox" but are not refusals and are excluded) | 0 | 0 | 7 | 0 | R-3027, R-3028, R-3030, R-3061, R-3178, R-3186, R-3196 |
| missing dependency / offline install / TypeScript not found (ERR_PNPM*, ERR_MODULE_NOT_FOUND, missing offline tarball/cache, brief forbids installing) | 0 | 0 | 15 | 0 | R-3040, R-3170, R-3180, R-3252, R-3256, R-3268 |
| file/line cap or slice exceeded, needs smaller or wider scope | 0 | 0 | 11 | 1 | R-2915, R-2968, R-3119, R-3327 |
| EVIDENCE_PRIVATE_VALUE output guard | 0 | 0 | 6 | 4 | R-3289, R-3292, R-3295, R-3296, R-3297, R-3334 |
| promotion refused: "requires a recorded done report" (cannot land before reporting done) | 0 | 0 | 2 | 2 | R-3321, R-3323 |
| project supervisor exception address UNKNOWN | 1 | 1 | 0 | 0 | R-857 |

Runs per item (window A):

| Project | items with runs | 1 run | 2 runs | 3-4 runs | 5+ runs | max |
|---|---:|---:|---:|---:|---:|---:|
| Brain | 50 | 35 | 5 | 5 | 5 | 11 |
| BCH | 299 | 220 | 45 | 25 | 9 | 17 |

Items dispatched 3 or more times in window A (runs in B in parentheses):

Brain:

| Item | runs A (B) | outcomes | title |
|---|---:|---|---|
| ENG-631 | 11 (2) | R-830:blocked R-831:blocked R-833:blocked R-834:blocked R-835:blocked R-836:blocked R-839:blocked R-842:blocked R-847:done R-851:blocked R-853:blocked | Remove elapsed gate-controller execution and cleanup limits without changing ownership or real-error semantics |
| ENG-536 | 7 (0) | R-794:blocked R-795:done R-796:done R-797:done R-800:abandoned R-803:blocked R-804:done | Implement ENG-515 option B per the accepted closeout contract amendment (ENG-530, docs/contracts/CLOSEOUT.md o |
| ENG-603 | 7 (0) | R-798:abandoned R-802:done R-805:done R-806:done R-808:done R-812:done R-815:done | Bug: re-adopt is impossible after the 10-22 adoption's unaudited rollback, and a refused adopt leaves partial  |
| ENG-622 | 5 (0) | R-820:failed R-832:blocked R-841:blocked R-844:blocked R-846:done | Remove elapsed-time test failures and inventory all enforcement consumers |
| ENG-632 | 5 (5) | R-855:done R-860:done R-863:done R-864:done R-865:done | Minimal line-service hotfix: advance existing approved-ready work without a chat session |
| ENG-625 | 4 (0) | R-822:needs_human R-838:blocked R-845:done R-848:done | Measure the longest recorded Brain test and apply its freeze threshold |
| ENG-629 | 4 (0) | R-825:blocked R-840:blocked R-843:blocked R-850:blocked | Validate releases in genuine source checkouts and prove strict package equality |
| ENG-624 | 4 (2) | R-829:blocked R-837:blocked R-852:blocked R-854:done | Remove the shared test runner elapsed exit fallback |
| ENG-595 | 3 (0) | R-787:done R-788:done R-789:done | Test time in watch mode for Brain runs (operator standing directions 10-23 21:1x and 21:4x): nothing fails on  |
| ENG-285 | 3 (3) | R-856:done R-859:done R-861:done | Project chats talk to every supervisor and chat through Herdr (operator 2026-10-08: 'the main thing we need to |

BCH:

| Item | runs A (B) | outcomes | title |
|---|---:|---|---|
| ENG-2143 | 17 (8) | R-3220:blocked R-3272:blocked R-3275:blocked R-3277:blocked R-3280:blocked R-3282:blocked R-3286:blocked R-3289:blocked R-3292:blocked R-3293:blocked R-3295:blocked R-3297:blocked R-3299:blocked R-3303:blocked R-3308:blocked R-3310:done R-3314:done | Implement exact-provenance occurrence-only private corpus admission repair under REV-1159 concurrence; five pa |
| ENG-2157 | 14 (12) | R-3283:failed R-3288:done R-3296:blocked R-3298:blocked R-3300:blocked R-3301:blocked R-3306:blocked R-3309:blocked R-3311:done R-3315:blocked R-3318:blocked R-3321:blocked R-3324:blocked R-3334:blocked | Conditional staged Vitest portable patch composition A/B/C under accepted upstream identity |
| ENG-2031 | 7 (0) | R-3006:blocked R-3027:blocked R-3028:blocked R-3029:done R-3032:done R-3061:blocked R-3077:blocked | FIX the moving wallet-IPC test failures at their cause (canary checker exit 77; wallet child exit 70 store-bus |
| ENG-2124 | 7 (4) | R-3228:blocked R-3233:done R-3244:done R-3323:blocked R-3327:blocked R-3328:done R-3332:done | Wallet admission slice 1: implement measured resource policy and machine probes |
| ENG-2150 | 7 (0) | R-3241:blocked R-3252:blocked R-3262:blocked R-3264:done R-3268:blocked R-3270:blocked R-3271:done | Implement the T2 exact-zero pnpm-owned Vitest2.1.9 exit patch and one committed actual-boundary regression |
| ENG-2141 | 6 (2) | R-3211:done R-3224:done R-3266:blocked R-3269:blocked R-3312:done R-3317:done | Rehearsal machinery M4: bind full test and declared typecheck receipts to post-push clone bytes |
| ENG-1866 | 6 (4) | R-3215:blocked R-3226:done R-3319:blocked R-3325:blocked R-3335:blocked R-3339:done | Make the wallet's mis-tagged-payment disclosures match the scans it actually offers |
| ENG-2159 | 5 (0) | R-3256:blocked R-3257:blocked R-3259:blocked R-3260:done R-3265:done | M5-C actual release context through report build and limited-coverage reconstruction |
| ENG-2152 | 5 (0) | R-3274:blocked R-3281:blocked R-3284:blocked R-3285:done R-3291:done | Bind the manual producer recipe to the existing Brain guarded entry before installation |
| REV-1034 | 4 (0) | R-2907:done R-2920:done R-2925:done R-2926:done | Review of ENG-1997 (A1 companion run-events expectation, b2cd5ded) and the supervisor's A1 enrollment resoluti |
| ENG-2132 | 4 (0) | R-3189:done R-3203:blocked R-3207:done R-3213:done | Rehearsal machinery M5-A: version-aware D1 disclosure facade (scripts/public-export/rehearsal-version-disclosu |
| ENG-1836 | 4 (2) | R-3197:blocked R-3248:blocked R-3313:blocked R-3316:done | Bind M2 privacy controls to the complete selected lifecycle observation set |
| ENG-1945 | 3 (0) | R-2897:done R-2903:done R-2906:done | Exit S2: release and independently read the approved withdrawal delivery |
| REV-1033 | 3 (0) | R-2901:done R-2904:done R-2908:done | CRITICAL review of ENG-1945 (exit S2, released withdrawal bytes independently checked) at 62d76ed7 |
| ENG-1997 | 3 (0) | R-2905:done R-2917:done R-2924:done | Reconcile the run-events CLI expectation in a one-file A1 companion slice |
| ENG-1976 | 3 (0) | R-2910:blocked R-2912:blocked R-2915:blocked | Complete settlement context in generated scenario runbook commands after the CLI repair |
| ENG-2011 | 3 (0) | R-2957:done R-2965:done R-2983:done | Close the CLI owning-refusal diagnostic path against hostile code values |
| ENG-2007 | 3 (0) | R-2959:blocked R-2963:done R-2966:done | Rebind the five MIG01 runner controls to independently measured fail-closed mutation oracles |
| ENG-1953 | 3 (0) | R-2968:blocked R-2972:done R-2986:done | Exit S10: activate truthful local withdrawal readiness and close registry coverage |
| ENG-2026 | 3 (0) | R-2998:done R-3002:done R-3009:done | Publication walking skeleton P1 (K1+K2): private rehearsal target, covenant-shielded-pool-v1 profile bound to  |
| ENG-2028 | 3 (0) | R-3003:done R-3016:done R-3021:done | Setup repair M1a: oracle-only probe measure-setup-control.py + synthetic controls; no real collection (ARCH-74 |
| ENG-2032 | 3 (0) | R-3007:done R-3013:done R-3018:done | Walking skeleton a1: never-pushing working-copy guard + recorded authored-source field (K3 prep) |
| ENG-2056 | 3 (0) | R-3052:done R-3059:done R-3067:done | R1: explicit LIMITED rehearsal scan report: closed coverage statuses; nothing reads as passed while a check is |
| ENG-2057 | 3 (0) | R-3053:done R-3060:done R-3073:done | B1: private-value provider receipt subject + freshness validation library (synthetic providers only) |
| ENG-2074 | 3 (0) | R-3086:done R-3144:done R-3148:abandoned | Catch one real checker-stdin stall with lsof and stack samples, under the PAM lock, on a desk that can take it |
| REV-1129 | 3 (0) | R-3137:blocked R-3139:blocked R-3140:done | CRITICAL review of D1-yes S4 (ENG-2095) at bc60d15e: K5a disclosure read at f, null-corpus scans, implementati |
| ENG-1954 | 3 (0) | R-3173:blocked R-3178:blocked R-3202:done | Exit S11: enable the reviewed Chipnet construction route without claiming certification |
| ENG-2120 | 3 (0) | R-3175:done R-3185:done R-3201:blocked | ENG-1699/S6: write an explicitly selected unnamed broadcast approval digest (T/fresh-packet/approve.mjs + T/te |
| ENG-1934 | 3 (0) | R-3176:blocked R-3186:blocked R-3187:done | Memory-aware proving admission: derive wallet limits from the measured peak plus margin; 16 GB minimum; use mo |
| REV-1149 | 3 (0) | R-3183:blocked R-3210:blocked R-3225:done | Independent DESIGN review of ENG-1934 (wallet proving admission: 16 GiB total, child peak + 25% available; 6-s |
| ENG-2134 | 3 (0) | R-3192:done R-3258:done R-3263:done | Rehearsal machinery M3: replace hard-coded export counts (21/8/4/10/30 incl. promote.mjs) with exact equality  |
| ENG-1933 | 3 (1) | R-3198:blocked R-3240:blocked R-3302:blocked | Safe tree census with operator attribution for the M3 anonymity-set disclosure |
| ENG-2158 | 3 (2) | R-3254:done R-3305:blocked R-3307:done | M5-B actual resolved release context for R1 admissions on accepted M5-A stack |
| ENG-1126 | 3 (3) | R-3341:blocked R-3343:blocked R-3345:open | Queue adoption rehearsal on current bch-cloak main, from a host shell, in a disposable clone — one 3-lane batc |

## 4. Overhead per UTC day

### Brain

| Day | events | closeout.evaluated | closeout.effect | note.added | run.updated | item.* | link.* | run.started | report.ingested | session.message.v1 | review.verdict | other | commits landed on main (reflog) | evidence files by mtime (.org/evidence) | events per landed commit | evidence files per landed commit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-10-23 | 483 | 163 | 15 | 97 | 89 | 38 | 12 | 11 | 12 | 0 | 8 | 38 | 0 | 174 | n/a | n/a |
| 2026-10-24 | 1134 | 278 | 85 | 257 | 244 | 89 | 6 | 30 | 28 | 0 | 14 | 103 | 83 | 17547 | 13.7 | 211.4 |
| 2026-10-25 | 981 | 105 | 100 | 302 | 237 | 51 | 8 | 35 | 35 | 0 | 7 | 101 | 104 | 1086 | 9.4 | 10.4 |
| 2026-10-26 | 451 | 28 | 0 | 104 | 158 | 28 | 0 | 22 | 20 | 39 | 0 | 52 | 49 | 723 | 9.2 | 14.8 |

Evidence directories with the most files modified since A: ENG-536 (17091), HOTFIX-GATING-20261025 (443), ENG-603 (173), ENG-631 (161), MINIMAL-LINE-SERVICE-HOTFIX-20261026 (144).

### BCH

| Day | events | closeout.evaluated | closeout.effect | note.added | run.updated | item.* | link.* | run.started | report.ingested | session.message.v1 | review.verdict | other | commits landed on main (reflog) | evidence files by mtime (bastian/archive) | events per landed commit | evidence files per landed commit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2026-10-23 | 7278 | 5827 | 189 | 349 | 142 | 216 | 111 | 142 | 145 | 0 | 0 | 157 | 63 | 4816 | 115.5 | 76.4 |
| 2026-10-24 | 6043 | 4199 | 213 | 417 | 178 | 341 | 153 | 179 | 172 | 0 | 0 | 191 | 84 | 9117 | 71.9 | 108.5 |
| 2026-10-25 | 3066 | 1905 | 267 | 396 | 89 | 94 | 31 | 88 | 92 | 0 | 0 | 104 | 39 | 2538 | 78.6 | 65.1 |
| 2026-10-26 | 1200 | 32 | 0 | 441 | 335 | 73 | 0 | 53 | 51 | 39 | 0 | 176 | 75 | 7807 | 16.0 | 104.1 |

Evidence directories with the most files modified since A: PUBLICATION-SKELETON-EVIDENCE-20261023 (6924), ENG-1126-R-3341-20261026 (5575), scratch-manifests (1216), WALLET-IPC-FLAKE-EVIDENCE-20261023 (1036), PUSH2-PROPOSED32-20261026 (975).

## 5. Reviews per UTC day

| Project | Day | REV items added | review-class runs started | review-class runs reported | settle reviews started | settle reviews finished with verdict | review.verdict events |
|---|---|---:|---:|---:|---:|---:|---:|
| Brain | 2026-10-23 | 0 | 0 | 0 | 7 | 7 | 8 |
| Brain | 2026-10-24 | 0 | 0 | 0 | 14 | 14 | 14 |
| Brain | 2026-10-25 | 0 | 1 | 1 | 7 | 7 | 7 |
| Brain | 2026-10-26 | 0 | 0 | 0 | 3 | 0 | 0 |
| BCH | 2026-10-23 | 50 | 70 | 69 | 0 | 0 | 0 |
| BCH | 2026-10-24 | 79 | 88 | 86 | 0 | 0 | 0 |
| BCH | 2026-10-25 | 21 | 30 | 30 | 0 | 0 | 0 |
| BCH | 2026-10-26 | 5 | 3 | 3 | 9 | 6 | 0 |

Landing vs verdict (signed: positive = verdict after landing; negative = verdict before the reviewed commit reached main):

| Project | Source | n | verdict before landing (n, median lead) | verdict after landing (n, median, max) | review duration median |
|---|---|---:|---|---|---:|
| Brain | settle | 10 | 10, 38.8m | 0, n/a, n/a () | 3.1m |
| Brain | review.verdict | 9 | 9, 45.4m | 0, n/a, n/a () | n/a |
| BCH | settle | 3 | 0, n/a | 3, 3.0h, 9.2h (R-3312, R-3316, R-3322) | 6.6m |
| BCH | review-run | 38 | 28, 6.8m | 10, 2.3h, 26.8h (R-2943, R-2946, R-2955, R-2961, R-3113, R-3199, R-3217, R-3294, R-3329, R-3330) | 11.9m |

## 6. Line service

Running intervals come from `controls.jsonl` stop/restart records, each ending at the last logged pass line:

- **Brain:** 17:18:32–18:48:09, 19:59:25–20:23:00, 21:31:37–22:11:42 and 22:26:31–23:11:09Z. That is 3.30 h running, with 10 dispatch effects (3.03 per running hour).
- **BCH:** 18:33:36–18:48:29 and 21:56:11–23:05:38Z. That is 1.41 h running, with 11 dispatch effects (7.83 per running hour).
- **In the requested window:** Brain ran 0.94 h with 7 dispatches (7.45 per hour) and BCH ran 1.09 h with 10 dispatches (9.14 per hour).

The "hours" and "dispatches per hour" columns below use wall-clock hours. Neither service logged anything after 23:11:09Z (Brain) and 23:05:38Z (BCH), up to the read time; see Top 5, item 4.

### requested window, since 2026-10-26 17:00 CDT (22:00Z)

| Project | from | hours | passes (complete/incomplete) | pass duration median | p90 | max | pass start-to-start median | dispatch effects (complete/held) | dispatches per hour | dispatch effect duration median | p90 | runs started by line-service |
|---|---|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| Brain | 10-26T22:00Z | 1.49 | 24/1 | 10s | 6.0m | 7.2m | 43s | 7/0 | 4.69 | 3.6m | 4.5m | 7 |
| BCH | 10-26T22:00Z | 1.49 | 10/1 | 5.7m | 6.3m | 6.5m | 6.2m | 10/0 | 6.70 | 4.1m | 4.7m | 11 |

Effect durations inside passes (finished_at - at), median (n):

- Brain: dispatch:complete 3.6m (n=7); ingest:complete 46s (n=7); source-complete:complete 58s (n=7); closeout:held 20s (n=3)
- BCH: dispatch:complete 4.1m (n=10); ingest:complete 56s (n=9); source-complete:complete 50s (n=6); closeout:held 20s (n=3)

Holds by reason (top 10; ids/paths/numbers normalised to placeholders):

| Project | count | boundary/reason |
|---|---:|---|
| Brain | 50 | hold: T# source completion needs supervisor judgment: reported source <hex> is not integrated at <hex> |
| Brain | 9 | hold: unlanded count #, cap #: <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>. Only a fix round with --from-run or a landing follow-up wit |
| Brain | 8 | hold: unlanded count #, cap #: <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>. Only a fix round with --from-run or a landing follow |
| Brain | 6 | hold: T# automatic review held: unmapped native/direct review delivery retained: <path> |
| Brain | 6 | hold: closeout: locked: <path>; owner is live or unknown |
| Brain | 3 | effect held: closeout: closeout: locked: <path>; owner is live or unknown |
| BCH | 141 | hold: unknown task class: planning |
| BCH | 9 | hold: T# source completion needs supervisor judgment: held/reserved item or report blockers/questions; no explicit-judgment override used |
| BCH | 6 | hold: closeout: locked: <path>; owner is live or unknown |
| BCH | 3 | hold: T# automatic review held: unmapped native/direct review delivery retained: <path> |
| BCH | 3 | effect held: closeout: closeout: locked: <path>; owner is live or unknown |

### whole service lifetime (from first logged pass)

| Project | from | hours | passes (complete/incomplete) | pass duration median | p90 | max | pass start-to-start median | dispatch effects (complete/held) | dispatches per hour | dispatch effect duration median | p90 | runs started by line-service |
|---|---|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| Brain | 10-26T17:18Z | 6.18 | 178/1 | 9s | 50s | 7.2m | 41s | 9/1 | 1.62 | 3.5m | 4.5m | 9 |
| BCH | 10-26T18:33Z | 4.93 | 16/2 | 5.3m | 6.5m | 10.4m | 5.8m | 11/0 | 2.23 | 4.1m | 4.7m | 12 |

Effect durations inside passes (finished_at - at), median (n):

- Brain: ingest:complete 47s (n=15); source-complete:complete 51s (n=13); dispatch:complete 3.4m (n=9); closeout:held 17s (n=8); source-complete:held 1s (n=4); review:held 0s (n=2); review:complete 32s (n=2); closeout:complete 55s (n=2); dispatch:held 5.1m (n=1)
- BCH: dispatch:complete 4.1m (n=11); ingest:complete 56s (n=9); source-complete:complete 50s (n=8); review:complete 84s (n=6); source-complete:held 5s (n=4); closeout:held 20s (n=3)

Holds by reason (top 10; ids/paths/numbers normalised to placeholders):

| Project | count | boundary/reason |
|---|---:|---|
| Brain | 361 | hold: T# source completion needs supervisor judgment: reported source <hex> is not integrated at <hex> |
| Brain | 329 | hold: Command failed: git -C <path> rev-parse --show-toplevel --path-format=absolute --git-common-dir fatal: cannot change to '<path>': No such fi |
| Brain | 125 | hold: unlanded count #, cap #: <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>. Only a fix round with --from-run or a landing follow-up wit |
| Brain | 45 | hold: closeout: locked: <path>; owner is live or unknown |
| Brain | 43 | hold: unlanded count #, cap #: <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>. Only a fix round with --from-run or a landing follow |
| Brain | 10 | hold: prior failed/uncertain effect retained; inspect its existing receipt, do not replay |
| Brain | 7 | effect held: closeout: closeout: locked: <path>; owner is live or unknown |
| Brain | 6 | hold: T# automatic review held: unmapped native/direct review delivery retained: <path> |
| Brain | 5 | hold: worker report needs supervisor judgment |
| Brain | 3 | effect held: source-complete: T# source completion needs supervisor judgment: reported source <hex> is not integrated at <hex> |
| BCH | 159 | hold: unknown task class: planning |
| BCH | 24 | hold: record: conditional close needs supervisor judgment: work, blockers or outcome changed |
| BCH | 10 | hold: T# source completion needs supervisor judgment: held/reserved item or report blockers/questions; no explicit-judgment override used |
| BCH | 6 | hold: closeout: locked: <path>; owner is live or unknown |
| BCH | 5 | hold: unlanded count #, cap #: <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>, <ENG>. Only a fix round with --from-run or a landing follow-up wit |
| BCH | 4 | effect held: source-complete: record: conditional close needs supervisor judgment: work, blockers or outcome changed |
| BCH | 3 | hold: worker report needs supervisor judgment |
| BCH | 3 | hold: T# automatic review held: unmapped native/direct review delivery retained: <path> |
| BCH | 3 | effect held: closeout: closeout: locked: <path>; owner is live or unknown |


## Top 5 time sinks

Ranked by measured wall-clock hours or run-hours. Each figure is copied from the tables above or from the run records named.

### 1. No engineer working while ready work waited

- **How much.** Zero engineer runs were active for:
  - Brain: 53.8 h of 95.5 h in A, and 16.5 h of 24.4 h in B.
  - BCH: 38.6 h of 95.5 h in A, and 12.7 h of 24.4 h in B.

  In all of those hours at least one record-ready item existed that a run later started on. While no engineer was working, the mean number of record-ready items was 13.0 (Brain A) and 51.1 (BCH A).
- **Brain, 10-26T04:20Z–14:02Z (9.7 h, 23:20–09:02 CDT).** R-851 (ENG-631) and R-852 (ENG-624) reported blocked: the w3PD identity guard refused their review, and the reports keep the exception "for the single morning decision" (R-852) and "for the existing morning decision" (R-851). Nothing ran until R-853 started at 14:02Z.
- **Brain, 10-23T03:46Z–16:24Z (12.6 h).** This followed R-776. ENG-539 and ENG-547 had been record-ready since 00:11Z, but R-778 and R-779 started only at 17:34Z and 17:35Z. They then took 7.2 and 4.3 min from prompt to report.
- **BCH, 10-26T05:49Z–13:34Z (7.7 h).** This followed R-3308 (ENG-2143, blocked); R-3310 ended it.
- **BCH, 10-25T06:50Z–13:56Z (7.1 h).** This followed R-3256 (ENG-2159, blocked), with 10 items waiting that had become ready inside A. For example, ENG-2134 was ready at 00:18Z and its run started at 14:01Z.
- **Legacy backlog.** Legacy Brain items ENG-232, 240, 256, 258, 263 and 385 were created 217–475 h before their first run. The line service ran them today as R-866..R-871, and each needed only 6.5–13.5 min from prompt to report.

### 2. Code reached main hours after the work was done (window A; largely fixed in B)

- **Brain A.** The median from "prompt sent" to the run's first commit on main was 82.6 min (p90 11.5 h). In 43 of 62 attributed runs the last landing came after the report: median 164.0 min after it, p90 10.4 h.
  - R-776 (ENG-555): reported 10-23T03:46Z, landed 10-24T00:53Z, 21.1 h later.
  - R-822 (ENG-625): 16.3 h after the report.
  - R-820 (ENG-622): 15.6 h.
  - R-829 (ENG-624): 14.7 h.
  - R-795, R-796 and R-797 (ENG-536) reported between 13:25Z and 14:18Z and all landed in one train at 10-24T23:52Z, 9.6–10.4 h later.
- **BCH A.** 146 of 173 attributed runs landed after their report: median 60.9 min after it, p90 12.6 h. R-3215 (ENG-1866) landed 42.7 h after its report; R-3233 and R-3244 (ENG-2124) landed about 41 h after theirs.
- **Since B (self-landing).** The median from prompt to first landing is 8.3 min in Brain and 8.8 min in BCH. Only 1 of 18 (Brain) and 7 of 29 (BCH) attributed runs landed after their report. The largest BCH case was R-3319, 3.6 h after its report, which says Git worktree permissions blocked committing.

### 3. Blocked runs and repeated dispatch of an unchanged item

- **Blocked share of engineer runs:**
  - Brain A: 28 of 95, using 34.9 run-hours against 41.8 for done runs.
  - BCH A: 101 of 266, using 44.5 run-hours against 51.9.
  - BCH B: 31 of 50, using 16.1 run-hours against 6.6.
- **Primary reason is rarely engineering.** By keyword, engineering is the primary reason in 1 of 28 (Brain A), 15 of 117 (BCH A, review runs included) and 1 of 31 (BCH B). Brain A is dominated by scope/supervisor/authorization (14). BCH B is dominated by guard/refusal (16).
- **Brain ENG-631: 11 runs in A, 10 blocked.** R-830, R-833, R-834, R-835 and R-836 each report that source preparation is complete, or "SOURCE/WITNESS PREPARATION ONLY", with functional proof held.
- **BCH ENG-2143: 17 runs, 15 blocked.**
  - R-3272, R-3275, R-3277, R-3280, R-3282 and R-3286 stopped at provenance or scope boundaries.
  - The EVIDENCE_PRIVATE_VALUE output guard refused R-3289, R-3292, R-3295 and R-3297.
  - R-3303 and R-3308 found uncovered or non-eligible matches.
- **BCH ENG-2157: 14 runs, 11 blocked.**
- **Line-service redispatch loop on ENG-1126.** The same retired-path/scope blocker produced three runs in 24 minutes:
  - R-3341 started 22:36Z and was blocked at 22:44Z.
  - R-3343 started 2.7 min later, reported "this redispatch supplies no..." and was blocked at 22:56Z.
  - R-3345 started 3.9 min after that and was still open at read time.
  - Its archive directory `ENG-1126-R-3341-20261026` holds 5,575 files.
- **Order-of-operations refusal.** R-3321 and R-3323 could not land because native promotion "requires a recorded done report", while the self-landing policy has the worker land before its done report.

### 4. Bookkeeping after the work: report to close, ingest lag and serial dispatch

- **Report to item closed:**
  - Brain A: median 108.6 min, p90 11.5 h (R-776 21.1 h, R-781 17.1 h).
  - BCH A: median 95.5 min, p90 23.0 h (R-3215 46.1 h).
  - BCH B: median 5.6 h, p90 19.5 h (R-3293 22.0 h, R-3295 20.0 h).
  - Brain B: median 105 s, p90 12.5 h (R-852 12.6 h, R-851 12.5 h).
- **Worker exit to report ingested.**
  - Brain A summed 30.8 h over 86 runs. Most of it was two overnight waits: R-825, whose worker exited at 03:03Z with the report ingested 11.4 h later, and R-830 (10.8 h).
  - In B the median is 5.5 min (Brain) and 4.7 min (BCH), about the length of a BCH pass (median 5.7 min).
- **Six Brain line-service runs since 17:00 CDT (R-866..R-871).** Medians per run:
  - dispatch: 3.4 min
  - worker process: 2.6 min
  - worker exit to report ingested: 4.9 min
  - report to close: 1.1 min

  That is 9.4 min of pipeline overhead around 2.6 min of worker process time. Code reached main 0.9–2.7 min after the prompt.
- **Serial dispatch caps throughput.** The line service makes at most one dispatch per pass. A dispatch effect takes a median of 3.6 min (Brain) or 4.1 min (BCH), and in the requested window a BCH pass took a median of 5.7 min.
  - Dispatches per hour while the service was running: 7.45 (Brain) and 9.14 (BCH).
  - Dispatches per wall-clock hour of the window: 4.69 and 6.70, because the Brain service was stopped 22:11–22:26Z.
- **One stuck gate stalls the whole service.** At read time the BCH pass that started at 23:02:57Z (pid 26890) had been inside the R-3346 (ENG-1141) dispatch since 23:07Z. That dispatch's memory_worker gate was entered at 23:08:03Z and not granted, and nothing more was logged after 23:05:38Z.
  - Brain's pass that started at 23:09:08Z (pid 50410) logged nothing after 23:11:09Z and has no pass-complete.
  - R-872's worker exited at 23:11:59Z, but its report was still not ingested at read time.
  - The cause is UNKNOWN: process state is not observable from this sandbox.

### 5. Review as a pre-landing gate (BCH A), and reviews that never complete (Brain B)

- **BCH A.** There were 191 review-class runs against 266 engineer-class runs. Reviews used 55.9 run-hours, more than the 51.9 for engineer runs that finished done.
  - 28 of 38 review runs that could be matched to a landing gave their verdict before the reviewed commit reached main (median 6.8 min before). The review gated the landing.
  - Review runs took a median of 12.9 min from start to report (n=188).
- **Brain since B: no review.verdict events.**
  - The three settle review starts (R-786, R-857, R-858) each ended within 5.5–7.1 s with stage still "reviewing" and no verdict.
  - R-851, R-852 and R-853 each report that their single review was refused before reviewer launch by the w3PD workspace identity guard.
- **BCH B.** Six settle reviews finished, with 2 PASS and 4 NEEDS-WORK. Three could be matched to a landing; their landing-to-verdict times were 0.28 h, 2.98 h and 9.19 h (median 3.0 h; R-3312, R-3316, R-3322).
- **Line-service hold noise.** In the requested window the line service logged 141 BCH holds with "unknown task class: planning": the same 15 ARCH planning items were skipped on each of 9 of the 11 passes. It also logged 50 Brain holds with "T2 source completion needs supervisor judgment: reported source is not integrated".

## UNKNOWN or not measured

- **BCH dispatch overhead before window B: UNKNOWN.**
  - The legacy BCH dispatch path wrote no "Dispatch: prompt sent" note and no watcher `process_end`. Only 48 of 266 BCH engineer runs in A have a prompt marker, and all 48 are in B.
  - For the 351 legacy runs with a `dispatch_token`, the `dispatch-attempts/<token>/task-ready` file was written a median of 1.5 s after `run.started` (p90 2.1 s). When the worker was actually launched and prompted is not recorded.
  - BCH A worker time therefore uses `run.started -> report ingested`.
- **Landing for unattributed engineer runs: UNKNOWN.** That is 32 of 95 in Brain A, 3 of 22 in Brain B, 93 of 266 in BCH A and 21 of 50 in BCH B. Some never landed; for example, the line service marks R-786's (ENG-594) reported source "not integrated". Others named only lane heads that are no longer resolvable (missing objects). Landings were not matched by commit time alone, because concurrent lanes make that ambiguous.
- **Approval.** Supervisor or chat thinking time between a report and the next dispatch, and the time an item waited for operator approval, are not recorded as events. "Ready" is record-ready, not approved, so the idle-with-ready-work hours are an upper bound on avoidable idle time.
- **Proxy limits.** Worker activity for runs without a report or abandon event, other than the three currently running, is excluded. Supervisor or chat session work is not counted as an engineer working.
- **Review verdicts.** Verdicts for BCH review runs before 10-26 come from the REV run's report (`extra.verdict` or the outcome), since BCH has no review.verdict events. Landing-to-verdict could be matched only when the REV title or settle head named a commit that reached main: 38 of 191 BCH review runs, plus 19 Brain records (10 settle and 9 review.verdict, covering overlapping runs), all before B.
- **Evidence written elsewhere.** Files outside `.org/evidence` (Brain) and `bastian/archive` (BCH) are not counted, for example `.org/settle`, `.org/runs`, lane worktrees and BCH `.org/evidence`.
- **Evidence counts by mtime.** One directory can dominate a day: Brain `ENG-536` alone accounts for 17,091 of 17,547 files on 10-24.
- **Keyword clusters are noisy.** Two known misfiles: R-794 (test failures) is filed under guard/refusal, and R-3035 (a test failure that mentions a "denied" basename) under permission/sandbox. The signature table uses tighter patterns.
- **Line-service window.** The requested window covers only 1.5 h, of which the service was running 0.94 h (Brain) and 1.09 h (BCH), counted up to the last log line. Its pass and dispatch figures rest on 7 (Brain) and 10 (BCH) dispatch effects; the lifetime table has 10 and 11.
