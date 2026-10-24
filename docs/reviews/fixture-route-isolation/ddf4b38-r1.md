**PASS**
Schema: lane-review/v1
Reviewed commit: ddf4b3817e866368f6805a64ddf94cd6e60901fe
Topic: fixture-route-isolation
Round: 1
Review ID: lr-f382210fcea5cc8bdc8f3d572cc1ba2b
Base branch: main
Base commit: 167d15eeef4c2a573d9a07cb6c778667a20fba88

## Findings
None

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion-tier execution is deferred to the promotion queue; this review claims no promotion-tier result.

## Unverified
- Test evidence not re-executed: promote/test/guard.test.mjs.
- Test evidence not re-executed: acceptance/test/default-cycle.test.mjs.
- Test evidence not re-executed: dispatch/test/dispatch-admission.test.mjs.
- Test evidence not re-executed: dispatch/test/dispatch-recovery.test.mjs.
- Test evidence not re-executed: dispatch/test/dispatch-session.test.mjs.
- Test evidence not re-executed: dispatch/test/session-cap.test.mjs.
- Test evidence not re-executed: housekeeping/test/housekeeping.test.mjs.
- Test evidence not re-executed: lanes/test/identity-launch.test.mjs.
- Test evidence not re-executed: lanes/test/lane.test.mjs.
- Test evidence not re-executed: promote/test/promote.test.mjs.
- Test evidence not re-executed: promote/test/workflow-train.test.mjs.
- Test evidence not re-executed: settle/test/round-cap.test.mjs.
- Test evidence not re-executed: settle/test/settle.test.mjs.
- Test evidence not re-executed: supervisor/test/autopilot.test.mjs.
- Test evidence not re-executed: supervisor/test/chats.test.mjs.
- Test evidence not re-executed: test-slot/test/gate-profile.test.mjs.
- Test evidence not re-executed: test/adopt-worktrees.test.mjs.
- Test evidence not re-executed: test/adopt.test.mjs.
- Test evidence not re-executed: test/closeout.test.mjs.
- Test evidence not re-executed: test/compat.test.mjs.
- Test evidence not re-executed: test/config-home.test.mjs.
- Test evidence not re-executed: test/fleet.test.mjs.
- Test evidence not re-executed: test/flow.test.mjs.
- Test evidence not re-executed: test/lane-removal-disposable.test.mjs.
- Test evidence not re-executed: test/lane-removal-protection.test.mjs.
- Test evidence not re-executed: test/lane-removal.test.mjs.
- Test evidence not re-executed: test/project-summary.test.mjs.
- Test evidence not re-executed: test/retire-archive.test.mjs.
- Test evidence not re-executed: test/retire-status.test.mjs.
- Test evidence not re-executed: test/retire-sweep.test.mjs.
- Test evidence not re-executed: test/scratch-sweep.test.mjs.
- Test evidence not re-executed: test/session-lifecycle.test.mjs.
- Test evidence not re-executed: test/session-reconciler.test.mjs.
- Test evidence not re-executed: test/session-release.test.mjs.
- Test evidence not re-executed: test/sessions.test.mjs.
- Test evidence not re-executed: test/setup-apply.test.mjs.
- Test evidence not re-executed: test/setup.test.mjs.
- Test evidence not re-executed: settle/test/config.test.mjs.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
