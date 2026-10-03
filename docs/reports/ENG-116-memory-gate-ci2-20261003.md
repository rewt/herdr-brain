---
run: R-177
outcome: done
summary: |
  Reverted the rejected plugin-install test change and restored implicit review
  route resolution to the original dispatch boundary, preserving main's route
  discovery and portable preset fallback. Explicit route selections still fail
  before memory waiting; memory waits, --memory-checked and canonical STOP
  receipts remain intact. The unmodified plugin-install file passed 39/39 and
  memory-boundary regressions passed 13/13. The final lane check follows the
  checked report commit.
headline: Default review routing again follows the original dispatch path
blockers: []
proposals: []
learnings:
  - "Unconfigured projects receive the portable route preset; direct and --memory-checked reviews both launch the preset review kind, model and effort."
  - "The original relocated-runtime test checks template installation before dispatch; its explicit empty route table does not prove a successful preset launch."
  - "Keep the review memory and STOP gate before private-output validation so a waiting launch can return its stopped receipt."
artifacts:
  - "Commit 02825dd: Restore default review route resolution at dispatch"
  - "Branch lane/memory-gate"
  - "lanes/lane.mjs"
  - "test/plugin-install.test.mjs: byte-for-byte restored to main 61be51b"
  - "settle/test/memory-boundaries.test.mjs: two successful zero-config preset review regressions"
  - "node test/helpers/run.mjs test/plugin-install.test.mjs settle/test/memory-boundaries.test.mjs: 52 passed, 0 failed, 0 skipped"
  - "/private/tmp/R-177-targeted.log"
  - "/private/tmp/R-177-main-comparison.log"
  - "docs/reports/ENG-116-memory-gate-ci2-20261003.md"
  - "Final check after report commit: node lanes/lane.mjs check (fast tier; npm run test:fast)"
  - "/private/tmp/R-177-lane-check.log"
decisions: []
questions: []
challenges:
  - "Source comparison with 61be51b distinguishes missing configuration from an explicit empty route table: main supplies the preset for the former, while the relocated-runtime fixture uses the latter and reads the template before its route refusal. Both original behaviors are preserved."
---

The rejected test edit from R-176 is completely reverted. Implicit default
review routes now resolve through `dispatch()` after the original review
setup and bundled template read. Explicit `--route` and `--route-config`
selections retain preflight validation before waiting on memory. The memory
gate remains at its existing early boundary, with the same canonical STOP
check, stopped receipt, review exit code 3, and coordinated `--memory-checked`
behavior. The review deadline still starts after memory waiting.

The read-only comparison against main `61be51b51911b1b713434071d5989585c40b5ecc`
confirmed byte equality for the entire plugin-install test, `lanes/routes.mjs`
and `lanes/preset.mjs`. Configuration discovery and merging, preset fallback,
`resolveDispatch()`, review option parsing and the review dispatch call also
match main. No main or baseline test execution was needed.

The bounded offline runner passed all 52 tests in 61.80 seconds: the original
39 plugin-install cases, including the relocated runtime's bundled template
test, and all 13 memory-boundary cases. Two added cases launch a successful
review in a project with no route configuration, directly and with
`--memory-checked`, and assert the preset kind, model and effort passed to the
scripted Herdr transport. Existing cases verify visible memory waits,
canonical STOP from a linked checkout, stopped parent-stage recovery,
coordinated pressure without a second wait, and invalid explicit routes
failing before memory waiting. All model execution is scripted and offline.

The sandbox initially denied the runner's `ps` ownership lookup before any
tests started. The authorized run retained process ownership and cleanup
checks. An initial implementation moved the memory gate too late; the
boundary tests caught this and the final change keeps its original placement.
No baseline, full suite, model call, live acceptance harness, review session,
promotion or push was run. After this report is checked and committed, the
last operation is the requested lane check using the configured fast tier;
its result is retained in the lane gate and the log listed above.
