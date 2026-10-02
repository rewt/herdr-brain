---
run: R-107
outcome: done
summary: |
  Resolved the independent review finding by including the dependency-free promote module in discovery's copied product. The copied lane CLI now loads its existing promotion guard and core dependencies during worker checks and promotion.
  New offline regressions use the actual probe snapshot and installed Codex/Claude adapters. Scripted workers run real project tests, exercise dirty-tree, red-gate, expected-head and STOP refusals, then fast-forward and durably finish both project work and operator-approved route application.
  Rebased onto current main and corrected its reduced plugin-install fixture to include the supervisor and promotion dependencies, adding the shared cold-start and notice-handler assertion. Both copied-product regressions, all 39 plugin-install tests and the full host npm suite pass. The repository cold start measures approximately 1438 tokens.
headline: Discovery snapshots now validate and promote workers with the existing guards intact
blockers: []
proposals: []
learnings:
  - The lane CLI imports promote/guard.mjs unconditionally, so every reduced product containing lanes must also include that module and its lib/store.mjs and lib/state.mjs dependencies.
  - No-auth and skip-live probes verify entry policy but do not exercise deferred worker CLI loading; an installed scripted worker catches missing runtime dependencies without a model call.
  - Clear inherited NODE_TEST_CONTEXT when starting an unrelated project's node --test runner, so nested validation actually discovers and executes its tests.
  - The plugin runtime snapshot already includes the necessary modules; its reduced test source fixture also needs them after integrating the supervisor lane.
artifacts:
  - "Commit: Include promotion guards in discovery probe snapshots"
  - "Commit: Report discovery snapshot corrections for run R-107"
  - discovery/acceptance.mjs
  - discovery/test/acceptance.test.mjs
  - discovery/test/helpers/probe-worker.cjs
  - discovery/README.md
  - test/plugin-install.test.mjs
  - docs/reports/evidence/ENG-94-supervisor/R-107-validation.json
  - docs/reports/evidence/ENG-94-supervisor/R-107-cold-start.txt
  - docs/reports/evidence/ENG-94-supervisor/R-107-cold-start.json
  - "Validation: npm test before and after changes; copied-product and plugin-install regressions; record check this report; lane check last after the checked report commit"
decisions:
  - text: Include the complete dependency-free promote module in the discovery probe snapshot while retaining the existing lane guard and core dependencies.
    category: tooling
    why: A real copied worker must load the same CLI and promotion checks as the source checkout; conditional imports or guard stubs would hide the reviewed defect.
  - text: Exercise the probe's actual installed adapters with scripted native worker and validation transport, real project tests and guarded local integration.
    category: prover
    why: The existing pending probes stop before worker checks and promotion; this regression witnesses both copied transports and route application without authentication or inference.
  - text: Rebase onto current local main, retain its plugin entry documentation and correction-retry assertion, and supply the supervisor and promotion dependencies in its reduced plugin-install fixture.
    category: tooling
    why: The review lacked validation on newer main; the rebase exposed four fixture import failures that must be resolved before the lane can pass its gate.
questions: []
challenges:
  - The required baseline inside the outer worker sandbox had 17 macOS fixture setup failures. The offline host rerun passed before source changes; host execution allows those fixtures to establish their own native sandbox boundaries.
  - The first full post-rebase suite had four plugin-install fixture import failures. Updating that fixture and adding the shared entry assertions resolves them; the final full suite is green.
  - Native worker and validation transport are scripted in the new regression. Live model behavior, actual operator chat clearing, the full release harness, bch-cloak cutover, the full optional lane suite and new filesystem-isolation proof are not claimed.
---

The single finding in the review of the previous report is resolved. Its inherited
validation log contains zero failures. Earlier reports remain intact.

Both new regressions first reproduced ERR_MODULE_NOT_FOUND for the copied
product's promote/guard.mjs at worker check. The snapshot now includes promote/;
its guard continues to import the existing core event store and fold. No guard,
lane lifecycle, production installation or release behavior was weakened.

For each installed transport, a scripted worker starts a real recorded run,
commits a French greeting and its test, and invokes check through the copied
client, entry adapter, lane CLI and validation module. English and French tests
must appear in the output. Dirty work and a committed failing test refuse both
check and promotion. A wrong expected head and supervisor STOP refuse promotion,
and every refused attempt leaves main at its original commit. Restoring green
tests permits validation, a fast-forward and recorded completion. A second
session applies a real scripted operator answer to the pending routing question,
then validates, promotes, finishes and closes the routing setup item. Canonical
trees stay clean and no merge commits appear. The probe reads no authentication,
leaves its live cases pending and records no model usage.

Rebasing preserved both this lane's generated supervisor contract and main's
plugin installation documentation. The overlapping correction-retry assertion
keeps main's comparison of worker mutations, excluding asynchronous watch reads
and supervisor notices. Main's runtime snapshot already includes the modules;
its test source fixture was incomplete. The fixture now supplies dispatch, watch,
settle, promote and supervisor, and its release and workspace supervisor cases
also verify the shared generated cold-start and final-notice contract.

Validation evidence:

- Baseline host npm test before rebase/source changes: 570 passed, 11 skipped,
  zero failures.
- Copied-product regression before the fix: both transports fail on the missing
  promotion guard. After the fix: two passed, zero failures or skips.
- Plugin-install integration regressions: 39 passed, zero failures or skips.
- Final host npm test on the rebased lane: 611 passed, 11 explicitly skipped,
  zero failures or cancellations.
- git diff --check passed, and current main is an ancestor of this lane.

The saved read-only cold start at event sequence 1260 has 5750 characters,
approximately 1438 tokens using ceil(characters/4). It shows four running runs,
23 current report rows and one operator question. Full JSON retains 377 decisions,
including 245 structured report decisions. Running routes, report bindings and
structured decision provenance and rationale were checked against the event fold
through that sequence. The shared record and reading checkpoint were not changed.

The implementation and evidence are committed under the subject cited above.
This report is checked at its requested run path and committed separately in the
repository. The final lane check follows that report commit; its exact HEAD,
validation command and result are retained in local .lane/gate.json for settlement.
No model, live pane, shared configuration, active release, push or publication
was used for this correction.
