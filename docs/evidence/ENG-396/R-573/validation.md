# R-573 correction evidence

This addresses only the seven findings in
`docs/reviews/green-cohort/489ccc8-r1.md`, under the round-9 ask.
The implementation candidate is `7b89cc98`; it is rebased onto
`6e77270905ad0a6f3e01a82e317cc3c53d0c3a52` main, including the retirement
changes that landed during this run. Main's lane-removal and retirement modules
and lane documentation are retained. This lane does not enable the cohort.

| Finding | Correction and witness |
| --- | --- |
| Train evidence mismatch | `verifyTrainResult` compares the job with saved `requiredTests`, falling back to deferred `test_evidence.files` for legacy requests. Direct replayed-Git proof fixtures test both forms and missing component requirements. The supervisor fixture queues both inputs, forces replay onto advanced main, runs both checks, and handles the completed train receipt. |
| Interim reset on digest refresh | The first cohort activation note's event sequence is `activationId`; its timestamp is `activatedAt`. A new reviewed digest needs a note on the same item but retains the original event identity and expiry. The fixture changes a pinned configuration module, commits refreshed pins, requires fresh digest evidence, admits the refreshed candidate and checks the original exact expiry boundary. |
| Real-main evidence | The probe reads main's boundary blobs, applies the explicit ordinary-bootstrap diff and uses committed manifest bytes. It binds the ten declared consumers to the committed owner confirmation/inventory hashes. Stale pins refuse after unrelated main changes; a foreign or nested release snapshot cannot supply canonical Git identity. A fresh canonical `checkDeployment` is required before activation notes. |
| Lost retry requirements | Bare recovery and confirmed refused/timed-out retries inherit all earlier attempts' required tests. Explicit removal refuses. Separate fixtures cover all three paths. |
| Promotion authority | Roles derive from the known import/launch closures of authority entries, selectors and test helpers, without traversing ordinary test bodies or the candidate component. Both `lanes/routes.mjs` and `lanes/lane.mjs` are promotion authority. Unknown edges grant no containment authority. |
| BCH root instruction | `AGENTS.md` now states the owner-confirmed installed-current default and explicit manual/reuse alternate roots, cites the evidence and preserves the rest of the paragraph. |
| Cohort schema documentation | The README accepts `clean-pass` and `green-pass`, with the `green` key only under `green-pass`, and links the binding contract. |

`manifest-generation.json` records the refreshed manifest digest, 299 boundary
inputs, 20 unchanged external descriptors and the successful deployment check
against this lane's source. Generation used Node 20.19.4 with empty execArgv,
matching the intended running launcher. The canonical pre-activation check still
belongs to the supervisor; a lane check does not authorize activation.

## Validation

The requested combined check uses Node 20.19.4 first in PATH and
`node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000` with:

- `supervisor/test/green-pass.test.mjs`
- `supervisor/test/autopilot.test.mjs`
- `supervisor/test/supervisor.test.mjs`
- `promote/test/evidence.test.mjs`
- `supervisor/test/green-main.test.mjs`

`required-tests.json` retains the command, exact implementation/main/test-source
bindings and lossless stdout/stderr. No baseline, npm test, promotion/lanes suite,
release or live acceptance runs were started. An initial evidence-capture
preflight referenced a nonexistent separate clean-pass test file and stopped
before spawning a runner; clean-pass cases reside in the autopilot test file.

The combined run completed once: **391 tests, 369 passed, 22 failed, zero
cancellations or skips**, exit 1, in 445.5 seconds. All green-pass containment,
activation, committed-main probe and direct train-proof cases passed. The
supervisor component-test forwarding case and refused-retry requirement case
also passed. The new end-to-end replay, not-queued recovery and timeout-retry
fixtures failed on process-ownership checks before full confirmation; they are
not claimed as passed. No suite was repeated and no source changed after the run.

The failures are named below; full original TAP blocks are in `failures.json`.
A process-ownership refusal is an observed validation limit, consistent with the
native process-source restrictions seen in this run. It is not proof that every
failure has a sandbox cause. Review-transport and unclassified assertions retain
their own unresolved attribution. No native permissions were changed or bypassed.

| Failed test | Observed diagnostic |
| --- | --- |
| promoted queue notice handles its bound run and a closed item is a no-op | assertion without conclusive cause |
| completion after an interrupted promotion has its own receipt and closes once | fixture watcher process ownership unconfirmed |
| a delayed report can notify an awaited landing without a plan step and deduplicates the queue notice | fixture watcher process ownership unconfirmed |
| actual handle and promotion commands return findings to the supervisor offline | offline independent-review transport did not complete |
| automatic PASS reaches the real queue, lands and closes with one awaited wake | explicit native process-source refusal |
| real CLIs retry an exit-one base-moved refusal with the saved request and land once | fixture watcher process ownership unconfirmed |
| a worker exiting after autopilot precheck leaves a confirmed no-op that bare promotion can recover | explicit native process-source refusal; fixture watcher process ownership unconfirmed |
| automatic queue refuses an engineer child filed during handle after report intake | fixture watcher process ownership unconfirmed |
| automatic queue rechecks kill-switch at final integration | fixture watcher process ownership unconfirmed |
| automatic queue rechecks pause at final integration | explicit native process-source refusal |
| supervisor handle exposes correction memory wait before pressure clears | fixture inbox process ownership unconfirmed |
| handle explicitly sends capped findings back once and adopts its saved correction | fixture watcher process ownership unconfirmed |
| green-pass promotion replays deferred and component checks and verifies train completion | fixture watcher process ownership unconfirmed |
| bare promotion retains required tests after not-queued and refuses explicit removal | fixture watcher process ownership unconfirmed |
| bare promotion retains required tests after timeout and refuses explicit removal | fixture watcher process ownership unconfirmed |
| STOP arriving during review retains a resumable correction without launching another worker | fixture watcher process ownership unconfirmed |
| supervisor binds head and run into the queue and retries confirmed refusals with history | fixture watcher process ownership unconfirmed |
| bound promotion rechecks queued runs and record changes during validation before integration | fixture watcher process ownership unconfirmed |
| late final reports recover completed promotion after lane closure and retain binding, integration and current-run guards | offline independent-review transport did not complete |
| late original and correction notices after lane removal preserve promotion guards and never replay settlement | fixture watcher process ownership unconfirmed |
| refusal retry cannot authorize a new unreviewed head or replay an interrupted attempt | fixture watcher process ownership unconfirmed |
| supervisor entry and final notices carry the unconfigured cycle through actual promotion | offline independent-review transport did not complete |

`main-controls.json` is losslessly extracted from the passing committed-main
diagnostic: 299 actual main boundary inputs were read; 291 manifest boundary
inputs came unchanged from main. The exact committed manifest digest is
`f8c91d26092f54b684e2ecf2d30a63bd70238686ebee6806b3869bd54bb11663`.
The renderer qualifies; BCH/authority, selectors, manifest, ordinary boundary,
new edge, missing input and foreign project controls all refuse.

## Scope limit discovered by inspection

`promote/guard.mjs:62` still requires `settings.cohort === 'clean-pass'` for
`existingWorker` jobs, and line 72 still applies `cleanPassScope`. The production
autopilot passes `--existing-worker` for green promotions too. This is an existing
enablement blocker outside the seven-finding correction scope, not a newly run
live experiment. The new supervisor train fixture exercises the ordinary
authorized enqueue/readiness seam, not that native-worker guard. A follow-up must
bind and recheck reviewed green authority there before enablement; deleting the
guard would not preserve the contract.

Independent implementation/security acceptance, a real independently reviewed
candidate in the actual autopilot deployment, any lab addition, lifecycle
eligibility (ENG-422), and release/live acceptance/BCH seam checks remain outside
this lane's completion claim. No activation note, native permission change,
release, push, shared housekeeping loop or live pane mutation was performed.
