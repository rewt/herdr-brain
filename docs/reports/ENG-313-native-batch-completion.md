---
run: R-370
outcome: done
summary: |
  Implemented native queue whole-batch reconciliation before original lane cleanup in lane/batch-reconciliation.
  Completed trains retain original fingerprints and gate evidence; failed record completion preserves all integrated lanes and resumes bookkeeping without repeating host admission, validation or integration.
  Historical exclusions account for earlier outcomes without mutating newer excluded work. Late notices verify the durable completion marker and preserve reopened or superseded work.
  The contained offline runner passed 181 compatibility and completion checks; two additional authority regressions passed. This is worker completion: independent review and promotion remain pending, and the installed runtime has not changed.
headline: Native batch completion is ready for independent review
blockers: []
proposals: []
learnings: []
artifacts:
  - lane/batch-reconciliation
  - promote/completion.mjs
  - promote/evidence.mjs
  - promote/promote.mjs
  - promote/train.mjs
  - promote/guard.mjs
  - lib/completion.mjs
  - supervisor/supervisor.mjs
  - supervisor/PROMOTION-COMPLETION.md
  - docs/reports/evidence/ENG-313/offline-completion.tap
  - docs/reports/evidence/ENG-313/authority-guards.tap
decisions: []
questions: []
challenges: []
---

This implements the completion recommendation from the Astra report under the
existing ENG-313 item, authorized by the operator's request to start taking action
on the recommendations. The isolated lane is
`/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-batch-reconciliation`.
The initial setup run R-369 was explicitly abandoned before implementation because
its requested worktree location was unsupported; it remains preserved in the record.

The native train captures record bindings before any gate. Queue completion verifies
the successful attempts, integrated ancestry and preserved reviewed diffs, then
invokes the existing record CLI transaction once for all included members. Only
an acknowledged completion permits velocity notes, tab cleanup and original lane
closure. Keeping telemetry after reconciliation matters because a velocity note
changes the original fingerprint and would otherwise obstruct a failed transaction's
exact retry.

A bisected batch retains each successful gate's original proof in the completion
receipt and records every rejected member with a historical reason and next action.
Historical accounting cannot abandon runs, add blockers or change outcomes. An
excluded prerequisite that is still open cannot satisfy included completion.
Current-state exclusion mutations through the manual adapter retain their original
guards. Native admission continues to reject unaccounted open runs; it never
silently infers supersession. Existing explicit supersession semantics remain in
the shared guarded transaction.

Recovery uses the completed train and immutable `train.json.record.json`, retaining
original fingerprints. A newer included run, changed blocker, missing member,
changed evidence or a legacy successful train without preparation refuses cleanup.
Recovery notices have stable identities per message, distinct from the completed
reconciliation update; their promotion request identity does not change. A lost
record acknowledgement replays the same receipt without duplicate completion events.

The previous read-only train proof function is extracted unchanged into
`promote/evidence.mjs` and re-exported from its original module to avoid a circular
import. Custom lane CLI execution remains on its existing path. Git-only queues
without an organizational record continue to make no record-completion claim.

Verification (offline, with the repository's fixture and containment runner):

```sh
node test/helpers/run.mjs promote/test/completion.test.mjs supervisor/test/reconcile.test.mjs supervisor/test/supervisor.test.mjs promote/test/train.test.mjs supervisor/test/autopilot.test.mjs
# 181 passed, 0 failed
node test/helpers/run.mjs '--test-name-pattern=native completion refuses' promote/test/completion.test.mjs
# 2 passed, 0 failed
```

The receipts are stored beside this report in `docs/reports/evidence/ENG-313/`.
Fault injection covers record refusal, a lost acknowledgement, stale included work,
missing membership and newer excluded work. Existing tests cover clean Git/rebase,
fast-forward, validation, STOP, interruption, bisection, delayed notices, independent
review intake and model-free continuation. No full promotion or release suite was
run in the lane; no live acceptance or additional model session was launched.

Next owner/action: the canonical project supervisor performs independent settle
review of R-370, then admits the reviewed lane to the normal promotion queue under
the operator's implementation authorization. Use the existing workflow; do not
install or activate a release, change BCH execution ownership, redirect notices or
reactivate disabled entry integration as part of this patch. Worker-reported done
is not an accepted or promoted deliverable. The remaining Astra recommendations
require their own concrete changes and adoption evidence.
