# Report ingest validation evidence

Run R-304. Review briefs and settlement results carry a `report-ingest/v1`
receipt with the supplied report path, immutable ingested path, SHA-256 and
passed validation result. The receipt is reconstructed from the record and
matching report bytes before review, before the readiness decision and when
returning saved readiness. Ingest uses the same report validation as
`record check`; it proves validity of these bytes rather than historical worker
command execution or commit timing.

Settle recognizes the exact scoped record-check validation entry and the exact
legacy entry about the absent in-repository receipt, including lane review's
escaped public rendering. It retains the independent public review. Other
non-test claims, added claims, stale bytes and uncovered test files retain their
existing refusal or escalation paths.

Focused offline command:

```sh
node test/helpers/run.mjs settle/test/report-evidence.test.mjs settle/test/test-evidence.test.mjs settle/test/settle.test.mjs settle/test/record-safety.test.mjs settle/test/record-recovery.test.mjs settle/test/round-cap.test.mjs supervisor/test/autopilot.test.mjs
```

`focused.log` records 170 passed, zero failed, cancelled or skipped, with exit 0.
The command ran with host process-inspection permissions after a sandboxed run
hit process lookup denials and a filesystem-watch error in existing fixtures.
`sandbox-focused.log` retains that run (158 passed, 12 failed). The bounded
runner stopped its group; a host lookup confirmed its reported survivor PID
82405 had exited before the run's evidence was finalized.

Coverage includes new and previously ingested
reports, changed source files, missing or mismatched receipts, changed snapshot
and immutable bytes, saved readiness, exact claim scoping, deferred test coverage,
record readiness recovery, correction dispatch and review round caps. Autopilot
cases use the real handle and promotion queue with scripted offline transport:
both record-check entry forms plus deferred tests land and close the item, the
required test runs once, and the supervisor receives no routine wake. An unrelated
non-test claim still wakes the supervisor without enqueuing.

The implementation/evidence commit precedes the checked report commit. The final
lane fast check follows that report commit; `.lane/gate.json` binds its result to
the final HEAD.
