---
run: R-303
outcome: done
summary: |
  Housekeeping now distinguishes missing reports, unmatched launch identities, blocked or needs_human report outcomes, and waiting item or blocker evidence. The release cleanup fixtures and switched-copy test assert each waiting outcome's exact keep reason. All four requested offline files passed 54/54; the implementation is committed and the report and evidence are ready for the final lane check.
headline: Cleanup explains why each worker stays and verifies waiting outcome guards
blockers: []
proposals: []
learnings:
  - Cutover fixtures must use scratch outside the real home prefix; the worker's inherited home-scoped TMPDIR causes the live-path audit to reject otherwise relocated files. Use /private/tmp and allow process inspection for the bounded runner's fixture audit.
artifacts:
  - 798d9d31f35f80f17bab1a777fc335eb7be90d60
  - docs/reports/ENG-261-keep-reasons-R-303.md
  - docs/reports/evidence/R-303/targeted-host.tap
  - docs/reports/evidence/R-303/targeted-sandbox.tap
  - /Users/rewt/development/rewt/.org/runs/R-303/report.md
decisions:
  - text: Carry keep reasons alongside recorded worker eligibility and preserve existing closure guards.
    category: design
    why: Exact waiting-outcome receipts must prove which guard retained the worker without weakening launch identity or whole-tab checks.
questions: []
challenges: []
---

Implementation commit: `798d9d31f35f80f17bab1a777fc335eb7be90d60`.

`reportEvidenceFromRecords` returns the existing eligible-worker set plus reasons
for ineligible workers. Identity checks precede report and outcome checks. Missing
reports retain `no recorded report for NAME`; identity failures use `recorded
launch identity does not match NAME`; waiting reports use `waiting on recorded
blocked outcome for NAME` or `waiting on recorded needs_human outcome for NAME`.
Waiting item/dependency evidence gets its own reason. Tidy carries these reasons
into its existing dry-run output, including each ineligible worker in shared tabs.
Duplicate worker names still require every observed occupant to match.

The acceptance cleanup harness and installed switched-copy assertions now require
the exact blocked or needs_human reason. The switched-copy test separately asserts
legacy launch-identity and open-run reasons. New tidy tests cover missing reports,
newest open runs, identity mismatches, tied records, duplicate names, shared tabs,
waiting outcomes, and item/blocker guards. Clearing each waiting guard makes the
same otherwise eligible worker close, demonstrating the guard caused retention.

The initial lane tip lacked the named switched-copy test and the installed
record-based cleanup path. This lane was rebased onto reviewed prerequisite
`2278412d` (existing-cleanup) before editing. Its changes are inherited evidence;
this run's implementation changes only the four keep-reason files.

| Requested file | Passed | Failed |
| --- | ---: | ---: |
| test/tidy-tabs.test.mjs | 19 | 0 |
| housekeeping/test/auto-tidy.test.mjs | 20 | 0 |
| acceptance/test/cutover-housekeeping.test.mjs | 1 | 0 |
| acceptance/test/cutover.test.mjs | 14 | 0 |

Passing command, with host process inspection enabled:

```sh
TMPDIR=/private/tmp TMP=/private/tmp TEMP=/private/tmp node test/helpers/run.mjs test/tidy-tabs.test.mjs housekeeping/test/auto-tidy.test.mjs acceptance/test/cutover-housekeeping.test.mjs acceptance/test/cutover.test.mjs
```

The bounded runner passed 54/54 with zero failures, skips or cancellations,
exit 0, and no surviving-fixture diagnostic. `node --check acceptance/run.mjs`
and `git diff --check` passed.

The first sandbox run passed 52/54: two cutover cases rejected fixtures under the
inherited `/Users/rewt/.herdr-monitor/...` TMPDIR because the scratch paths matched
the forbidden real-home prefix. The runner's process audit was also denied by the
sandbox. Both logs are retained; the passing rerun selected `/private/tmp` and
enabled process inspection without changing product code or test assertions.

Zero `acceptance/run.mjs --skip-live` passes were used. The release harness's live
cleanup assertions await the per-candidate acceptance run. No live harness,
project housekeeping loop, model call, promotion or push was performed.

This report is copied to the requested record path and checked with `record check`
before committing the report and evidence. The final handoff command is
`TMPDIR=/private/tmp TMP=/private/tmp TEMP=/private/tmp node lanes/lane.mjs check`;
its gate will identify the final report commit. No work follows that check.
