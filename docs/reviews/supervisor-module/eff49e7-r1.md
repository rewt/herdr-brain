**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: eff49e785c21aef8f8f7b991075c4da8e0530526
Topic: supervisor-module
Round: 1
Review ID: lr-777bd0132b690e3b42425a64f9c14b9d
Base branch: main
Base commit: 33ab6b2c1f08e8064c52f3f411d75e6cffd8ae84

## Findings
- [Major] supervisor/supervisor.mjs:121 - Promotion saves the reviewed head but enqueues only the lane name. If another commit lands on that lane while it waits behind another queue job, the queue validates and fast-forwards the unreviewed tip. The current-run guard runs only when closing the record after integration, too late to protect the promotion judgment; Fix: bind the authorized run and expected lane head into the queue request, verify that binding under the promotion lock before promoting, recheck record readiness before integration, and cover a lane changed while queued.
- [Major] supervisor/supervisor.mjs:95 - STOP is checked before the blocking settle call, but settle can wait for review and then launch a correction without reading STOP again. A stop created during review therefore still permits a new worker launch, contrary to the documented cycle stop; Fix: carry the stop guard into settlement and recheck it immediately before correction dispatch, retain a resumable handoff when stopped, and cover STOP appearing during review.
- [Moderate] supervisor/supervisor.mjs:103 - An acknowledged promotion receipt is returned forever even when its queue job ended in refused. After transient promotion-lock contention or a dirty canonical checkout is resolved, promote cannot enqueue a new attempt. Enqueuing directly instead produces a new job that handle rejects because the saved receipt still binds the old job; Fix: provide an explicit retry for a confirmed refused job that rechecks readiness and binds the new job while retaining prior attempt history, preserving duplicate-success and uncertain-enqueue protections.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Live model behavior, actual operator chat clearing, and release or bch-cloak cutover are not established by the scripted evidence.

## Unverified
- Execution-time protection against queued lane changes and STOP during review, plus recovery after a refused promotion, have no inherited regression coverage; the explicit zero-command budget forbids independent mutation witnesses.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
