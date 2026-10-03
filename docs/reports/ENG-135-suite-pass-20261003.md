---
run: R-170
outcome: done
summary: |
  Measured the fast tier and every promotion step under the host test slot, retained per-file behavior and fixture inventories, and reduced repeated Git initialization and PTY compilation. Promotion measured 742.761 seconds and 72,385 observed launches versus 879.894 seconds and 75,280 before. Deliberate long-response and copied-product checks remain in an enforced offline release tier. Valid tier measurements and affected final checks passed; acceptance source and the live harness were untouched.
headline: The suite costs less while retaining its native safety coverage
blockers: []
proposals: []
learnings:
  - "A copied immutable Git seed must never send shared setup operations through a fixture-owned injected command hook. Such hooks require independent setup inside their own scratch root."
  - "Observed process-launch counts independently show reduced setup work; varied machine load prevents attributing every wall-time difference to code."
  - "The native PTY executable can be cached by source bytes while each invocation retains fresh session ownership and descendant cleanup."
artifacts:
  - "Implementation and retained evidence commits 1db6143 and b454abc on lane/suite-pass."
  - "docs/reference/test-tiers.md"
  - "docs/reports/ENG-135-suite-pass-evidence-20261003/inventory.md"
  - "docs/reports/ENG-135-suite-pass-evidence-20261003/measurements.json"
  - "docs/reports/ENG-135-suite-pass-evidence-20261003/final-focused.log.gz"
decisions: []
questions: []
challenges:
  - "The host slot serializes cooperating test suites but did not make the entire machine quiet. Load samples and instrumentation limits are retained with the evidence."
  - "Excluded attempts include sandbox-denied native evidence, one invalid baseline acceptance run, and the first after acceptance run that exposed a shared-seed hook regression. The affected acceptance step was corrected and remeasured; all excluded traces remain available."
  - "Final helper response-allowance changes were checked through their affected files, not another full chain. Promotion marker waits were finally restored to the original 30-second base and syntax checked."
  - "Optional dependency/provider prerequisites remain explicit skips. Frozen external-project test inventory is named but not represented as current executed coverage."
---

Promotion wall time fell **15.6%**, and observed process launches fell **3.85%**. The fast tier fell from 9.539 seconds / 1,186 launches to 1.096 seconds / 91 launches. The new offline release tier retains seven deliberately expensive integration/deadline cases; even including it, measured promotion-plus-release cost is 836.132 seconds / 73,889 launches, below the original 879.894 seconds / 75,280 launches. This comparison excludes the unmeasured live acceptance gate and does not imply a controlled wall-time benchmark.

| Tier | Before seconds | After seconds | Before launches | After launches | After passes / skips |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fast | 9.539 | 1.096 | 1,186 | 91 | 177 / 0 |
| Native host slot | 6.665 | 6.590 | 369 | 369 | 48 / 0 |
| Core/modules | 206.223 | 135.852 | 21,752 | 20,397 | 701 / 11 |
| Cycle | 227.402 | 200.960 | 35,802 | 34,949 | 155 / 0 |
| Lanes | 364.580 | 342.429 | 13,130 | 12,444 | 166 / 0 |
| Offline acceptance | 75.024 | 56.930 | 4,227 | 4,226 | 138 / 0 |
| Promotion total | 879.894 | 742.761 | 75,280 | 72,385 | 1208 / 11 |
| Offline release | Previously in promotion | 93.371 | Previously in promotion | 1,504 | 7 / 0 |

Fast overlaps promotion and is not added to its total. Promotion includes 1,208 passes and 11 explicit skips; release adds seven passes. Nine new behavioral checks replace three assertion-free support entries, giving six more passing entries overall. Initial Git creation boundaries fell from 757 to 402 in promotion (413 including release); observed PTY compiler calls fell from 39 to 20. Fresh Git worktree additions remain 597 across promotion plus release, exactly the original count. PTY invocations increase from 35 to 40 because the cache regression adds real TTY/status checks. Live Herdr mutations and model calls remain zero.

The implementation retains the native process, Git, PTY, record and no-focus boundaries. The complete per-file coverage and cost inventory is in [inventory.md](ENG-135-suite-pass-evidence-20261003/inventory.md); machine-readable tier/file launch counts, response-load samples and TAP summaries are in [measurements.json](ENG-135-suite-pass-evidence-20261003/measurements.json). Compressed raw traces/logs, the instrumentation and the summarizer are retained alongside them.

The promotion measurement is the sum of its existing slot/core/cycle/lanes/offline-acceptance steps, run serially under one real host slot. Fast is a separately measured subset. Release here means the new offline release tier; the live harness was never run. Every valid tier returned zero. The host slot prevents another cooperating suite from running concurrently, but does not stop unrelated host work: the before load samples ranged roughly 2.2–8.7 and the after samples are retained rather than treated as a controlled benchmark. Launch counts are observed Node child-process calls, including instrumented descendants, not a full kernel process census. Native compiler/shell grandchildren and children explicitly discarding NODE_OPTIONS are outside that census; their parent boundary launch remains counted.

File selection now names only actual .test.mjs entries and checks the partition. Three old empty TAP entries were removed from execution: test/helpers.mjs is imported support; test/fixtures/state-v0.mjs is the frozen compatibility fold; console/test/fixtures/board.mjs is imported board data. Their consumers and assertions remain. No behavioral assertion was deleted as a duplicate: superficially overlapping process/identity tests exercise different refusal, cancellation or ownership boundaries.

Every change of tier is deliberate:

- lanes/test/validation.test.mjs remains in promotion and leaves fast. Its real Git worktree/check/slot serialization fixtures accounted for most fast-tier launches and elapsed time.
- test/processes.test.mjs, console/test/terminal.test.mjs and test/tier-plan.test.mjs join fast while staying in promotion. They protect fresh signal authorization, terminal decoding and file coverage without a PTY or substantial fixture cost.
- discovery/test/acceptance.test.mjs moves from core to release. Its two copied Codex/Claude workflows retain real CLI, guard, Git worktree, validation and promotion checks; they are distribution/candidate integration checks, with module coverage still in promotion.
- The load-deadline case “promotion validation can read Git after the old injected 15-second command deadline” moves from test/load-deadlines.test.mjs to release file test/deadline-boundaries.test.mjs. Its real 15.2-second response is retained; promotion retains single-scaling and refused/exhausted ownership assertions.
- The hang case “a nested bounded suite may exceed one command deadline while ordinary commands retain their bound” moves from test/test-hangs.test.mjs into that same release file. Its 15.5-second nested suite and ordinary-command refusal are retained; watchdog, cancellation and descendant cleanup stay in promotion.
- The three start/prepare/commit delayed-success cases move from settle/test/ref-deadlines.test.mjs to release file settle/test/ref-wallclock.test.mjs. Every 15.2-second acknowledgement, clean checkout, exact lane ref, unchanged main, owned-lock release and no-replay assertion remains. Promotion retains real exhausted/refused/CAS transactions and foreign-lock preservation, with explicit once-scaled allowance assertions.

The offline release command holds the host slot. The prepared-candidate wrapper now runs those release files before acceptance and refuses to start acceptance on their failure. A regression proves failure blocks the acceptance marker and success executes the offline checks once. Neither acceptance source nor its timeout policy changed.

Repeated setup is shared only as immutable bytes. Ordinary lane and settle fixtures copy complete seeded Git trees, with independent common directories, indexes, objects and refs. All subsequent native Git and worktree operations remain. A new regression mutates one copy and proves other copies and later copies are unaffected. PTY executable compilation is cached by actual source hash within owned suite scratch; native sessions, command deadlines, descendant audits and cleanup remain fresh on every invocation. A new native test proves one compilation for unchanged bytes and separate builds for fault variants and changed source.

File readiness/queue/inbox/shutdown waits now subscribe before checking evidence, follow newly created parent directories and close on success/error/abort/finite timeout. Native process absence still uses fresh OS evidence, with load-aware finite response allowances; a notification cannot prove a process died. Protocol reconnect waits use actual events, and the permanent-close negative observation advances the virtual timer instead of sleeping. Negative observation windows, caller policy/cancellation budgets, deliberate wall-clock delays and native ownership limits retain their meaning. Blocked JavaScript event-loop fixtures now use indefinite Atomics.wait rather than spinning a CPU core; the real independent watchdogs and signal paths still terminate them.

Historical flake evidence was collected from the record and today's logs. ENG-123 identifies a marker read that turned incomplete PID bytes into zero; promotion/test-slot fixtures publish by atomic rename, and promotion readers require complete positive digits. The R-156 candidate test log shows Unexpected end of JSON input while reading a concurrent event log; that fixture now uses the existing complete-event loader rather than split/JSON.parse of a partial tail. ENG-112/ENG-117 inbox teardown and ENG-113 PTY/lookup leaks were previously fixed; their refusal and ownership checks remain and pass here. The old lane-file watchdog timeout and copied-product packaging failures are retained in flake-log-excerpts.json; neither recurred in valid measurements. ENG-103/ENG-120 acceptance load/focus policy remains with ENG-134. A single green run is evidence that these cases passed, not a proof that every historical intermittent failure is eliminated.

The optional MCP suite is reachable through test/mcp.test.mjs and reports its dependency skip on this checkout. Provider/kernel/console prerequisites likewise remain explicit. The two test files under kit/bch-cloak-20261001 are frozen external-project inventory with that project's layout/build assumptions, not scheduled current tests; the inventory names their behavior and marks them unmeasured. They remain unchanged because cutover compatibility consumes the historical bytes.

The first measurement attempt failed in the sandbox because native ps was denied. Native execution supplied the valid ownership measurements. A separate first acceptance attempt was invalidated by my shared-fixture edit during the measurement chain; I restored the original fixture and reran only that tier under the slot. Both excluded attempts remain in the evidence directory. One after-slot request exited 75 without starting tests; the subsequent request waited for the existing promotion holder and then measured. No other holder was disturbed and no hidden full-suite retry was used.

The first after acceptance measurement exposed my shared-seed regression: a supplied command hook observed seed operations outside its owned fixture root, so the cleanup assertion correctly failed. The fix preserves independent initialization for supplied hooks and shares the seed only for ordinary native fixtures. The affected acceptance step was remeasured; its original red trace remains under failed-after-acceptance/. Final focused verification covers the remaining detached/worker response-allowance changes and the fixture hook correction. Core/cycle/lane/release timing rows describe the initial after chain; those final helper deadline changes were checked in their affected files rather than repeating the entire batch.

New file-wait, repository-independence, PTY-cache and tier-partition regressions were written before their helpers; the retained new-regressions-before log shows the missing-helper failures. Focused file-wait verification passed 5/5 and tier selection 1/1. The final native fixture check passed 59 tests with one explicit Linux-only skip in 57.714 seconds, including copied Codex/Claude workflows, detached cleanup, teardown and blocked-loop watchdogs. Syntax checks passed for changed JavaScript and the final diff passed git diff --check.

Implementation and evidence were self-reviewed and committed as 1db6143 and b454abc before this report revision was written. The watcher event-wait changes were verified in the measured core tier but omitted from the initial staging list; b454abc includes those unchanged tested bytes. This report is checked with the canonical record CLI and committed next. The final action is ORG_ACTOR=R-170 node lanes/lane.mjs check; its .lane/gate.json receipt binds the check to the final report commit. The run stops after that check, as requested.
