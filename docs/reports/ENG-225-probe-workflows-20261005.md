---
run: R-268
outcome: done
summary: |
  Reproduced the copied worker's missing workflow engine failure and fixed the product inventory to carry the engine and Markdown definitions.
  Default trains now load neither the engine nor its definitions; opted-in and persisted workflow batches load it under the promotion lock.
  Added copied default, copied opt-in, and asynchronous lock regressions to the existing promotion-tier workflow tests.
  Both copied worker probes, all 95 targeted promotion tests, and all 53 unchanged train/promotion tests with the engine enabled pass.
  Implementation and evidence are committed as 39b6682; the final lane check follows report validation and commit.
headline: Copied worker probes pass and workflow loading stays opt-in.
blockers: []
proposals: []
learnings:
  - "The copied probe's offline setup cases pass despite this regression. Its scripted worker fails at monitor check because lanes/lane.mjs imports promote/train.mjs, which statically imported the omitted workflow/engine.mjs."
  - "lib/product-files.mjs is the shared distribution inventory. Workflow runtime modules and .herdr/workflows definitions must both travel with copied products."
  - "Lazy engine imports require the promotion lock to remain held until the train's returned promise settles. A persisted workflow still selects the engine when resumed without the flag."
artifacts:
  - "Implementation and validation evidence commit: 39b6682 on lane/probe-workflows"
  - "lib/product-files.mjs; promote/train.mjs; lanes/lane.mjs"
  - "promote/test/workflow-train.test.mjs; test/tier-plan.test.mjs"
  - "docs/reports/evidence/ENG-225: retained probe summary and module failure, red/green copied train regressions, copied worker results, complete promote results, opt-in results, and nested-sandbox diagnostic"
  - "Retained original probe evidence: /private/tmp/mp-FeovGX/evidence"
  - "Report: docs/reports/ENG-225-probe-workflows-20261005.md"
  - "Report validation: ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs check docs/reports/ENG-225-probe-workflows-20261005.md"
  - "Final command after report commit: node lanes/lane.mjs check; its result is retained in .lane/gate.json and the Git common-directory validation receipt."
decisions:
  - text: Include the workflow runtime and definition directory in the shared product inventory and import the engine only for selected or persisted workflow batches.
    category: design
    why: Copied products need a complete opt-in runtime, while default lane commands and trains must work without the prototype engine or its definitions.
  - text: Retain the promotion lock through asynchronous engine initialization and train completion.
    category: design
    why: Introducing a lazy import must not allow a second batch to enter during module loading or leave an ordinary failed import locked.
  - text: Keep copied train regressions in the existing promotion-tier workflow test file and assert that selection in the tier-plan test.
    category: prover
    why: Inexpensive copied train coverage catches missing runtime modules and definitions before merge.
questions: []
challenges:
  - "The retained --skip-live --keep probe has no FAIL setup row: cases 02, 03 and 04 pass, and cases 20 and 21 are expected PENDING. The release test fails later in its scripted worker at monitor check; the retained copied lane CLI reproduces the same ERR_MODULE_NOT_FOUND."
---

The copied Codex test reproduced the regression before changes. The scripted
worker starts its run and commits the greeting, then `monitor check` launches the
copied lane CLI. The import chain is `lanes/lane.mjs` → `promote/train.mjs` →
`workflow/engine.mjs`; the last module was absent from the distribution inventory.
The Markdown definitions were absent too, which would also prevent the opt-in
train from executing after restoring the engine module alone.

The retained probe was run with `--skip-live --keep` and a scripted native
executable and validator. Its summary and log are committed. Running `lane check`
from that original copied product reproduces the missing-module error before
validation starts; `retained-product-check-before.log` captures it. The copied
worker acceptance tests themselves are unchanged.

The product inventory now includes `workflow/` and `.herdr/workflows/`, including
local definition fragments. The default train has no static engine import. It
imports dynamically when `--workflow`, `PROMOTE_WORKFLOW_ENGINE=1`, or a saved
workflow selects it. The CLI awaits the train while retaining its existing
promotion lock, including across module initialization. Lifecycle guards, pinned
workflow hashes, gate proofs and recovery checkpoints remain in place.

The two new copied train regressions failed against the original implementation
with `ERR_MODULE_NOT_FOUND`. One now removes the engine and definitions from the
copied product and proves default promotion succeeds without workflow receipts.
The other executes the actual copied opt-in train and proves all four stage
receipts succeed, one real project gate runs, and main advances by fast-forward.
A third regression tries a competing batch during engine initialization, verifies
the lock refusal, forces an import failure, and proves the lock releases and a
default retry succeeds. The tier-plan test protects their promotion selection.

Validation through `node test/helpers/run.mjs`:

- `--test-name-pattern='copied (default|opt-in) train' promote/test/workflow-train.test.mjs`: before the fix, 2 failed and 5 unselected cases skipped.
- `promote/test/workflow-train.test.mjs test/tier-plan.test.mjs`: initial fix, 8 passed before adding the lock regression.
- `--test-name-pattern='copied (codex|claude) probe' discovery/test/acceptance.test.mjs`: 2 passed, zero failures or skips, 19.7 seconds.
- All seven `promote/test/*.test.mjs` files plus `test/tier-plan.test.mjs`: 95 passed, zero failures or skips, 127.3 seconds. Includes all three new regressions.
- `PROMOTE_WORKFLOW_ENGINE=1` with unchanged `promote/test/train.test.mjs` and `promote/test/promote.test.mjs`: 53 passed, zero failures or skips, 180.6 seconds.
- `git diff --check`: passed before the implementation commit.

The first post-fix worker-probe attempt hit the known nested macOS sandbox refusal
(`sandbox_apply: Operation not permitted`). Both probes passed with host access
using the product's own validation sandbox. Promotion fixtures also ran with host
access for their filesystem watchers. All tests were offline and called no model.
No baseline, full npm suite, promotion tier, lane suite, live acceptance harness,
or project-wide housekeeping loop was run.

This report is checked and committed before the final default lane check. That
check binds its gate evidence to the final committed tree; the report does not
claim its result in advance.
