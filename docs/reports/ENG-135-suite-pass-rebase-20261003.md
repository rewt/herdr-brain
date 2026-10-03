---
run: R-184
outcome: done
summary: |
  Rebased the accepted suite improvements onto main, resolving the two conflicts by preserving the non-setuid process identity source and the suite's load-aware, CPU-idle fixtures. Focused tests passed with 102 passes, one Linux-only skip and no failures. Main advanced during the host-slot wait; a second clean rebase reached its new tip with the conflicted files and consumer tests unchanged. Rebase and verification evidence is committed; the final lane check follows this checked report commit.
headline: The accepted suite improvements now preserve the new process identity source on main
blockers: []
proposals: []
learnings:
  - "The detached-descendant helper needs both lookupProcess from the shared process helper and loadTimeout; blocked fixtures retain Atomics.wait rather than CPU-spinning loops."
  - "The slot regressions now inject failures into the non-setuid process source, so their source diagnostics must survive alongside load-aware response allowances."
artifacts:
  - "Base main: 6e7905e83927a521d60f2e91bcb9e96c84cd83e2."
  - "Rebased implementation: 2c6d736; later accepted commits: 0853fe8, c70e17a, 86bde44, 2123353."
  - "Verification evidence commit: 1805abf6e3fef04bc568bdaa2fb88d403109d04e."
  - "docs/reports/ENG-135-suite-pass-rebase-evidence-20261003/README.md"
  - "docs/reports/ENG-135-suite-pass-rebase-evidence-20261003/focused.log"
  - "docs/reports/ENG-135-suite-pass-rebase-evidence-20261003/range-diff.txt"
  - "docs/reports/ENG-135-suite-pass-rebase-evidence-20261003/resolved-diff.patch"
decisions: []
questions: []
challenges:
  - "The first host-slot request exited 75 after 600 seconds without starting tests. The second queued the same focused command and completed successfully; the refusal log is retained."
---

This was a rebase-only round of the previously accepted R-170 work. The first rebase onto `62b4f69` conflicted only in `discovery/test/helpers/detached-descendants.mjs` and `test-slot/test/test-slot.test.mjs`. The resolutions retain ENG-122's kernel-backed `lookupProcess`, source-failure injection and refusal diagnostics together with the accepted load-aware allowances, atomic PID receipts and `Atomics.wait` blocked-loop fixtures. No behavior assertions were removed and no new implementation work was added.

Focused verification held the host test slot and ran only the slot test file and every test file consuming the conflicted detached-descendant helper:

```sh
node test-slot/test-slot.mjs run ENG-135-rebase-focused --wait 1200 -- node --test --test-concurrency=1 test-slot/test/test-slot.test.mjs discovery/test/review-r3.test.mjs discovery/test/owner.test.mjs test/test-hangs.test.mjs
```

The run exited 0: **102 passed, one Linux-only skip, zero failures/cancellations**, in **92.185 seconds** of test time. Both conflicted files also passed syntax checks and their scoped diff passed whitespace checks. The existing accepted files' two blank lines at EOF reported by the whole-lane diff check were left unchanged in this rebase-only round. No full tier or live acceptance harness was run for focused verification.

Main advanced while this command queued. The subsequent rebase onto `6e7905e83927a521d60f2e91bcb9e96c84cd83e2` completed without conflicts. SHA-256 checks confirm that both conflicted files and the three consumer test files match the passing focused run exactly. The retained range comparison shows all five original commits remain in order; only the implementation commit changes relative to its original patch because it preserves main's process identity changes.

Git operations used `core.hooksPath=/dev/null`; no hook-trust dialog appeared and no hooks were trusted. Evidence was committed before this report. The requested final `node lanes/lane.mjs check` is deliberately run after the report is checked and committed, so its exact final-head receipt is kept in `.lane/gate.json` rather than claimed in advance here.
