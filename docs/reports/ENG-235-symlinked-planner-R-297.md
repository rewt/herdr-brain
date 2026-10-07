---
run: R-297
outcome: done
summary: |
  Fixed canonical planner execution under symlinked temporary directories by resolving the snapshot temp root and sharing the realpath main-module check across the planner and four related test helpers. Empty or whitespace-only output now produces an explicit planner failure, preserving stderr when present.
  All 63 focused offline tests passed; after committing the implementation as 829a871, both canonical-planner tests also passed with TMPDIR set to a symlinked directory. This checked report is committed next, followed by the final lane fast check and its exact-HEAD receipt.
headline: Canonical test planning now works with symlinked temporary directories
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 829a871"
  - "Branch: lane/bound-escalations"
  - "docs/evidence/ENG-235/R-297/README.md"
  - "docs/evidence/ENG-235/R-297/reproduction.log"
  - "docs/evidence/ENG-235/R-297/focused.log"
  - "docs/evidence/ENG-235/R-297/canonical-symlink.log"
  - "docs/reports/ENG-235-symlinked-planner-R-297.md"
  - "/Users/rewt/development/rewt/.org/runs/R-297/report.md"
  - ".lane/gate.json (final lane fast-check receipt)"
decisions: []
questions: []
challenges: []
---

The original canonical-planner regression failed unmodified under a symlinked
TMPDIR with the supervisor's reported JSON parse error. The planner compared
the unresolved argv path against Node's realpath module URL and exited without
emitting a plan.

`lib/cli-help.mjs` now exports its realpath comparison as `isMain`, which
`cliHelp` also uses. The main guards in affected-tests, release-suites, tier,
suite and pty use that helper. The audit found no remaining instances of the
reported path.resolve main-module pattern in `test/helpers/`.

Settle materializes its captured-commit snapshot below
`fs.realpathSync(os.tmpdir())`. The promotion plan reader rejects empty and
whitespace-only stdout before JSON parsing with
`promotion test planner produced no output`, including stderr when available.
Integration tests verify that these failures cover nothing, retain the explicit
error, and can be discharged through recorded full-file re-execution.

Validation: the five focused files passed 63 tests, zero failures and zero skips
(affected-tests 4, canonical planner 2, test-evidence 12, helper CLI launches 4,
CLI help 41). After implementation commit `829a871`, the entire canonical-planner
file passed again, 2/2, with TMPDIR explicitly pointing to a symlinked scratch
directory. That confirmation executes the updated planner and its transitive
imports from the committed canonical snapshot. Logs and commands are in the
evidence directory. The existing feature test files changed here are absent
from main, so reproduction used the lane's original unmodified test.

After checking and committing this report, the final operation is
`node lanes/lane.mjs check --tier fast`. Its authoritative receipt is the ignored
`.lane/gate.json`, bound to the final report commit.
