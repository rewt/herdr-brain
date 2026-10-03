---
run: R-159
outcome: done
summary: |
  Resolved all three findings from the latest memory-gate review. Dispatch and settle now own the coordinated memory waits; child lane commands check canonical STOP without a second hidden wait and return stopped receipts that restore ordinary retry stages. Settle correction dispatch and retry show memory wait reasons on settle's own stderr. The promotion README now describes the single wait before locking and validation.
  Offline validation passed before and after the changes, including the new launch-boundary and visible correction regressions. The implementation and this checked report are committed; the final lane check follows the report commit and records its result in the lane receipt.
headline: Memory waits remain visible and supervisor stops preserve safe retries
blockers: []
proposals: []
learnings:
  - "Coordinated lane dispatch and lane review receive --memory-checked. Parents own the wait before recording a launch attempt; children still check canonical supervisor STOP before launching."
  - "A stopped child dispatch restores its parent journal to worker; a stopped child review restores review without consuming another review round. Both resume with ordinary --retry."
  - "Settle captures correction dispatch stdout for its receipt and inherits stderr for live memory wait reasons on both new dispatch and recovery."
artifacts:
  - "Implementation commit b858483: Keep coordinated memory waits visible and resumable"
  - "Branch lane/memory-gate"
  - "docs/reference/memory-gate.md"
  - "promote/README.md"
  - "settle/test/memory-boundaries.test.mjs"
  - "docs/reports/ENG-116-memory-gate-launch-fixes-20261003.md"
  - "npm test before edits: passed"
  - "npm run test:fast: 140 passed; /tmp/R-159-fast.log"
  - "Launch-boundary regressions: 6 passed; /tmp/R-159-boundary-retry.log"
  - "npm test after edits: 871 passed, 11 skipped, zero failures; /tmp/R-159-after.log"
  - "npm run test:lanes: 161 passed, zero failures; /tmp/R-159-lanes.log"
  - "Final command after this report's check and commit: node lanes/lane.mjs check; receipt .lane/gate.json"
decisions:
  - text: Let parent coordinators own memory waits and retain canonical STOP checks in the child lane commands.
    category: tooling
    why: A second hidden wait after saving a launch attempt can defer work invisibly and strand safe retries. Explicit stopped receipts establish that no worker started and restore the previous resumable stage.
questions: []
challenges:
  - "The first focused runner attempt could not inspect its fixture process identity because the sandbox denied ps. The offline runner was retried with the required process inspection permission."
  - "Initial dispatch boundary regressions exposed a missing Git ignore in the scratch fixture. The fixture now ignores its session registry; all six boundary regressions passed on retry."
---

The latest review's three findings are addressed:

- Dispatch and settle supply `--memory-checked` to their real lane commands, removing the second memory wait after entering `launching` or `reviewing`. Tests inject pressure only when the child is invoked, after the parent's healthy sample. Pressure alone proceeds without a hidden wait. With canonical STOP also present, neither worker nor reviewer starts; journals return to `worker` or `review`, their locks release, and ordinary retry launches exactly once with the same run or review round. Direct lane dispatch and review retain their own visible waits and honor canonical STOP while invoked from linked worktrees.
- Settle inherits correction dispatch stderr while retaining stdout for JSON receipts. Its correction regression observes the initial pressure reason on settle's own stderr, places STOP, confirms a resumable handoff without a correction worker, and observes another visible wait and clearing message during retry. Exactly one correction run and worker are created.
- The promotion README now matches the implementation and reference: wait once before acquiring the promotion lock and starting validation, then finish fast-forward without another memory wait.

The complete after-change log supplies validation evidence beyond the truncated inherited log. All tests are offline: memory readings are simulated, Herdr transport is scripted, and no model calls or live acceptance harness were used. The host test slot remains outside this change. The previous reports are unchanged.

The final lane check follows this report's check and commit. Its result is retained in the lane receipt rather than claimed before execution.
