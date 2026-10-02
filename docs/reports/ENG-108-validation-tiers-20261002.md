---
run: R-128
outcome: done
summary: |
  Added declared fast, promotion and release tiers with defaults, tracked project overrides, and visibility in lane config, project entry and console desks.
  Passing validation is keyed by the entire Git tree, command and hashed environment and reused by worker checks, settle, unchanged-tree rebases, saved readiness and promotion. Lifecycle and record guards remain enforced.
  The scratch cycle and offline suites passed; the repo's fast/promotion split follows the supervisor's profile. Release execution remains with ENG-109.
headline: Validation tiers now reuse passing checks for unchanged trees
blockers: []
proposals:
  - role: engineer
    title: Honor long promotion-tier checks in native project entry
    why: Discovery still has its existing 120-second validation lifetime, 145-second wrapper timeout and 180-second entry command timeout. The proposed complete promotion tier exceeds those limits; adapt the native lifetime configuration while preserving confinement and descendant cleanup. Core lane and supervisor promotion support these long checks today.
    accept:
      - A declared promotion command longer than the current native lifetime completes through native entry under an explicit bounded policy.
      - Offline tests prove timeout cleanup and confinement remain intact.
learnings:
  - Whole-tree identity includes the public review record; that commit correctly needs a new check even when runtime code is unchanged.
  - Identical commands across tiers share evidence; tier labels alone do not force another execution.
  - External binaries and ignored dependencies need reproducible inputs or a changed validation.environment revision; a stable path alone does not prove their bytes are unchanged.
  - Project declarations come from the canonical checkout, so the final lane check explicitly selects the proposed fast command until this declaration is promoted.
artifacts:
  - "commit: Declare validation tiers and reuse exact-tree passes"
  - "commit: Keep readiness stable and bound offline cycle fixtures"
  - "commit: Report validation tier implementation for run R-128"
  - "branch: lane/validation-tiers"
  - ".lane.validation.json"
  - "docs/validation-tiers.md"
  - "lanes/validation.mjs"
  - "lanes/test/validation.test.mjs"
  - "settle/test/validation-tiers.test.mjs"
  - ".lane/validation-evidence/"
  - "npm test"
  - "npm run test:lanes"
  - "npm run test:acceptance"
  - "lane check --cmd 'npm run test:fast'"
decisions:
  - text: Resolve the three optional tier commands from canonical tracked .lane.validation.json, with validation in .lane.json and the legacy validate fallback also supported.
    category: design
    why: Project policy stays tracked without changing shared machine configuration, and projects without declarations retain usable defaults.
  - text: Store command and environment-qualified whole-tree passes and original logs under the canonical Git common directory.
    category: prover
    why: Reuse survives commit-only rebases while dirty or moving executions, failed checks, altered logs and mismatched inputs cannot supply a green pass; worker gate files remain display evidence.
  - text: Configure a focused fast suite and all offline integration and lane tests for promotion, keeping the candidate-wide harness outside worker and promotion checks.
    category: design
    why: The supplied profile attributes the largest costs to settle, supervisor, rebase and lifecycle scenarios; the fast suite provides frequent feedback while promotion keeps that coverage.
questions: []
challenges:
  - The baseline npm test run exceeded its six-minute suite bound, and a later single aggregate exceeded nine minutes under load. npm test now retains every file in sequential core and cycle batches, each using the supported nine-minute maximum; per-file and ordinary fixture command bounds and owned cleanup stayed in place.
  - Copied discovery cycles requested a 35-second aggregate worker deadline but the synchronous command helper clamped it to 15 seconds. Added an explicit bounded compound-scenario transport with the same ownership and teardown; ordinary command limits remain unchanged.
  - Reuse changed expected fresh-output and log-path behaviour in existing probes. Corrected the probes to inspect inherited logs, kept readiness results idempotent, and scoped promotion fault injection to the dequeue environment.
  - Offline acceptance exposed a copied fixture that omitted the existing settle dependency imported by the CLI. Repaired only that offline fixture and its actor; no live or skip-live release harness was run.
  - Native project entry retains shorter existing validation lifetimes than this repo's complete promotion tier; the concrete follow-on above covers that separate execution path.
---

Every project has three resolved tiers. Worker check selects fast; settle and promote select promotion; lane check refuses release. The tracked override is canonical, with legacy command overrides retained for adapters. Config and the console desks show all commands and their sources, and entering workers are told which check they run.

The receipt includes tree, command, environment fingerprint, source head, exit status, timing and a content-checked log. A matching pass is reused across checks and lifecycle steps. Failures and signals rerun; changed trees, commands, environment, preparation definitions or declared external revisions invalidate reuse. Per-key locks exclude overlapping execution, and crash locks fail closed for inspection. Promotion retains clean canonical/lane worktrees, rebase preservation, expected head/run checks, base freshness and local fast-forward guards.

The end-to-end scratch test uses real Git, record intake, check, review publication, proved rebase and promotion; only reviewer model transport is scripted. It executes once for the worker tree and once for the tree including the public review record. Settle's initial check, repeated readiness and promotion reuse those passes. Separate tests cover changed-tree rebases, distinct tier commands, cache corruption, failed/dirty/moving executions, concurrency, canonical overrides and discovery/console visibility.

Offline validation completed with no failures:

| Check | Result | Observed duration |
| --- | --- | --- |
| `npm test`, core batch | 633 passed; 11 explicit skips; 644 total | 169.7 s |
| `npm test`, cycle batch | 96 passed; 96 total | 288.2 s |
| `npm run test:lanes` | 159 passed | 417.8 s |
| `npm run test:acceptance` | 81 passed | 37.1 s |
| Focused copied-entry and owned-process deadline/cleanup checks | 24 passed | 61.1 s |
| Initial fast tier measurement | 139 passed | 10.1 s |

The two `npm test` batches preserve all 73 original test files (62 core, 11 cycle); the expansion proof records no missing files. Full logs and that proof are saved in this lane's ignored `.lane/validation-evidence/` directory. The complete lane suite includes the scratch lifecycle and cache tests; the complete cycle batch includes settle readiness and promotion-queue guards. No live acceptance or `--skip-live` harness ran.

The proposal and profile rationale are in docs/validation-tiers.md. This lane was rebased onto main after its two unrelated release-gate brief amendments. No shared .lane.json, release installation, external project or live pane was changed; no push or activation occurred.

The report is checked through the designated record CLI and committed. The final operation is lane check --cmd 'npm run test:fast', selecting this lane's proposed fast command without changing canonical configuration. Its exact final commit/tree evidence is in .lane/gate.json.
