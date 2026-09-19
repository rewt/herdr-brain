# Identity coordinator specification report

Date: 2026-09-13. Topic: `identity-coordinator-spec`. Round 1 returned
NEEDS-WORK at `dcf44a1`; this correction is for independent re-review, not an
adopted protocol, implemented console behavior, or live pilot result.

## Delivered

- `openspec/changes/identity-coordinator/` contains a proposal, authority and
  report design, two proposed capability deltas, an indexed sequence, and three
  bounded briefs: manual adoption, CLI read-model, and later console detail.
- `docs/identity-coordinator-pilot.md` and its measurement template prepare a
  one-identity/two-project manual comparison. Selection is deliberately pending
  operator input. The manual pilot can precede console extensions after protocol
  review and project selection.
- No runtime, dependency, current OpenSpec capability, supervisor release,
  identity/account, inventory/frame lane, or `docs/reviews/` file changed.

## Ownership and evidence decision

The coordinator owns the explicit canonical-project roster, daily outcomes,
priority/dependency order and finite budgets. Every project has exactly one
integration owner. A project supervisor, when appointed for sustained/multi-lane
work, fills that role and owns detailed evidence/acceptance. For small work the
coordinator can be the integration owner and assign an engineer directly. The
coordinator consumes the supervisor's compact result instead of repeating its
detailed review. Project-required independent review and the existing closeout
protocol remain separate checks.

Assignments carry stable IDs/revisions and concise acceptance, budget, owner,
milestone, blocker/decision, evidence and next action. Reports carry report IDs,
sequences and changed results. Duplicate/conflicting/out-of-order, failed-delivery,
unavailable-owner, stale-handoff and resumption paths are explicitly held for
primary-evidence reconciliation, without automatic retry or role reassignment.
Git author, GitHub credential, Codex profile, and development-root grouping are
separate from canonical repository and coordination authority. A root-only request
cannot perform lane lifecycle work.

## Read-only console audit

`git show` of `lane/board-inventory` at `1fdd8f9` and `lane/board-frame` at
`9e8c8f9` was read-only; neither branch was edited or rebased. Inventory's schema-v1
row already exposes stable `row_id`, `repo_id`/`root_id`, goal/provenance, brief,
role, lane report/review, gate, status/staleness, and scope/coverage. Its report
field is not the latest coordinator delta; role/name is not the integration owner.
Frame attention is based on technical status/gate/deadline/review/freshness; it has
no coordination blocker or decision. Frame is explicitly repository-scoped until
later integration.

The proposed opt-in read-model is a distinct later CLI slice, after promoted
inventory and bounded sampling. It accepts one explicit local snapshot, verifies
canonical project and stable session-row joins, and publishes only source-labeled
nullable owner/assignment/latest-delta evidence. Duplicates or absent fields stay
unknown. A later UI slice follows frame plus complete details and consumes CLI data
only; it separates coordination from technical attention. Sampling's concurrency,
freshness and coverage prerequisites stay with `board-sampling`; complete details
stay with `board-details`; idea CLI/composer remain separate explicit-launch work.
No display datum can dispatch, focus, validate, review, promote, close or push.

## Round 1 correction scope

The preserved public review at
`docs/reviews/identity-coordinator-spec/dcf44a1-r1.md` records six findings.
This lane does not edit that review or reinterpret its NEEDS-WORK verdict.

1. Stale saved evidence now has a same-owner reconciliation path; only unavailable,
   replaced, or unauthorized ownership invokes explicit successor transfer.
2. The CLI read-model brief refuses interactive `--coordination` until the later
   UI brief forwards the selected source through `lane.mjs`, `board/args.mjs`,
   `board/app.mjs`, and `board/cli-client.mjs` on initial watch, refresh, and
   reconnect. An injected process-boundary fixture is required; actions remain
   source-free and non-replayed.
3. The read-only snapshot now has a 1 MiB raw-byte cap, regular-file/no-symlink
   rule, finite project/assignment/link and text limits, explicit required and
   nullable types, bounded read, and localized malformed/oversized refusal.
4. Successful read time is distinct from HEAD/revision applicability. Old readable
   content with mismatched evidence is historical; unchanged matching content stays
   applicable without heartbeat traffic. A report pointer never proves acceptance.
5. Assignment milestones and delta results are labeled planned and reported;
   acceptance is unknown without separate integration-owner evidence. The pilot
   template now marks candidate milestones accepted only after that check.
6. Only the projection and bounded-read requirement blocks sync with a future CLI
   implementation. Interactive forwarding and separate attention sync only with
   the later UI implementation. No current capability is synced in this lane.

The inspected current launcher forwards only `--repo`, and the app/client create
their own watch arguments. The briefs explicitly allocate this missing route;
the current console remains unchanged. No new model polling, scheduling, lease,
metadata authority, lifecycle replay, or console feature is claimed.

## Round 1 verification addendum

After inventory's final gate released the test slot, this lane's serial `npm test`
passed 209/209 with zero failures/skips in 309.445 seconds. Strict repository-wide
OpenSpec validation passed 21/21 with concurrency one. These exercise unchanged
product behavior and validate proposal structure; no product failing test or prose
mirror-image negative control was appropriate. The final source-CLI post-commit
gate, complete-diff/public-safety checks, and review-file preservation are
reported at handoff. No live UI forwarding, source parsing, or pilot acceptance
was tested because those remain future work.

## Verification and limits

Before edits, `npm test` passed 209/209, zero failures/skips, in 309.880 seconds
after a clear process probe. Another suite occupied the slot during initial reading;
this lane did not start a competing test. The operator later reserved inventory's
focused failure-first slot; our baseline had already completed and we ran no test
while that slot was reserved. No behavior changed, so no prose mirror-image test or
behavior negative control was added. Focused strict OpenSpec validation passed for
`identity-coordinator`; repository-wide strict validation passed 21/21, concurrency
one. Final whitespace/public-safety and post-commit gate evidence are recorded in
the handoff conversation because a post-commit gate cannot be committed without
becoming stale.

Environment: Node.js 20.19.4, Git 2.54.0, OpenSpec 1.6.0. No live report delivery,
project selection, supervisor adoption, pilot measurement, console implementation,
alternate-host verification, independent review, promotion, close, push, or
publication occurred. No pricing, usage, or savings estimate is asserted.
