---
run: R-256
outcome: done
summary: |
  Added a standalone dependency-free, model-free promotion metrics CLI with text and JSON output, project and window selection, gate timing, lanes per gate, first-pass green rate, bisection attribution, and slowest test steps, files and groups. It imports bch-cloak's archived baseline read-only and distinguishes its successful-log selection and lower-bound timings from current wall-clock measurements. Twelve offline fixture tests pass. Code is committed as 50401d6; this report precedes its record check, report commit and final lane check.
headline: The train now reports gate timing and failures, with four recent gates green at a median of four minutes and thirty-six seconds.
blockers: []
proposals:
  - role: engineer
    title: Include per-file durations in multi-file TAP gate output
    why: The slowest measured herdr-brain step is the core gate at a 252.60-second median, but its two multi-file TAP streams do not identify individual file timings. Receipts and existing logs cannot reveal the global slowest test files. Add file identity and elapsed time to the offline test runner output so the read-only metrics reader can rank them without estimating from test names or summing nested durations.
learnings:
  - The telemetry change actually integrated at 2026-10-04T21:07:14.230Z in batch ea4ee5c8-1950-4ed4-912e-e248aa023224. Its Git commit timestamp is earlier and is not the landing time. That batch ran the old train and has no batch started_at.
  - Cached validation receipts retain their original duration and timestamps. Count them as reuse, not another executed gate or another contribution to gate time.
  - Resuming a prepared attempt replaces its previous gate object. An interrupted execution whose clock or result was overwritten cannot be reconstructed from the final train receipt; first-pass means first retained gate.
  - Multi-file TAP stream totals and globs are group timings, not individual file timings. Sum sequential stream totals per step and gate before comparing steps across gates.
  - bch-cloak's archived baseline contains only successful promotion logs. Its 54 green runs cannot measure first-pass success, and its 623-second median is an in-log lower bound rather than wall-clock gate time.
artifacts:
  - "Commit 50401d6: feat: add read-only promotion train metrics and archived baseline"
  - "Branch lane/train-metrics"
  - "promote/metrics.mjs"
  - "promote/test/metrics.test.mjs"
  - "docs/reports/ENG-209-train-metrics-20261005.md"
  - "node test/helpers/run.mjs promote/test/metrics.test.mjs: 12 passed, zero failed, cancelled or skipped"
  - "Final lane check evidence is .lane/gate.json and its referenced validation log; the check runs after the report commit."
decisions:
  - text: Count gate executions independently of lane results, and separate cached, duplicated, unfinished, interrupted and unknown evidence.
    category: tooling
    why: Bisection produces several gates and several lane outcomes; reuse carries historical time, and a start clock or validation exception alone does not prove a command executed.
  - text: Use exact gate logs with hash checks for attribution and timings, and leave combined train.log unassigned to individual attempts.
    category: tooling
    why: train.log appends output across bisections and resumes. Assigning its failures to every attempt would invent attribution. Changed-file overlap is a hint; singleton red attempts identify the isolated lane.
  - text: Import the archived report's sibling evidence summary without running bch-cloak's CLI or writing a backfill record.
    category: tooling
    why: The archived summary supplies reproducible baseline totals and rankings while preserving the required read-only boundary.
questions: []
challenges:
  - Forty-two older receipts have no batch started_at and are explicitly excluded from a time-window query. The five receipts with clocks after telemetry landed give four completed green gates and one pre-gate refusal. This is a small retained sample, not a claim about all historical promotions.
  - The existing logs do not identify individual file timings for the slowest core step. The tool exposes identifiable single-file timing and multi-file groups separately, with the missing coverage proposed above.
---

Implemented only `promote/metrics.mjs`, its fixture test file and this requested report. The promotion writer, lifecycle checks, validation scripts and bch-cloak checkout were left unchanged. The CLI resolves the canonical Git common directory from either a primary checkout or linked lane. Its only child processes are read-only Git queries using argument arrays and `GIT_OPTIONAL_LOCKS=0`.

Usage:

```sh
node promote/metrics.mjs --project /path/to/project --since 2026-10-05 --json
node promote/metrics.mjs --since 2026-10-04T21:07:14.230Z \
  --until 2026-10-05T14:29:20Z \
  --baseline /Users/rewt/development/bastian/archive/ENG-949-PROMOTE-BATCH-METRICS-20261004.md
```

`--json` includes individual batch and attempt rows, all warnings and the imported baseline. `--help` documents options. Date-only boundaries are UTC midnight; timestamp boundaries require a timezone. Windows select batch start, inclusive at `--since` and exclusive at `--until`, retaining all bisection attempts of selected batches. Baseline dates stay separate from the train query window. Missing or malformed receipts, missing logs, unavailable Git history and hash mismatches are visible rather than silently fabricating measurements.

Herdr-brain measurements since telemetry landed, through **2026-10-05 14:29:20 UTC**:

| Metric | Measured value |
|---|---|
| Batches | 5 complete; 1 refused before gating |
| Executed gates | 4, all `npm run test:promotion` |
| Gate outcomes | 4 green, 0 red; no interrupted, unfinished or unknown gates in this sample |
| Gate wall time | Median **275.59 s** (4m35.59s); total **1,103.55 s** (18m23.55s); maximum **295.01 s** |
| Lanes per executed gate | Mean, median and maximum **1** |
| Lanes landed per green executed gate | **1** |
| First retained gate green, per gated batch | **4/4 = 100%**; pre-gate refusal excluded |
| Cached proofs / duplicate evidence / bisected batches | 0 / 0 / 0 |

The receipts are retained under `/Users/rewt/development/rewt/herdr-brain/.git/promote/batches/`:

| Batch | Lane | Gate wall time |
|---|---|---|
| d99e7890-8cbe-4772-b88d-6e8f747c2853 | case21 | 257.36 s |
| 0eb53638-2034-44fe-a377-44c36a04100d | console-ux | No gate; refused |
| 87cb4f38-6e1d-44c7-a8ec-a9d2fa62c5c3 | console-ux | 259.22 s |
| a1871fb5-60d2-4671-892a-c5e74f29e84e | workflow-engine | 295.01 s |
| 2ba38e70-ffc0-4643-b7c7-f8021871b989 | pipelines | 291.97 s |

Slowest steps sum completed test-stream totals within each gate, excluding unlogged build, startup and slot-wait time:

| Step | Median test time | Maximum | Gates sampled |
|---|---|---|---|
| test:promotion:core | **252.60 s** | 272.13 s | 4 |
| test:promotion:lanes | 8.59 s | 8.62 s | 4 |
| test:slot | 6.96 s | 7.19 s | 4 |
| test:promotion:logic | 6.23 s | 6.27 s | 4 |

The identifiable single-file run is `lanes/test/lane.test.mjs`, median **8.59 s**, maximum **8.62 s**, over four selected promotion-gate runs. It is the slowest identifiable file in these logs, not proof that it is the slowest file in the full gate. The `test-slot/test/*.test.mjs` glob has a **6.96 s** group median; the 19 explicitly named files in the logic command have a **6.23 s** combined median. The core streams expose no per-file identities. No real red batch is present in the selected window; fixtures prove red attribution and bisection behavior.

The read-only bch-cloak baseline imports the archived report and `ENG-949-PROMOTE-BATCH-METRICS-20261004-evidence/backfill-report.txt`:

- **54** successful archived direct promotions from September 28 through October 4; **4** narrow gates and **50** full gates; **1 lane per gate**.
- Full-gate in-log lower-bound median **623 s** (10m23s), rounded total **37,140 s** (10h19m). Builds, typechecks and slot wait are absent, so this cannot establish a wall-clock speed comparison with herdr-brain.
- First-pass rate is **unavailable** because red logs were not archived; the archive's 54/54 green selection is explicitly identified.
- Slowest step medians: pool-action-modules **218 s**, reference-aggregator **163 s**, live-scripts **91 s**, protocol **54.8 s**, wallet **53.3 s**.
- Slowest file: `packages/reference-aggregator/test/apnt_import_created_note_seal_native_stage_padding_solver_v1.test.ts`, median **159 s** over 50 gates. Next: pool-action-modules `test/stage3-local-ab.test.ts` **85 s**, `record/stage3-local-ab-scans.test.ts` **76 s**, `record/stage3-scan.test.ts` **75 s**.

Validation: `node test/helpers/run.mjs promote/test/metrics.test.mjs` passed **12/12** offline checks. Tests cover bisected red receipts, changed-file attribution and singleton isolation, unfinished and signalled gates, exceptions, pre-gate refusals, reuse and duplicate proofs, window boundaries, linked common-directory identity, read-only CLI snapshots, malformed receipts, missing or altered logs, unavailable and untouched Git evidence, TAP/Vitest parsing, glob/group separation, sequential-step aggregation and read-only archived baseline import. `git diff --check` passed. No live promotion, release acceptance harness or project-wide housekeeping loop ran.

As requested, the remaining order is report check, report commit, then `node lanes/lane.mjs check` as the final command. This report makes no advance claim about that check's result; its receipt and validation log provide the evidence.
