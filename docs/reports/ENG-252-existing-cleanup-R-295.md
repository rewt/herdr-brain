---
run: R-295
outcome: done
summary: |
  Corrected all three review findings: partial legacy launch receipts refuse live backfill, managed cleanup fixtures prove the recorded-outcome keep guard, and the launch recorder canonicalizes cwd before spawning children. The four requested offline files passed 58/58. Both previously failing native cases passed at the main snapshot and corrected head inside the host slot with native Codex and matched Node 20. Evidence and this report are committed for independent review; lane check is the final handoff command.
headline: Launch recording refuses legacy backfill and cleanup verifies why waiting workers stay
blockers: []
proposals: []
learnings:
  - A scratch archive shell can select a different Node version from the lane shell; pin Node as well as native Codex when comparing native offline acceptance cases.
artifacts:
  - 4c5c686202cc505360df87dab8399c1662522787
  - docs/reports/ENG-252-existing-cleanup-R-295.md
  - docs/reports/evidence/R-295/README.md
  - docs/reports/evidence/R-295/targeted.tap
  - docs/reports/evidence/R-295/native-main.tap
  - docs/reports/evidence/R-295/native-main-slot.json
  - docs/reports/evidence/R-295/native-head.tap
  - docs/reports/evidence/R-295/native-head-slot.json
decisions:
  - text: Refuse any incomplete recorded launch identity and permit only exact complete-receipt retries.
    category: design
    why: Completing legacy fields from a later live occupant would turn missing launch evidence into cleanup authorization.
  - text: Expose the existing keep reasons in tidy dry runs and assert them for managed waiting workers.
    category: tooling
    why: Retention must exercise the recorded-outcome guard rather than pass because a fixture name is unmanaged.
questions: []
challenges: []
---

Read the R-289 independent review and addressed its two Moderate findings and
one Minor finding in implementation commit `4c5c686202cc505360df87dab8399c1662522787`.

- `record worker` refuses a partial receipt containing any of `agent`, `pane`,
  `worker_workspace`, `terminal_id`, or `agent_session_id`. Exact complete retries
  still append no event, including after settlement. Tests cover old `set agent=
  pane=` launches, every individual partial field, late settlement/backfill,
  identity enrichment, and replacement occupants; refusals preserve the event log.
- `record-worker.mjs` resolves `--cwd` with `realpathSync` once before either
  child command. That absolute path is used for child cwd, live-worker comparison,
  and the forwarded record argument. Relative and symlink cwd tests pass.
- The release cleanup fixtures now launch as `lane-cleanup-*` in linked lane
  workspaces. Before cleanup, the harness verifies their recorded launch occupants,
  then asserts the actual installed dry-run keep reason is `no recorded report
  for <agent>`. The existing tab/pane retention assertions remain `[false, true,
  true]` for done, blocked, and needs_human. The switched-copy offline test verifies
  those keep reasons as well as the housekeeping close/keep selection, with no
  native tab mutation. Tidy prints its existing keep reasons only in dry runs.

Verification:

| Requested file | Passed | Failed |
| --- | ---: | ---: |
| dispatch/test/record-worker.test.mjs | 6 | 0 |
| acceptance/test/cutover-housekeeping.test.mjs | 1 | 0 |
| acceptance/test/cutover.test.mjs | 14 | 0 |
| dispatch/test/dispatch.test.mjs | 37 | 0 |

The bounded runner completed with 58 passes, no skips/cancellations, exit 0,
and no surviving-fixture diagnostic. Syntax validation of `acceptance/run.mjs`
and `git diff --check` also passed.

The native comparisons use an unmodified archive of main at
`62171eadc9a99b669219ee275feb3a0578a9b58d` and the correction commit above.
Each runs only the concurrent-worker discovery case and native validation/promotion
case through the host test slot with `MONITOR_TEST_SLOT_WAIT_SECONDS=3600` and
`codex` resolving to the native standalone binary. Main and head each passed 2/2,
with six other cases excluded by name and exit 0. Slot receipts prove acquisition;
both original failures are absent under these conditions. This supports the
controlled result, rather than R-289's earlier inference from failure logs alone.
The existing follow-on items ENG-254 and ENG-255 are not independently resolved
or closed by this report.

The initial main shell selected Node 26.4.0 and also passed both cases. The lane
selected Node 20.19.4, so main was repeated with Node 20 explicitly pinned to
match; both main results are retained. Commands, native executable selection,
queued attempts cancelled before acquisition, and runtime provenance are in the
evidence README. Main advanced after the archive was taken; comparison evidence
remains tied to the stated snapshot.

No release acceptance harness pass, including `--skip-live`, was used. The live
cleanup assertions await the per-candidate release harness and independent
review. No project housekeeping loop or model call was started. The report is
copied to the requested R-295 record path and checked before its lane commit.
The final command is `node lanes/lane.mjs check`, after the report/evidence commit,
so its gate identifies the final clean head.
