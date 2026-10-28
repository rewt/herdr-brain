# Closeout measurement producer (R-1204)

This page preserves the original producer contract. The formal correction's
installed assets, declared window, allocation joins and v2 immutable audit
format are documented in [ENG-873](../ENG-873/README.md). The original review
FAIL and producer evidence are retained; use that correction with current code.

This slice implements read-only observation for the existing finite project line
service. It performs no cleanup, native retry, source migration, release,
watcher change, service restart or operator push.

## Integration contract

Import `recordCloseoutTurn` from `line-service/closeout-measurement.mjs` and call
`recordCloseoutTurn({project, org, env, now})` **after each finite turn, outside
record/native locks**, through the existing service's diagnostic error handler.
`project` contains canonical Git `identity` (common directory) and `canonical`
(checkout); `org` is the owning canonical record. `now` is optional and returns
UTC epoch milliseconds; `env` defaults to the actual service environment. The
return is `{file, cutoff, green, counts, failures}`. An I/O failure throws; it is
never cleanup authority or a reason to replay an effect.

ENG-855 exclusively owns the call site in `line-service/closeout-turn.mjs`.
The existing finite launchd wake (default 30 seconds) supplies the at-least-60s
observation schedule, including during slow general review. No second job,
background loop or saved runtime is installed. A gap exceeding 60 seconds resets
proof in the next retained observation. A stopped service cannot manufacture
observations; stale/missing samples remain a coverage gap. Project owners must
retain an interval <=60 seconds when installing/adopting the candidate.

The service's existing per-project directory receives:

- `closeout-measurements.jsonl`: append-only, fsynced complete census frames.
- `closeout-measurement.json`: latest display projection of the same frame.
- `passes.jsonl`: existing diagnostic path, aggregate counts and oldest exact
  exceptions, for supervisor/digest consumption. No message is pushed.

Frames retain loaded source commit/module hash, record first/cutoff sequence and
hash, native/Git/process coverage and raw inventory, all terminal-source cohort
members, actual effect receipts, origin slices, resource statuses, hold history,
separate clocks, explicit exclusions and historical memberships. Filesystem mtimes
never supply report availability. Only an original-watcher hash/start/claim-bound
`report.available` event can establish that clock. Earlier saved watchers without
that event retain UNKNOWN latency. Nothing restarts an age clock on eligibility,
source movement or later disposition. Hold intervals are retained, not subtracted.

`green` is the local metric oracle, **not release acceptance**. Unknown, missing,
old-runtime, unproven and kept results cannot count as green. Every terminal source
(report in every outcome, abandonment or nonzero original dispatch completion)
is counted, including a dispatch failure without a run. Failures are evidence;
this module does not authorize abandoning an unprompted allocation. Source-linked
resource receipts use ENG-855's `resources` event contract. Legacy/unstructured
outcomes remain unproven. First-turn accounting is immutable; later progress
cannot retroactively make the original first turn fully accounted.

The process census reuses the current-user cwd reader and native birth-identity
source. It never signals a process. Native inventory is global so a moved occupant
stays visible. Git inventory includes all linked lane worktrees, dirt and lane
refs; folder presence is observed separately from registered Git metadata. A
missing or disappeared target without exact automated proof is unexplained,
not an inferred hand-close or automatic success. Known structured manual actions
are counted separately. Any uncertain manual/automatic classification remains
non-green. Dirty retained folders and safety-held clean folders remain listed;
all clean retained folders count against the absolute zero gate.

## Scoped historical records

These are three independent archived inventory records, not one combined success
rate. Their source paths/hashes and cutoffs are retained, and their members stay
in absolute accounting alongside current work. They authorize no effect or
clearance; supervisor-herdr and the original producer retain their actual scope.

- `r1176.json`: record through 30764, observed 2026-10-28 19:24:45Z. The after
  snapshot has 26 clean finished folders and four finished native sessions older
  than two hours. The 26 folders contain 42 run references; those are different
  denominators. `remaining-original-identities.json` has only 25 rows; it does not
  replace the 26-folder census. Original missing identity, refusal, UNKNOWN,
  callback and blocked-occupant bytes are retained verbatim when available.
- `sol-research.json`: record through 30910, sequential native/folder observations
  around 19:40–19:42Z. Thirty explicitly named retained allocations. The separate
  75-target/61-empty/60-valid-bind aggregate is not its denominator. Unprompted
  R-1163 and unexplained disappearance R-1178 are explicitly separate observations.
- `claude-research.json`: independent 163-report aggregate since 00:14Z and named
  retained examples. Exact cutoff and full membership were not archived; they
  remain UNKNOWN. The 89 claimed manual removals are research classifications,
  not independently verified native receipts. `inventory_complete:false` prevents
  a green historical result. This preserves the research limitation without
  borrowing Sol's cutoff or silently discarding the cohort.

## Focused proof

Select only `node test/helpers/run.mjs test/closeout-measurement.test.mjs` through
`lane check --cmd` on the clean committed candidate. The controls start from
receipt-backed green fixtures, then inject manual close, missing inventory,
false refusal and cohort exclusion; each must independently prevent green.
Additional focused controls cover exact report-origin clocks, all final outcomes,
first-turn accounting, held absolute counts, source/cadence gaps, independent
collector failure and append-only service output/torn-tail preservation.

Actual live cadence and the integrated hook are unrun by this worker. Final
release coverage, real notice/safety receipts, busy-hour and sustained Brain/BCH
windows remain with ENG-856's canonical release coordinator. This producer does
not claim the permanent-closeout acceptance or relabel unrun checks PASS.
