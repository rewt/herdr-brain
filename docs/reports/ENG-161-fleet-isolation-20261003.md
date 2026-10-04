---
run: R-216
outcome: done
summary: |
  Isolated the settle fixture's fleet in the test process and its children, independent of the bounded runner. Fixed the same environment-stripping pattern in promotion-train and plugin-install fixtures. The direct regression reproduces the actual in-process supervisor entry caller and passes with the fleet unset or pointing at the operator's home. Production fleet resolution and acceptance files are unchanged.
headline: Test fixtures own their fleets even when run directly.
blockers: []
proposals: []
learnings:
  - acceptance/supervisor.mjs uses the settle fixture and then calls createEntry in its own process; child HOME does not protect that call.
  - Fixture environment sanitization must restore the fixture-owned HERDR_MONITOR_FLEET after removing HERDR variables.
  - Plain settle fixture execution also needs repository initialization without the bounded runner's seed-storage directory.
  - Direct memory-pressure tests need the existing fixture-policy preload; native process inspection and file watches need permission outside the execution sandbox.
artifacts:
  - e6a3572e3172180f5d26b5ef07841c560dccdce7
  - settle/test/fleet-isolation.test.mjs
  - test/helpers/fleet-guard.mjs
  - docs/reports/evidence/ENG-161-R216
decisions: []
questions: []
challenges: []
---

Read the moved fleet manifest as evidence only. Its `project` entry names
`settle-test-rurKFe/project` and puts worktrees and temp under the operator's
real `.herdr-monitor`. No operator fleet or moved evidence was written.

The escaping caller is `acceptance/supervisor.mjs:26`: after creating the settle
fixture with a command hook, it calls the candidate's `createEntry()` directly.
That function calls `joinFleet({ cwd })` in the harness process. The old fixture
changed HOME only in its child environment and stripped HERDR variables from
that environment; it supplied no fleet override for the parent process.

The first guard regression failed before any real-fleet read or write. The
strengthened regression was also run against a temporary copy of the original
fixture, producing the exact `createEntry → joinFleet → readFleet → fleetPath`
failure under the real home for both an unset and an operator fleet setting.
The temporary negative-control files were removed. The fixed regression passed
all three reported tests using plain `node --test`, without runner defaults.
It proves in-process entry/join, children with the fixture environment, children
inheriting the parent environment, caller-environment restoration, and settle.

The settle fixture now uses the existing scoped `fixtureFleet` helper and puts
its override back into the sanitized child environment. Without seed storage,
it initializes its own repository. Promotion-train and plugin-install fixtures
also assign a scoped fleet and preserve it through their environment filters.
The test-only preload refuses real-home fleet resolution before `fleetPath`
returns; it identifies the account home independently of child HOME.

Validation was offline, with HERDR_MONITOR_FLEET unset on entry. Guarded direct
commands used `NODE_OPTIONS="--import=$PWD/test/helpers/fleet-guard.mjs"`:

| Direct test selection | Result |
| --- | --- |
| `settle/test/fleet-isolation.test.mjs` | 3 passed, including the actual in-process entry path |
| All `settle/test/*.test.mjs`, concurrency 1 | 143 passed; 6 failures described below; no fleet escapes |
| `promote/test/train.test.mjs` and `test/plugin-install.test.mjs` | 62 passed; 1 memory-mock failure; no fleet escapes |
| Entry, native-sandbox, supervisor-entry and zero-setup fixture files | 89 passed, 1 explicit platform skip |
| Six plugin entry/runtime cases after assigning the per-fixture fleet | 6 passed |

Four settle pressure cases and one promotion pressure case failed without the
runner's memory mocks. All five passed in targeted direct reruns with the
existing `fixture-policy.mjs` preload. Two settle file-wait cases hit sandbox
`EMFILE` watch refusals. Their targeted reruns passed with native access; the
correction-pressure rerun also needed native access to confirm owned watcher
identities. All seven initially failing cases therefore have passing targeted
rerun evidence. Compressed TAP logs retain the original failures and reruns.

The report is checked with the canonical record CLI and committed after the
implementation. Per the brief, `node lanes/lane.mjs check` runs last against
the final clean report commit; its receipt is `.lane/gate.json`.
