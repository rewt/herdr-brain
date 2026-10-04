---
run: R-239
outcome: done
summary: |
  Reproduced the retained copied-product probe and identified its failing supervisor-entry policy case.
  Restored the shared final-notice contract while preserving the autopilot instructions.
  Added copied Codex and Claude policy regressions to promotion coverage; both copied worker probes
  and the complete discovery suite pass. The fix and evidence are committed; final lane check follows this report commit.
headline: Copied Codex and Claude probes pass with supervisor entry covered before promotion
blockers: []
proposals: []
learnings:
  - "Copied discovery entry embeds supervisor/PROTOCOL.md. Changes outside discovery can break its shared release contract."
  - "The existing supervisor-entry contract test was release-only. Promotion now runs copied policy checks for both adapters while the full worker probes remain release-only."
  - "The copied worker probes need host access on macOS to apply their own sandbox; a nested sandbox can refuse sandbox_apply with Operation not permitted."
artifacts:
  - "Implementation and evidence commit: 268d028 (Preserve supervisor notice contract and gate copied entry in promotion)"
  - "Branch: lane/probe-regression"
  - "supervisor/PROTOCOL.md; discovery/test/entry.test.mjs; test/helpers/tier.mjs; test/tier-plan.test.mjs"
  - "docs/reports/evidence/ENG-184: retained failing probe summary and log, red/green entry tests, copied-probe results, complete discovery-suite results and nested-sandbox diagnostic"
  - "Original --keep evidence: /private/tmp/mp-zn9XJH/evidence"
  - "Report: docs/reports/ENG-184-probe-regression-20261004.md"
  - "Report validation: ORG_DIR=/Users/rewt/development/rewt/.org node /Users/rewt/development/rewt/herdr-brain/bin/org.mjs check docs/reports/ENG-184-probe-regression-20261004.md"
  - "Final command after report commit: node lanes/lane.mjs check; .lane/gate.json records the final committed head and validation outcome."
decisions:
  - text: Restore the stable final-notice contract and explain that autopilot and manual exception handling share the same settle and guarded promotion path.
    category: design
    why: The installed product must satisfy its existing contract while still teaching the current automation behavior.
  - text: Run the copied supervisor-policy regressions for both adapters in the promotion tier and protect that selection with the tier-plan test.
    category: prover
    why: The inexpensive entry checks reproduce this failure before merge without moving the complete worker workflow probes into promotion.
questions: []
challenges:
  - "The ask hypothesized lessons-at-entry changes. The retained probe instead fails case 04 because ff2a7c6 replaced the required final-notice sentence in supervisor/PROTOCOL.md; the lessons section is unrelated to this failure."
---

The initial offline probe used `discovery/acceptance.mjs --harness codex` with a
scripted native executable and validator, `--skip-live --keep`. Its summary's
only FAIL row was **04 Installed entry teaches dispatch, watch, worker and
supervisor defaults**. The assertion required the literal sentence
`Every final [org-report] notice takes one path` (with backticks in the policy).
The notice-autopilot change had replaced it with exception-only wording.
The other offline probe cases passed; the two omitted live cases were PENDING.

The product protocol now states the shared path and explains who handles routine
notices and exceptions. `discovery/test/acceptance.test.mjs` and
`acceptance/entry.mjs` are unchanged. The entry regression copies the actual
distributed product into scratch, checks both adapters in an untouched project,
and retains its negative controls for missing cold start and missing handler.
Both new copied-entry cases failed against the original policy before the fix.

Validation through `node test/helpers/run.mjs`:

- `--test-name-pattern='copied (codex|claude) supervisor entry' discovery/test/entry.test.mjs`: before the fix, 2 failed and 5 unselected cases skipped.
- `discovery/test/entry.test.mjs test/tier-plan.test.mjs`: 8 passed, zero failures or skips.
- `--test-name-pattern='copied (codex|claude) probe' discovery/test/acceptance.test.mjs`: 2 passed, zero failures or skips.
- `discovery/test/*.test.mjs`: 129 passed, zero failures, 10 explicit skips (nine native/provider opt-ins and one Linux kernel case).

The first worker-probe attempt was refused by nested macOS sandboxing during
validation. The authorized host-access rerun passed using the product's own
sandbox. Evidence retains both results. Tests were offline and called no model;
no live acceptance harness or project-wide housekeeping was run.

This report is checked and committed before the final default lane check. Its
result is retained in `.lane/gate.json` and the Git common-directory validation
receipt, bound to the final committed tree.
