**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ad3ff9165618ce0b7cab28ec8e2f191764a159fc
Topic: settle
Round: 2
Review ID: lr-a56687d0a73ec59d43389f8d92d33ecb
Base branch: main
Base commit: 06da3b899ecc2c383bcab2a122091b08d8d04c33

## Findings
- [Major] settle/settle.mjs:228 - Settling an older, already ingested done report can erase a newer run's blocked or needs\_human outcome on the same item. Re-ingestion is a no-op, but this unconditional reopen clears the current item outcome. The later reported run is excluded from activeWork, so the item becomes ready and settlement of the older run can return promotable or dispatch another correction despite the newer escalation; Fix: detect superseding runs and outcomes before changing the item, hand stale reports to the supervisor, and reopen only when the current outcome belongs to the run being settled. Add coverage with an ingested done report followed by an ingested needs\_human or blocked report before settling the older run.
- [Moderate] settle/settle.mjs:73 - A blocker added after correction dispatch has recorded its run is ignored on an incomplete dispatch retry. The record derives active before checking blockers whenever a run is open, and correctionBlocker then excludes the recovery run from activeWork. For example, after watcher startup fails, adding an unresolved blocker and retrying settle can resume dispatch and send the worker prompt instead of handing off; Fix: evaluate unresolved blocker links and relevant outcomes independently of the active status when excluding a recovery run, and cover watcher startup failure followed by a new blocker and retry with no worker prompt.

## Re-executed
```json
[]
```

## Non-claims
- The supplied npm test gate with exit code zero is inherited evidence only. This reviewer executed no tests and observed no negative-control or mutation witness.
- The offline settlement fixture scripts Herdr and model transport and the claim verdict. Its source does not establish live independent review quality or real pane transport.
- The findings are supported by source inspection; their runtime scenarios were not executed during this review.

## Unverified
- The supplemental brief contains no unambiguous Review run budget authorizing exact commands with finite counts. The build, test, prepare, install, and check budget was zero, and none of those commands was executed.
- Runtime reproduction and regression coverage for the two reported record-state scenarios remain unverified under the zero-command budget.
- The supervisor's next real report remains an outstanding acceptance canary in the committed implementation reports. Live report settlement and lifecycle actions were outside this review's authority.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
