---
run: R-133
outcome: done
summary: |
  Resolved all three validation-tier review findings: checks now normalize pane identities, undeclared Node projects retain their test-directory fallback, and native promotion uses an explicit bounded lifetime through the owner, wrapper, broker and request client.
  Native steps reserve cleanup time within the remaining aggregate deadline. Identical tier commands still share passing evidence, and the scratch worker-to-settle-to-queue cycle validates each distinct tree once across different pane identities.
  Narrowed the lost-response fixture's Git proxy while retaining its 15-second bound. All required offline suites passed after rebasing onto main's compiler-free native owner and reconciling its longer test-file bounds.
headline: Validation now reuses checks across panes and completes longer promotions
blockers: []
proposals: []
learnings:
  - Pane, tab and workspace identities must be removed from execution as well as hashing; ignoring them in the fingerprint alone would allow different command inputs to share evidence.
  - Native lifetime selectors and aggregate deadlines are private transport inputs, excluded from evidence keys and removed before project commands; passing identical fast and promotion commands can therefore share proof.
  - A package.json without scripts.test still uses node --test when test/ exists, including through native check and promotion.
  - The native-entry follow-on proposed in the earlier run is implemented here, including integration with main's compiler-free owner.
  - The final worker check explicitly selects the proposed fast command because canonical declarations do not change until this lane is promoted.
artifacts:
  - "commit: Fix validation reuse and native promotion deadlines"
  - "commit: Reserve native cleanup within the entry deadline"
  - "commit: Preserve main test bounds in validation batches"
  - "commit: Report validation tier corrections for run R-133"
  - "branch: lane/validation-tiers"
  - "docs/reports/ENG-108-validation-tiers-r2-20261002.md"
  - "docs/validation-tiers.md"
  - "lanes/validation.mjs"
  - "discovery/deadlines.mjs"
  - "discovery/test/validation-deadlines.test.mjs"
  - "settle/test/validation-tiers.test.mjs"
  - ".lane/validation-evidence/R-133-validation.json"
  - ".lane/validation-evidence/R-133-npm-test.log"
  - ".lane/validation-evidence/R-133-lanes.log"
  - ".lane/validation-evidence/R-133-acceptance.log"
  - ".lane/validation-evidence/R-133-entry-rebased.log"
  - "lane check --cmd 'npm run test:fast'"
decisions:
  - text: Normalize HERDR_PANE_ID, HERDR_TAB_ID and HERDR_WORKSPACE_ID for preparation, validation execution and environment fingerprinting.
    category: design
    why: Session identity must not affect validation, and worker, settle and queued promotion need identical inputs for evidence reuse.
  - text: Inspect the declared npm test script before selecting the Node test-directory fallback.
    category: design
    why: Package metadata alone does not declare npm test; native entry must preserve previously supported undeclared Node projects.
  - text: Keep fast, preparation and filter deadlines at two minutes and permit promotion validation up to thirty minutes, with wrapper, broker and client bounds plus cleanup reserves.
    category: design
    why: The full promotion workload exceeds the old native lifetime; each step must finish under a bounded policy and confirm descendant cleanup before the aggregate deadline expires.
  - text: Target lost-response fault injection only at the Git ref transaction and retain the existing fixture command limit.
    category: prover
    why: Starting Node for every Git read introduced avoidable fixture overhead; the recovery proof still requires the injected failure and adoption of exactly the saved prepared commit without another review or replay.
questions: []
challenges:
  - The inherited null recovery status occurred near the fixture's 15-second command limit. The narrowed proxy preserves that limit and transaction failure; the final full cycle suite passed the recovery case in 7.2 seconds.
  - Main advanced during validation with longer runner bounds and compiler-free native owners. Rebased onto its current head, kept its owner provisioning and per-test verification actors, and restarted full validation on the integrated tree. Both core and cycle batches retain main's eight-minute file and nine-minute suite bounds.
  - The long-promotion regression scales numeric deadline constants in a disposable product copy to keep execution short. It runs the real native owner and lifetime cleanup with a scripted sandbox transport; it does not claim a thirty-minute wall-clock run or new host-provider confinement evidence.
---

The review's pane-identity finding is covered both at the environment boundary and by the complete scratch cycle. Worker, settle and queue each have distinct pane, tab and workspace identities. The checker asserts those variables are absent. Settlement, saved readiness, the unchanged-tree rebase and queued promotion reuse evidence. Exactly two trees execute: the worker tree and the tree containing the public review record. The queue fast-forwards and closes only its scratch lane.

The undeclared-project regression seeds package metadata and a real Node test directory without an npm test script or validation declaration. Native entry advertises node --test, executes the test, and promotes by reusing the passing fast result. The fixture removes the inherited Node test-runner context so the nested tests actually execute.

Native entry selects promotion bounds from its authorized operation. Preparation keeps the fast bound. Wrappers pass explicit millisecond limits to the native owner; the broker reserves preparation and Git time with a one-hour cap, and the client reserves reply time. Each native step is shortened when needed to leave its cleanup reserve within the aggregate deadline. Requests cannot supply commands, tiers or deadlines. The existing filesystem/network sandbox and owner provisioning remain intact.

The scaled regression proves that a declared command exceeding the shorter owner, wrapper and ordinary request limits succeeds through promotion. Separate red fast and shortened aggregate runs time out through the owner. Successful and timed-out runs leave no descendant able to perform its delayed write. Main's verified bundled owner also passes the no-compiler provisioning and cleanup regressions after integration.

All final offline checks passed on the source commit named in .lane/validation-evidence/R-133-validation.json:

| Check | Result | Duration |
| --- | --- | --- |
| npm test, core | 655 passed; 11 explicit skips | 184.2 s |
| npm test, cycle | 96 passed | 237.8 s |
| npm run test:lanes | 160 passed | 404.8 s |
| npm run test:acceptance | 81 passed | 36.2 s |
| Rebased entry, deadline and compiler-free owner regressions | 34 passed | 22.8 s |

The core/cycle validation includes the scratch reuse cycle, lost-response recovery, native entry and console/config coverage. The lane suite includes cache invalidation, mutation, locking, canonical policy and lifecycle guards. Full logs and the captured source head/tree are in the listed evidence files. No live or skip-live release harness ran; no push, release activation or shared configuration change occurred. The previous run's report was not edited.

This report is checked through the designated record CLI and committed. The final operation is lane check --cmd 'npm run test:fast'; its exact final head/tree evidence is written to .lane/gate.json.
