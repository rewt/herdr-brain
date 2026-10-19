**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: b8ee6b2118d26b72566669b27e5883ad9303f03a
Topic: open-batch-guard
Round: 1
Review ID: lr-4edcbd4b0b8d2b1cd8951615bd35e929
Base branch: main
Base commit: ad97e531073dd31e4e6cc885773415a4b55e5b40

## Findings
- [Major] lib/record-guard.mjs:107 - A promoted queue result is released only by reconciliation.state complete or a promotion.reconciled event naming its batch or exact run head, so every promoted result without a reconciliation marker stays an open member forever: the legacy close path at supervisor/supervisor.mjs:109 (taken exactly when result.reconciliation is absent) closes the item but never releases it, and the live project queue already holds 67 such historical promoted results (runs R-211 through R-376, none covered by any promotion.reconciled batch or heads entry), so any later note, reopen, child creation, review-child or blocker write touching those landed items exits 3 claiming an open promotion batch, contradicting the unrelated-items-unaffected acceptance; Fix: treat a promoted result as open only while reconciliation.state is pending, or, when no reconciliation marker exists, only until its item is closed with that run as the current run (the legacy completion), and add a fixture asserting a note after legacy close and on a historical promoted result without reconciliation is accepted.
- [Moderate] lib/record-guard.mjs:148 - The complete-batch exemption covers only members listed in the completion plan, but hits also include other open members reached through parent expansion or blockersOf, so the train's own complete-batch is refused with exit 3 whenever a completing item is the parent, linked blocker or review child of another queued or interrupted member (for example a dependent item queued behind its blocker), which turns the batch into reconciliation pending and contradicts the ask that the train's completion and reconciliation writes are exempt; Fix: when the validated completion authority matches identity and record, exempt the whole completion transaction (or at least every hit that is not itself a directly targeted member outside the plan), and add a fixture with a pending dependent member blocked by a completing member.
- [Minor] lib/record-guard.mjs:151 - ORG\_GUARD\_OVERRIDE is compared against each hit member id individually, so a write that touches members of two different batches or jobs (for example via a parent plus a blocker) can never be overridden even after inspection, leaving no recovery path short of editing the queue; Fix: accept a comma-separated set of batch or job ids, require it to equal the set of hit ids, and record that set in the audit event.
- [Minor] lib/record-guard.mjs:23 - The fleet binding check compares gitProject identity and canonical checkout to the fleet entry with exact string equality although fleet validation accepts any absolute path and lib/fleet.mjs compares with realpath elsewhere, so a fleet entry spelled through a symlink or with a trailing slash makes every item write on that record fail closed with stale record project binding; Fix: compare through realpath (the fleet canonical helper) and add a fleet fixture whose configured checkout is a symlinked path.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/record-guard.test.mjs
- Test evidence not re-executed: promote/test/completion.test.mjs
- The worker reports three promote/test/completion.test.mjs cases still failing (legacy recovery missing member coverage, legacy recovery missing superseded coverage, prepared replacement recovery without telemetry failure) attributed to native process-source permission refusals; whether these are environment-only or caused by the new guard or the record lock now held across enqueue was not established, and the supplied validation log contains no receipt for the captured tree.
- The other suites the worker listed (test/flow.test.mjs, test/session-release.test.mjs, dispatch/test/session-bind.test.mjs, test/fleet.test.mjs, test/tier-plan.test.mjs) had failures in the worker initial run that were only partly re-run by test name; their state at the captured head is unverified.
- Lock ordering of the new record lock held around the queue transaction in enqueue was checked by reading only the queue transaction callbacks in promote/promote.mjs; no runtime contention or timeout behaviour under the drain worker was exercised.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
