---
run: R-110
outcome: done
summary: |
  Settle honours a tracked project review-round cap and a recorded per-item override.
  Once the cap is reached, Moderate/Minor-only NEEDS-WORK returns the findings and
  reviewed head to the supervisor without dispatch. Major, FAIL, red validation and
  unresolved evidence retain their correction or escalation paths. The supervisor
  can explicitly accept findings for promotion or request another watched fix round.
  Offline integration tests pass; implementation and this report are committed on
  the lane for the supervisor to review. The final lane gate follows the report commit.
headline: Settle pauses capped review rounds for the supervisor to decide on remaining findings
blockers: []
proposals: []
learnings:
  - Completed settle reviews count once per recorded run across correction runs on the item, using report-hash-bound receipts in the same Git common-directory identity.
  - The existing settle round counter names reviewer retries within one run; it is separate from the new review_policy round count. Advisory rounds still means total worker runs.
  - Item meta.settle_review_round_cap overrides tracked settle.review_round_cap; zero disables the cap. Each intake snapshots the cap so retries retain their original policy.
artifacts:
  - "Commit: Honour settle review-round caps and supervisor findings decisions"
  - "Commit: Report settle review-round cap completion for run R-110"
  - "Branch: lane/settle-cap"
  - "settle/settle.mjs; settle/README.md; settle/test/round-cap.test.mjs; settle/test/fixture.mjs"
  - "supervisor/supervisor.mjs; supervisor/context.mjs; supervisor/PROTOCOL.md; supervisor/README.md; supervisor/test/supervisor.test.mjs"
  - "Baseline npm test: 611 passed, 11 skipped, 0 failed (622 tests)."
  - "Post-change npm test with host access: 623 passed, 11 skipped, 0 failed (634 tests); /tmp/eng96-host-npm-test.log."
  - "Focused cap, supervisor promotion/correction, and decision-response recovery cases passed before the full suite."
  - "record check docs/reports/ENG-96-settle-round-cap-20261002.md"
  - "Final command: node lanes/lane.mjs check; its receipt is .lane/gate.json, pinning the committed implementation and report."
decisions:
  - text: Keep the default unlimited and use zero to explicitly disable an inherited cap.
    category: design
    why: Existing projects retain their current behaviour until the project or supervisor selects a cap; worker-run budgets remain advisory.
  - text: Count completed independent reviews once per reported run and record the effective cap, source, count, prior runs and settlement decision.
    category: design
    why: Correction runs are separate worker runs, while uncertain reviewer retries should not exhaust the cap. Receipt hashes and Git identity bind the count to actual reviews.
  - text: Require explicit acceptance of capped findings for promotion, or an explicit request for another correction, and retain all existing readiness gates.
    category: design
    why: Moderate/Minor findings need supervisor judgment without allowing the cap to waive Major, FAIL, validation, evidence, head, blocker, concurrency or promotion authority checks.
  - text: Reconcile missing or lost settlement-decision write responses against the exact recorded decision note on retry.
    category: design
    why: A saved terminal receipt must not strand an unrecorded cap decision or repeat review, dispatch or a successful note write.
questions: []
challenges:
  - "The restricted-shell post-change suite had 19 discovery/native sandbox failures because macOS refused sandbox_apply with Operation not permitted. The authorized host-access rerun passed all 634 tests; no sandbox behaviour or unrelated discovery code was changed."
---

The cap is configured through `settle.review_round_cap` in tracked `.lane.json`,
`record set ITEM meta.settle_review_round_cap=N`, or initial settle/supervisor
`handle --review-round-cap N`, which records the item override. No shared config
was edited for this run.

At or above the cap, `promotable_with_findings` includes the findings, compact
handoff, reviewed source commit, head containing the committed public review,
validation receipt and cap policy. Both initial and final validation must be
green. Unparsed finding severity and unresolved Unverified entries receive a
handoff. Cached readiness checks the current report hash, run ownership, exact
heads, clean worktrees and record readiness again.

Supervisor `handle` passes the result through and the cold start suggests
`decide_findings`. `promote RUN --accept-findings --why REASON --role supervisor`
records the accepted findings and policy, then uses the existing queue with its
exact-head/current-run/fast-forward gates. Follow-up items remain the supervisor's
choice. `handle RUN --retry --fix-findings --role supervisor` records the choice
to continue, preserves the original capped result, and dispatches another fix
without reviewing again. STOP retains a resumable correction; repeated commands
adopt the existing dispatch receipt.

Offline cases exercise the cap not reached, the boundary reached across fix
runs, Moderate and Minor findings, per-item override persistence and zero,
Major/FAIL/red validation, unparsed/unverified evidence, uncertain review retries,
stale heads and superseding runs, STOP recovery, failed/lost decision writes,
supervisor result forwarding and both supervisor decisions. Promotion acceptance
runs the real queue, Git integration and guarded record completion in a temporary
project with scripted transport. Tests set their own actors and bound subprocesses;
no model or real pane is called.

No push, publication, release, shared lane/config write, bch-cloak write or live
pane mutation was performed. Main remained at the lane's base through the report
preparation; it is checked again before the final gate.
