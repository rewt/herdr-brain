---
run: R-287
outcome: done
summary: |
  Added bounded, recorded import-graph selection of affected release test files to the promotion batch gate, including changed test files and full-file execution without repeating mixed-tier patterned checks.
  Scoped test-only PASS deferrals now use the normal run-bound promotion path; the supervisor can discharge an uncovered deferral after recording an exact-head green full-file re-execution receipt. Autopilot retains stderr diagnostics for failed commands whose stdout cannot parse.
  Focused offline regression checks passed after rerunning two sandbox filesystem-watch failures with host permissions. Implementation and evidence are committed; the checked report is committed next, followed by the required final lane fast check.
headline: Affected tests now gate bound promotions and their landings close the item automatically
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation commit: 7d50069"
  - "Branch: lane/bound-escalations"
  - "docs/evidence/ENG-235/README.md"
  - "docs/evidence/ENG-235/focused.log"
  - "docs/evidence/ENG-235/validation-retry.log"
  - "docs/evidence/ENG-235/final-evidence.log"
  - "docs/reports/ENG-235-bound-test-evidence-R-287.md"
decisions:
  - text: Use a canonical project-owned promotion test planner and retain deferred files in the bound queue request.
    category: design
    why: Preserve the generic dependency-free train and prevent a later gate configuration from silently omitting the evidence that authorized promotion.
  - text: Accept only exact scoped test deferrals from an independent PASS review, or exact-head green full-file re-execution receipts recorded as run decisions.
    category: prover
    why: Preserve independent review and every lifecycle guard while distinguishing deferred execution from incomplete acceptance or unresolved claims.
questions: []
challenges: []
---

The canonical validation declaration enables `test/helpers/affected-tests.mjs`.
The planner selects changed existing test files across tiers plus release files
whose static dependency closure reaches changed modules. It handles import and
re-export literals, dynamic import literals, launched-script paths, joined-path
basename references, cycles, renames and deleted dependencies. Planning refuses
above 10,000 paths, 32 MiB of source, 512 selected files or 20 seconds. Execution
uses bounded release suites of at most four files with existing deadlines,
inside the promotion gate's slot, hashed log and receipt. The selection salts
the effective gate command and is retained in `attempt.test_plan`.

The default promotion command's full-file coverage includes its host-slot test
files. An overridden command does not inherit that coverage. Selected mixed
files skip patterned steps and execute once in full. A red supplement blocks
landing; a plan that omits a bound deferred file refuses before integration.

Reviewers still run zero commands. Only exact Unverified entries of the form
`- Test evidence not re-executed: path/to/file.test.mjs`, with PASS and no other
unresolved claims, are eligible. Unknown prose and missing acceptance evidence
continue to escalate. The supervisor's `promote RUN --why` resolves a retained
test-only escalation only after a decision note names a valid green validation
receipt for the exact lane head/tree and an unfiltered full-file test command.
The resulting queue request stays bound to the run, reviewed head and record.
Existing clean-tree, STOP, record readiness, independent review, replay proof,
fast-forward and verified landing closure checks remain in force.

The offline end-to-end test exercises the real notice, settle, supervisor,
queue and train CLIs: scoped deferral, bound enqueue, one supplemental execution,
landing and silent item closure. Other tests cover stale/unrecorded evidence,
mixed unresolved claims, override coverage, changed required-file bindings,
red supplements, graph closure and patterned-step deduplication. The six-file
focused run produced 138 pass and two sandbox fs.watch EMFILE failures; those
two passed with host permissions. The final evidence run passed 5/5. Full train
and autopilot test files passed in the focused run. No aggregate promotion,
release, live acceptance harness or housekeeping loop was run in this lane.

Static selection deliberately does not evaluate computed runtime references;
those need a literal path/import to enter the graph. The candidate's full
release gate remains necessary. The final operation after the report commit is
`node lanes/lane.mjs check --tier fast`; its result is retained in `.lane/gate.json`.
