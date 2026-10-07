---
run: R-293
outcome: done
summary: |
  Fixed all four required review findings: settle executes the planner and its imports from a private snapshot of the captured canonical base, receipt keys are recomputed from their validation inputs, planner failures retain their error and cover nothing while permitting recorded re-execution, and the supervisor instructions give the exact LANE_VALIDATE command and post-review HEAD requirement.
  The required offline files passed: affected-tests 3/3, train 31/31, test-evidence 10/10 and autopilot 87/87; the additional real canonical-planner test passed 1/1. Implementation and evidence are committed as 02ba085. This checked report is committed next, followed by the final lane fast check.
headline: Settle now binds test evidence to canonical planners and verified receipt keys
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 02ba085"
  - "Branch: lane/bound-escalations"
  - "docs/evidence/ENG-235/R-293/README.md"
  - "docs/evidence/ENG-235/R-293/focused.log"
  - "docs/evidence/ENG-235/R-293/evidence-retry.log"
  - "docs/evidence/ENG-235/R-293/canonical-plan.log"
  - "docs/reports/ENG-235-canonical-planner-R-293.md"
  - "/Users/rewt/development/rewt/.org/runs/R-293/report.md"
decisions: []
questions: []
challenges: []
---

All four Minors from the independent review of R-287 are addressed.

Settle materializes regular tracked blobs from `job.mainHead` into a private
temporary directory and executes the declared planner there with cwd set to the
lane workspace. Its relative imports therefore use the captured base, while
the static graph examines the lane. Symlinks and submodules are omitted; the
snapshot is bounded to 10,000 paths and 64 MiB of blob output, with bounded Git
commands and the existing 20-second planner deadline. The private snapshot is
removed on success and failure. The promotion train retains its existing
candidate planner execution behavior.

A missing, failed, invalid, oversized or timed-out plan covers nothing. Settle
saves `testEvidence.planner_error`, still consults recorded full-file evidence,
and returns the existing test-only escalation when no qualifying receipt exists.
Recorded re-execution can discharge that escalation without repeating review.

Receipt validation now derives the key exactly as lane validation does:
SHA-256 of JSON containing `schema`, `tree`, `command`, and `fingerprint` from
`environment_fingerprint`, in that order. It refuses a mismatched key even when
the filename and log hash agree. Existing exact-head/tree, decision-note,
full-file-command, green-result and log-integrity checks remain in force.

The supervisor documentation gives
`LANE_VALIDATE='node --test FILE...' node lanes/lane.mjs check --tier fast`
from the clean lane workspace, names the supported full-file runner alternative,
and requires the receipt to match current lane HEAD after the review commit.

Validation evidence:

| File | Pass | Fail |
| --- | ---: | ---: |
| `promote/test/affected-tests.test.mjs` | 3 | 0 |
| `promote/test/train.test.mjs` | 31 | 0 |
| `settle/test/test-evidence.test.mjs` | 10 | 0 |
| `supervisor/test/autopilot.test.mjs` | 87 | 0 |
| `settle/test/test-plan.test.mjs` | 1 | 0 |

The final green checks cover 132 distinct tests. The first four-file run produced
124 pass and seven failures because my new evidence fixture used `git add .`
and accidentally tracked its scratch record, making later record writes dirty
the canonical fixture. I restricted setup to the planner, its import and the
declaration, then reran the full evidence file: 10 pass, zero fail. The other
three required files passed in full on the initial run. The separate real
planner test also passed. Logs preserve both the initial failure and the clean
rerun; trailing whitespace is normalized.

New regressions cover lane-modified planner entry points and imports that shrink
or invent coverage; missing, failed, invalid and oversized plans plus recovery
through recorded re-execution; and a hand-written receipt with a self-consistent
filename/log hash but an incorrect key. The real project planner regression
exercises its transitive imports from the captured snapshot and its selection
of lane tests. Syntax checks and the staged diff whitespace check passed.

After checking and committing this report, the final operation is
`node lanes/lane.mjs check --tier fast`. Its authoritative exact-HEAD receipt is
the ignored `.lane/gate.json`.
