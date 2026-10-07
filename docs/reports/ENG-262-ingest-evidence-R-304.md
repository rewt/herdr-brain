---
run: R-304
outcome: done
summary: |
  Added matching ingest validation receipts to independent review briefs and settlement results, including the supplied and immutable report paths, SHA-256 and passed validation result. Settle rechecks those bytes and discharges only exact scoped record-check validation entries; deferred tests retain the bound promotion path and other non-test claims still escalate.
  All 170 focused offline tests passed with host process-inspection permissions, including real autopilot promotion and item closure for both canonical and legacy record-check entries. Implementation and evidence are committed as e43f5c3. This checked report is committed next, followed by the required final lane fast check.
headline: Ingest receipts now verify report checks during independent review
blockers: []
proposals: []
learnings: []
artifacts:
  - "Implementation and evidence commit: e43f5c3"
  - "Branch: lane/ingest-evidence"
  - settle/report-evidence.mjs
  - docs/evidence/ENG-262/README.md
  - docs/evidence/ENG-262/focused.log
  - docs/evidence/ENG-262/sandbox-focused.log
  - docs/reports/ENG-262-ingest-evidence-R-304.md
  - /Users/rewt/development/rewt/.org/runs/R-304/report.md
  - .lane/gate.json (final lane fast-check receipt)
decisions: []
questions: []
challenges: []
---

Review briefs supply a `report-ingest/v1` receipt. It derives from the requested
run's record receipt and exact matching bytes in the captured report, brief body
and immutable ingested file. Existing intake still validates through the record
CLI. Ingest uses the same report validation as `record check`; the receipt proves
report validity, not historical worker command execution or commit timing.
Saved readiness reconstructs and checks the receipt before returning it.

The canonical scoped Unverified entry and the exact legacy entry about the absent
in-repository receipt are recognized, including lane review's escaped backticks.
The public independent review is preserved. Appended claims, unrelated non-test
claims, changed or missing evidence and uncovered test files retain their
refusal or escalation paths. No dependencies, model calls, event types, stored
record status or promotion authority were added.

Focused offline verification:

```sh
node test/helpers/run.mjs settle/test/report-evidence.test.mjs settle/test/test-evidence.test.mjs settle/test/settle.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs settle/test/round-cap.test.mjs supervisor/test/autopilot.test.mjs
```

Result: 170 passed, zero failed, cancelled or skipped; exit 0. Tests cover new and
previous ingestion, immutable bytes despite later source edits, hash mismatches,
missing/abandoned/wrong-run receipts, readiness retries, scoped deferred tests,
unrelated claims, correction recovery and round caps. Real offline autopilot
cases land and close the item with each supported record-check entry plus
deferred tests; the required test runs once without a routine supervisor wake.
A separate real-handle case retains the supervisor handoff for an unrelated claim.

The sandboxed verification hit process-inspection denials and a filesystem-watch
error in existing fixtures (158 passed, 12 failed). The same seven files then
passed with host permissions. Both logs are retained. The bounded sandbox
runner stopped its group; host inspection confirmed its reported survivor PID
82405 had exited. Captured logs have trailing spaces trimmed for Git's whitespace
check. `git diff --cached --check` passed before the implementation commit.

The final lane fast check follows this report's validation and commit;
`.lane/gate.json` supplies the exact final-HEAD result.
