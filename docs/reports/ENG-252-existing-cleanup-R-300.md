---
run: R-300
outcome: done
summary: |
  Rebased the six existing-cleanup lane commits onto current main, preserving record worker, record digest, and newest-run outcome ownership including reopen handling. The only conflict was CLI command registration; range-diff confirms no other lane patch changes. All six requested offline files passed 87/87 under host execution with scratch in /private/tmp. Rebase evidence is committed; this checked report is committed next, followed by lane check as the final command.
headline: The cleanup lane is rebased and all requested checks pass
blockers: []
proposals: []
learnings: []
artifacts:
  - a4e408e9de2b00a400aac4e27e204cf6fbc20c0a
  - 03b8c8b8dd699ad6f433c1e626cc625bca048354
  - docs/reports/ENG-252-existing-cleanup-R-300.md
  - docs/reports/evidence/R-300/README.md
  - docs/reports/evidence/R-300/rebase-range-diff.txt
  - docs/reports/evidence/R-300/targeted-host.tap
  - docs/reports/evidence/R-300/targeted-private-tmp.tap
  - docs/reports/evidence/R-300/targeted.tap
decisions: []
questions: []
challenges: []
---

Rebased `lane/existing-cleanup` from `40703146` onto main at
`47989b788eadf2185d60773a522907563e445ac2`. All six commits replayed successfully.
The single conflict in `bin/org.mjs` registered both `worker` and `digest`.
Main's outcome ordering and reopen changes remain intact; `lib/state.mjs`,
`lib/digest.mjs`, `test/flow.test.mjs` and `test/digest.test.mjs` match main.
The committed range-diff shows only the command-registration context change;
the other five replayed commits have identical patches. No additional product
or test changes were made.

Requested verification, Node v20.19.4:

| File | Passed | Failed |
| --- | ---: | ---: |
| dispatch/test/record-worker.test.mjs | 6 | 0 |
| acceptance/test/cutover-housekeeping.test.mjs | 1 | 0 |
| acceptance/test/cutover.test.mjs | 14 | 0 |
| test/digest.test.mjs | 8 | 0 |
| test/flow.test.mjs | 17 | 0 |
| test/cli-help.test.mjs | 41 | 0 |
| Total | 87 | 0 |

The bounded offline runner exited 0 with no skips, cancellations, surviving
fixtures or cleanup diagnostic. `git diff --check` passed. The evidence README
records the exact command and all invocation logs.

Two preliminary executions were limited by this worker environment. The first
passed 85/87: cutover copy audits rejected the home prefix inside the inherited
scratch temp path. With `TMPDIR=/private/tmp`, 86/87 passed; nested macOS sandbox
application and the runner's process snapshot were denied by the outer worker
sandbox. Approved host execution of the same six files with that TMPDIR passed
87/87 and completed fixture auditing. No safety audit was relaxed.

No live acceptance harness, model call, project housekeeping loop, or live tab
mutation was run. Rebase and evidence are committed in `a4e408e9`. This report
is copied to the required R-300 record path, checked with `record check`, and
committed in the lane. The final command is `node lanes/lane.mjs check`; its gate
will identify the final clean report commit. Nothing is pushed or promoted.
