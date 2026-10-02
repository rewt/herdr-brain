# Validation tiers in herdr-brain

The tracked `.lane.validation.json` declares `npm run test:fast` for workers,
`npm run test:promotion` for settlement/promotion, and the release acceptance
harness for releases. The release module (ENG-109) must supply
`HERDR_RELEASE_CANDIDATE` with the candidate tag, commit or directory before
executing that command. Workers cannot select release through `lane check`.
This lane has not run the release harness.

The supervisor's 2026-10-02 profile contains 822 top-level tests, about 2,004
seconds summed serial time and 215 seconds wall time through concurrency. It
warns that the parallel benefit collapses under load. The profile is at
`/private/tmp/claude-501/-Users-rewt-development-rewt-herdr-brain/4ec1de75-93e3-447f-9929-5114c8ae1f1d/scratchpad/npm-test-profile.txt`.
Its 32 runner-environment failures are not product evidence.

The proposed split uses whole test files so the selected coverage is explicit
and doesn't depend on a title filter:

| Tier | Coverage | Reason |
| --- | --- | --- |
| Fast | Report parsing, discernment and sanitization; Brain capture; console model, layout, painting, names, waiting and prototype; route resolution; focused validation config, reuse, invalidation, mutation and locking tests | Frequent feedback from mostly in-process checks plus a small set of disposable Git checks |
| Promotion | All existing `npm test` files, `test:lanes` and offline `test:acceptance` | Full record, entry/confinement, installation, console controls, dispatch/watch, settle/rebase/recovery, supervisor and queue/lifecycle proof |
| Release | `acceptance/run.mjs --candidate "$HERDR_RELEASE_CANDIDATE"` | The live release acceptance gate runs once per candidate, after accumulated promotions; ENG-109 owns execution and lifecycle |

The longest profile entries include lost-start reconciliation (57.9 seconds),
review-cap correction cases (30.1 seconds), bound promotion guards (29.9 seconds),
the supervisor cycle (28.1 seconds) and copied discovery probes (24.8 seconds).
Those scenarios remain in promotion. They do not become a dependency of every
worker's fast feedback. A worker still runs focused tests for the changed module,
and follows project instructions requiring additional checks.

In this lane the initial fast run passed 139 tests in 10.1 seconds. This is an
observed run under current conditions, not a promised latency or a like-for-like
comparison with the supervisor's earlier full-suite profile. `npm test` keeps
every existing test in two sequential bounded batches: `test:core` covers the
record/UI/entry/module tests and `test:cycle` covers settle and supervisor. Each
uses the existing runner's supported nine-minute maximum; per-file and fixture
command bounds and owned-process cleanup remain. The single aggregate exceeded
both six and nine minutes under observed load, so batching avoids losing completed
coverage to that aggregate deadline.
After rebasing onto main's interim timeout adjustment, both batches retain its
eight-minute file bound; ordinary fixture calls keep their 15-second limit.

Evidence is keyed by the entire Git tree, exact command and hashed environment.
No test category or path is excluded from tree identity. A public review record
therefore changes the tree and correctly causes another check; an empty commit
or clean rebase producing the same tree does not. Matching commands can share
proof across fast and promotion. Promotion still checks canonical/lane cleanliness,
branch identity, base freshness, expected head/run readiness and fast-forward.

Use reproducible tracked dependencies. The environment fingerprint includes
Node/Git/OS identity, preparation definitions and process environment, excluding
documented cwd/coordination fields. It cannot discover a silently edited external
binary, ignored dependency or service behind an unchanged path. Projects can
change `validation.environment` to name that external revision. Logs and receipts
remain under the canonical Git common directory, outside worker-writable gate
files; altered/missing logs and nonpassing receipts are not reused.

Worker, settle and queue pane identities are normalized before preparation and
validation, and before hashing the environment. Changing a pane, tab or workspace
therefore does not invalidate evidence or provide a validation input. An
undeclared project with package metadata, `test/` and no npm test script retains
the `node --test` fallback through native entry, including promotion.

Native entry keeps a two-minute owner deadline for fast checks, preparation and
Git filters, and allows promotion checks up to 30 minutes. Wrapper and broker
bounds reserve compilation/cleanup and preparation/Git time; the broker has a
one-hour cap and the request client reserves five more seconds for its reply.
Each native step is shortened when needed to preserve cleanup time within the
remaining aggregate deadline, including after preparation.
These are trusted execution bounds, not agent-configurable request fields. An
identical command that passes fast validation still supplies reusable promotion
evidence. The offline regression copies this policy with shorter numeric bounds
and runs the real entry, request client and native descendant owner, proving a
longer declared command succeeds only with the promotion lifetime while late
descendant writes remain impossible. Sandbox transport is scripted in that test;
existing host-provider confinement tests retain their explicit applicability.
