---
run: R-122
outcome: done
summary: |
  Rebased the lane onto main and fixed both round-three findings. Settle reads
  NUL-delimited Git output as raw buffers without trimming, preserves whitespace
  and UTF-8 BOMs in filenames and driver names, and refuses bytes that cannot
  round-trip through UTF-8 before attribute lookup or lane replacement.
  Git 2.38/2.39 remain supported: historical attributes use an owned temporary
  index populated by read-tree and inspected by check-attr --cached, without
  check-attr --source. The real index and worktree stay intact during inspection.
  The fixes, regressions and report are committed; the final lane gate follows
  the report commit.
headline: Settle preserves exact Git paths and keeps clean rebases compatible with older Git
blockers: []
proposals: []
learnings:
  - Trimming an entire NUL-delimited path list can change its first filename, including leading spaces or UTF-8 BOMs, and bypass a path-specific custom merge driver guard.
  - Raw Git buffers can be converted to UTF-8 only after a byte-for-byte decode and re-encode comparison; Buffer conversion preserves valid BOM characters.
  - Historical attributes can be inspected through GIT_INDEX_FILE with read-tree and check-attr --cached on Git 2.38/2.39 without changing the real lane index or worktree.
  - Starting Node for every pass-through Git call in a fault adapter can exhaust a fixture subprocess bound; exec native Git directly and start Node only for intercepted commands.
artifacts:
  - "Commit: Retain published settle-rebase review for round three fixes"
  - "Commit: Preserve raw Git paths and inspect historical attributes on Git 2.38"
  - "Commit: Report settle rebase third-round fixes for run R-122"
  - "Branch: lane/settle-rebase"
  - "settle/settle.mjs; settle/README.md; settle/test/rebase-paths.test.mjs; settle/test/rebase-review.test.mjs"
  - "Before-fix mutation witnesses: both regressions failed as expected, proving content loss reached promotable for a leading-space filename and the older attribute interface rejected --source; /private/tmp/R-122-before-fix.log."
  - "Baseline npm test -- --suite-timeout=540000: 712 passed, 11 skipped, 1 failed out of 724; the existing native-lock test hit its 15-second subprocess bound again on an isolated unchanged-code rerun; /private/tmp/R-122-baseline.log and /private/tmp/R-122-baseline-lock-retest.log."
  - "Focused offline rebase tests: all 32 passed; /private/tmp/R-122-rebase-tests.log."
  - "Post-change npm test -- --suite-timeout=540000: 724 passed, 11 skipped, zero failures out of 735 tests; /private/tmp/R-122-post-tests.log."
  - "record check docs/reports/ENG-101-settle-rebase-r3-20261002.md"
  - "Final command: ORG_ACTOR=run-R-122 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check; /private/tmp/R-122-lane-check.log and .lane/gate.json bind validation to the final committed report."
decisions:
  - text: Read every NUL-delimited Git stream through a raw-buffer path, preserve complete fields, and refuse streams that cannot round-trip through UTF-8.
    category: design
    why: Changed filename spellings must never bypass the driver guard or lose conflict paths; raw bytes also preserve BOMs and merge.default driver names.
  - text: Keep the documented Git 2.38+ minimum and inspect historical attributes through an owned temporary index using read-tree and check-attr --cached.
    category: design
    why: The older supported interface supplies the required historical attributes without changing the real lane index, requiring an upgrade, or depending on --source.
  - text: Limit the native-lock fixture's Node adapter to the injected ref transaction and exec native Git for ordinary calls, preserving all existing bounds and assertions.
    category: tooling
    why: Direct native Git calls avoid repeated runtime startup and fit the existing subprocess deadline while retaining the lock and concurrent-update witnesses.
questions: []
challenges:
  - "Main advanced during baseline validation; the lane was rebased again before the implementation changes. The pre-existing published review was committed unchanged; the private findings file was not copied into the repository."
  - "Native Git 2.38/2.39 binaries were not installed. Compatibility regressions use real installed Git with adapters that reject check-attr --source and enforce owned temporary indices, unchanged real-index bytes and scratch cleanup. These are capability regressions, not claims of execution on native older binaries."
  - "The baseline lock test exhausted its 15-second subprocess bound in both the full suite and an isolated unchanged-code rerun. Its adapter now directly executes pass-through Git calls; the original lock assertions and test/subprocess deadlines remain in place, and the focused rerun passed."
---

The new regressions witness a successful content-discarding driver for filenames
beginning with a space, tabs/newlines and a UTF-8 BOM, then require refusal before
scratch replay and verify that the reviewed content and lane remain intact. A
valid whitespace/Unicode filename still reaches promotable, and an intermediate
replay conflict retains its exact whitespace filename. An injected non-UTF-8 raw
path must receive a clear refusal before attribute lookup or replacement.

Both older attribute-capability fixtures cover clean rebasing to promotable and
refusal for a custom driver present only in an intermediate commit. They verify
historical inspection leaves the real lane index byte-for-byte unchanged and
removes its temporary index after success or refusal. An additional regression
covers a whitespace-prefixed merge.default driver name. Existing regressions
retain directory conflict paths, preservation proofs, branch/index/HEAD locking,
concurrent commits and switches, lost-response recovery and validation after
rebasing. Every fixture sets its own actor and uses bounded offline transport.

No push, promotion, shared configuration, releases, live panes, project-wide
housekeeping schedule or contrib watcher was changed. Earlier reports were not
altered.
