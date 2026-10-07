---
run: R-301
outcome: done
summary: |
  The merge train now reuses settle's canonical planner materialization at the captured batch base commit, including transitive imports, while inspecting the candidate tree. The strict bound required-test coverage check remains intact.
  Two offline regressions prove a lane-modified planner cannot suppress selected bound tests or invent coverage. All 51 requested tests passed after rerunning the affected-tests file with host permissions following a sandbox process-snapshot denial. Implementation and evidence are committed as 4aece6e; this checked report is committed next, followed by the final lane fast check.
headline: The merge queue now computes bound test coverage with the canonical planner
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 4aece6e"
  - "Branch: lane/train-planner"
  - "docs/evidence/ENG-257/R-301/README.md"
  - "docs/evidence/ENG-257/R-301/regressions-red.log"
  - "docs/evidence/ENG-257/R-301/focused.log"
  - "docs/evidence/ENG-257/R-301/affected-tests-retry.log"
  - "docs/reports/ENG-257-train-canonical-planner-R-301.md"
  - "/Users/rewt/development/rewt/.org/runs/R-301/report.md"
  - ".lane/gate.json (final lane fast-check receipt)"
decisions: []
questions: []
challenges: []
---

`promote/train.mjs` calls `canonicalTestPlan` from `settle/test-plan.mjs` with
`repo: canonical`, `base: attempt.base`, and `cwd: attempt.scratch`. This reuses
the existing regular-blob snapshot, transitive base imports, realpath temporary
root, and cleanup. The candidate planner cannot supply `files` or `covered`
during planning. Every bound required test must still appear in the canonical
plan's selected files or declared coverage; omission refuses before validation.

The two new train regressions replace both the lane planner and its coverage
import. Both incorrectly promoted against the previous train implementation,
recorded in `regressions-red.log`. With the fix, canonical selection executes
the failing supplemental check exactly once and blocks integration; canonical
omission refuses before running the gate. They verify the lane's planning branch
never executes, the canonical planner can inspect candidate files and changed
paths, the saved plan contains canonical coverage, and main and lane tips remain
unchanged.

Requested offline results: train 33/33, affected-tests 4/4, canonical test-plan
2/2, and test-evidence 12/12. The initial four-file command passed 50/51; the
unchanged mixed-file runner case failed during cleanup because the sandbox
denied a process snapshot (status 125, Operation not permitted). Its entire
affected-tests file then passed 4/4 with host permissions, without changing
tests. The evidence directory contains commands and full logs. Canonical planner
tests include symlinked TMPDIR execution and snapshot cleanup. Diff whitespace
validation passed.

After writing this report to the requested run path and checking it with
`record check`, its repository copy is committed. The final operation is
`node lanes/lane.mjs check --tier fast`; `.lane/gate.json` supplies the
authoritative receipt bound to the final report commit.
