---
run: R-195
outcome: done
summary: |
  Rebased the accepted suite changes onto current main, preserving both sides' tests and behavior through the settle fixture, console housekeeping and promote conflicts. Main advanced three times during host-slot waits; the final rebase onto 8d633c2 was clean. Targeted checks passed, with one earlier teardown failure retained alongside its passing recheck and the subsequent passing run with main's existing inbox cleanup. Evidence is committed; the final lane check follows this checked report commit.
headline: The accepted suite changes now rebase cleanly onto current main
blockers: []
proposals: []
learnings:
  - "The promote fixture must retain main's actual-inbox cleanup and producer-exit assertions alongside the accepted event waits and load-aware deadlines. Explicit record notices use a different inbox from the default Git inbox."
  - "The settle fixture needs both loadTimeout and repositorySeed; main already includes the accepted load-aware watcher cleanup."
artifacts:
  - "Final base main: 8d633c28067ec6ee9ef38eed7920dd2bbe94a9f0."
  - "Rebased accepted implementation: 512fcd6; accepted head before evidence: 9f88e4e59ce57af288f27c195e55718c7f8f2512."
  - "Evidence commit: a08b093."
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/README.md"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/commands.txt"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/latest-range-diff.txt"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/focused.log"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/final-conflicts.log"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/promote-recheck.log"
  - "docs/reports/ENG-135-suite-pass-rebase2-evidence-20261003/fleet-conflict.log"
decisions: []
questions: []
challenges:
  - "Main advanced during serialized verification, requiring rebases onto train recovery, fleet and auto-tidy changes after the initial target. All seven accepted lane commits remain in order."
  - "The pre-fleet promote run had one ENOTEMPTY after-hook failure; its behavior assertions passed. The unchanged file passed all 24 tests on recheck. Main subsequently supplied actual-record inbox cleanup and producer-exit assertions, which were preserved and passed all 24 tests in the combined file."
---

This was a rebase-only round. No new implementation, tests or behavior were added beyond combining the accepted lane changes with main.

The initial rebase onto `2b073a0` conflicted only in `settle/test/fixture.mjs`; the promote file merged automatically and matched the accepted version byte for byte. The resolution retained both fixture imports and the immutable Git seed, injected-command setup boundary, load-aware deadlines and owned watcher cleanup.

Main advanced while the focused command waited for the host slot. Rebasing onto `a19de1e` conflicted in console housekeeping and promote. The console resolution retains `ownerIdentity` and its identity assertions with `loadTimeout`. The promote resolution retains successful and failed velocity-note cases, expected-head/current-run binding, warning and cleanup assertions, and the accepted event wait.

The next rebase onto `bf89a5b` resolved only promote imports. Main's `inboxPath`, `stopFixtureInbox`, process lookup, actual-destination cleanup and producer-exit assertions remain alongside the accepted event waits, atomic PID receipts and load-aware deadlines. The final rebase onto `8d633c2` was clean. Blob checks confirm all three resolved files remain byte-identical to their retained verification versions after that rebase.

| Focused verification | Result | Test time |
| --- | --- | --- |
| Initial promote file and 14 settle-fixture consumers | 137 passed; zero failures or skips | 226.332 s across two phases |
| Console housekeeping and promote after train recovery rebase | 32 passed; one teardown failure | 44.445 s |
| Unchanged promote recheck | 24 passed; zero failures or skips | 44.408 s |
| Promote with main's fleet inbox cleanup retained | 24 passed; zero failures or skips | 44.322 s |

Every heavy focused command held the host test slot and used the bounded offline runner. The failure log and remaining-path observation are retained; the passing recheck does not erase that failure. No full tier, baseline, live acceptance harness, promotion or push was run. Syntax checks and scoped whitespace checks passed for all resolved files. The range comparison retains the seven original accepted commits, with only the implementation patch adjusted to preserve main's changes.

Evidence was committed before this report. The requested `node lanes/lane.mjs check` runs last, after report validation and commit; its final-head receipt is recorded in `.lane/gate.json` rather than claimed in advance here.
