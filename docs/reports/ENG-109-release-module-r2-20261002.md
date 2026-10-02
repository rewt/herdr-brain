---
run: R-134
outcome: done
summary: |
  Corrected all three independent-review findings: the declared gate supplies its required machine inputs, preview preparation performs real offline dependency installation and retains build evidence, and agents cannot start runs on operator-reserved release questions. The single repository preview built 40 console and 94 MCP packages and invoked acceptance through the module: 9 pass, 0 fail, 18 pending. Added complete bounded npm-test phases and fixed a tar stdin EPIPE failure discovered during validation. Rebased onto current main; the final lane check runs the complete npm suite after this report is checked and committed.
headline: Release candidates now build and receive complete gates while operator decisions stay protected
blockers: []
proposals: []
learnings:
  - "The repository wrapper needs RELEASE_BCH_CLOAK and a populated RELEASE_NPM_CACHE; npm_config_cache and ~/.npm are cache fallbacks. Preparation and acceptance use private cache copies."
  - "Build-only preparation installs both pinned dependency sets and retains .release-build.json before acceptance starts; skipping live cases cannot produce release-ready evidence."
  - "BSD tar can close archive stdin before Node finishes sending padded bytes, causing spawnSync EPIPE. An owned archive file avoids this failure."
  - "Main now supplies 480-second file and 540-second suite watchdogs; the phased npm runner forwards both, retaining ordinary fixture and command limits."
artifacts:
  - "Commit: Build release candidates offline with complete gates and protected operator decisions"
  - "Commit: Retain built candidate proof and forward bounded suite options"
  - "Commit: Extract candidate snapshots from owned archive files"
  - "docs/reports/ENG-109-release-preview-r2-20261002.json: replacement build receipt, actual acceptance argv, three record events and all case dispositions"
  - "docs/reports/ENG-109-release-module-r2-20261002.md: committed copy of this report"
  - "ORG_ACTOR=R-134 node test/helpers/run.mjs release/test/*.test.mjs test/suite.test.mjs: 22 passed, 0 failed; /tmp/eng-109-r134-rebased-focused-fixed.log"
  - "ORG_ACTOR=R-134 npm run test:acceptance: 81 passed, 0 failed after the compiler-free owner rebase; /tmp/eng-109-r134-acceptance-offline.log"
  - "Initial complete npm test attempt: /tmp/eng-109-r134-npm-test.log; every file ran, with a snapshot failure subsequently diagnosed and corrected"
  - "Final validation command: ORG_ACTOR=R-134 node lanes/lane.mjs check; runs npm test on the committed report head and retains .lane/gate.json plus /tmp/eng-109-r134-lane-check.log"
decisions:
  - text: "Keep machine input resolution in this repository's declared wrapper and perform offline dependency preparation within each candidate using a private cache copy."
    category: design
    why: "Supply both acceptance prerequisites through local environment paths and keep dependency writes within the owned candidate."
  - text: "Run the complete npm file list in bounded phases and forward the integration branch's watchdog options."
    category: prover
    why: "Avoid the reproduced aggregate timeout, isolate the copied-entry probes and preserve complete coverage plus existing fixture limits."
questions: []
challenges:
  - "The previous preview skipped dependency installation and did not establish build proof. Its report is unchanged; this run supplies replacement evidence of real npm ci installations and lockfile/version verification."
  - "The repository preview is wiring evidence, not release readiness: 9 PASS, 0 FAIL, 18 PENDING, acceptance exit 1, and no shipping question. Live Herdr cases and discovery were intentionally unavailable or skipped. Console dependency-build acceptance now passes."
  - "The initial npm command reproduced the six-minute aggregate timeout. A phased complete attempt subsequently failed one gate fixture; focused diagnosis captured spawnSync tar EPIPE during snapshot extraction. The archive-file correction and all 22 focused regressions passed before final lane validation."
  - "The single retained preview used the implementation commit before rebase and the archive-file correction. Its build/gate wrapper is unchanged by those later changes; its source commit and exact tagged candidate remain explicit in the evidence. No additional acceptance pass was run."
  - "The scratch preview used a load threshold of three per CPU; production retains one. The lane was rebased onto the main update titled npm test: use the runner's longer bounds (540 s suite) until validation tiers land."
  - "Main subsequently incorporated compiler-free validation owners; that update is also included by rebase and covered by final offline validation. The retained preview predates this upstream update."
---

The tracked repository declaration now invokes `herdr/release-candidate.mjs` for
preparation and gating. Preparation copies cache indexes and only the console/MCP
lockfile tarballs, runs the installer with offline npm and build-only mode, then
verifies installed versions and records the candidate commit, lockfile hashes,
package counts and command. Acceptance receives the candidate directory, private
npm cache and existing-project path. Setup instructions are in `release/README.md`.

`record start` enforces the reserved-question restriction inside the event-log
transaction before allocating a run or writing events. Tests attempt starts while
the question is pending and after both yes and no answers, including conditional
starts; rejected attempts leave the event bytes and run directories unchanged.
The previous decision survives and a subsequent batch can reach its own operator
question. Existing scratch tests still exercise two actual promotions, one tagged
batch, one gate and a scripted operator decision without executing ship.

The repository preview retained a real built candidate in its owned temporary
project. Its build receipt precedes the actual acceptance invocation in the gate
log. The record contains exactly cut, gate-start and gate-finish events; pending
live coverage yields a failed gate and no operator question. The replacement JSON
links the raw log and acceptance evidence and retains every disposition.

The final lane check is deliberately run after committing this report. Its gate
receipt and complete test log provide the result for that exact head. No live
acceptance run, model call, shipping, activation, push, shared configuration edit,
bch-cloak write or live pane mutation was performed.
