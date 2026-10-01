---
run: R-43
outcome: done
summary: |
  Fixed all four Minor dispatch findings with regression tests: refused record starts can retry the saved request, run IDs are rejected as items before mutation, retries lock before reading progress and safely serialize dead-owner takeover, and worker reuse requires a reported or abandoned prior run. Lost start responses reconcile automatically to a single recorded run while unknown or ambiguous outcomes remain explicit. Offline core and lanes validation pass; no record-core change, new event type or stored record status was introduced.
headline: Dispatch now recovers refused starts and prevents concurrent retries and open-run worker reuse
blockers: []
proposals: []
learnings:
  - An unsuccessful record start can have committed its run; reconcile dispatch_journal against the item's recorded runs before deciding to start again.
  - Check-then-rename of a stale lock is not compare-and-swap; unique PID contenders serialize both journal reads and cleanup without removing a new owner's lock.
  - An idle worker can still belong to an open run; reuse needs durable report or abandonment evidence as well as live occupant identity.
artifacts:
  - Harden dispatch recovery and worker reuse
  - Report dispatch hardening and validation
  - dispatch/dispatch.mjs
  - dispatch/test/dispatch.test.mjs
  - dispatch/README.md
  - docs/reports/ENG-72-dispatch-hardening-20261001.md
  - node --test dispatch/test/dispatch.test.mjs before fixes (19 tests, 6 expected failures reproducing all four findings)
  - npm test before changes (307 tests, 306 passed, 1 existing skip)
  - npm run test:lanes before changes (146 passed)
  - npm test after changes (314 tests, 313 passed, 1 existing skip; all 20 dispatch tests passed)
  - npm run test:lanes after changes (146 passed)
  - record check docs/reports/ENG-72-dispatch-hardening-20261001.md
  - lane check after the report commit (final gate in .lane/gate.json)
decisions:
  - decision: Reconcile starting requests through record show, adopting exactly one matching run and restarting only a known record refusal with no match.
    why: This recovers deterministic refusals and lost replies without creating duplicate runs. Unknown outcomes with no match and multiple matches still require explicit inspection and recovery.
  - decision: Publish unique PID contenders before inspecting or replacing the original PID lock, and read retry progress only after acquisition.
    why: Later contenders see the live claimant and refuse. Stale contender names are never reused, so crash cleanup cannot unlink a new claimant. A crash during either acquisition phase remains recoverable; simultaneous contenders may conservatively both refuse.
  - decision: Require the previous reuse run to be reported or abandoned at preflight and again before binding the worker.
    why: Invalid reuse creates no lane or run, and retries still enforce the same durable prerequisite alongside the existing routing and occupant checks.
questions: []
challenges:
  - premise: The four Minor review findings need fixes rather than being moot.
    verdict: holds
    evidence: Each finding has a regression that failed on the original implementation; the two retry race tests use filesystem barriers to control the interleavings.
  - premise: This run is the dispatch module's first live use.
    verdict: holds for observed startup
    evidence: R-43's record and completed dispatch journal agree on ENG-72, this lane worktree, the engineer route, model and effort, prompt brief paths, exact report destination and worker terminal identity. Record notes order worker recording before watcher readiness before prompt delivery. The watcher log acknowledges the same run, worker, report destination and supervisor. A read-only process inspection confirmed the recorded watcher PID is running watch/watch.mjs for R-43 and waiting on the recorded worker. No startup discrepancy was observed.
---

The implementation commit is **Harden dispatch recovery and worker reuse**.
The report commit is **Report dispatch hardening and validation**.

The refused-start regression injects the record CLI's refusal protocol, verifies
that no run was created, then retries the same journal without reopening its
lane. Lost-response coverage verifies automatic adoption and exactly one run.
Unknown failures with no matching run and multiple matching runs remain refused;
explicit recovery also restores a missing run brief through the existing CLI.

The run-as-item regression verifies refusal before any lane call, request journal
or additional run. The open-prior-run regression uses an idle worker and verifies
refusal without another launch, prompt or run. Both reported and abandoned prior
runs remain eligible when all existing route and occupant checks pass.

The first concurrency regression pauses a retry at its journal read and verifies
that a second retry refuses, so saved progress cannot be replayed. The second
pauses dead-owner inspection and verifies that a competing retry cannot take
over the same lock. It also leaves a dead acquisition contender and verifies
cleanup after recovery. The tests check prompt counts and watcher launches; neither
launches a model or addresses a real pane.

All changed production code is in dispatch. Core event storage, derived status,
lane lifecycle checks, the watcher implementation and contrib/settle-watch.mjs
are unchanged. No shared configuration, release, global launcher, bch-cloak
repository or record was written; nothing was pushed or published.

After this report is checked and committed, the final command is lane check.
Its ignored .lane/gate.json records validation against the final clean commit;
the report deliberately does not cite an earlier commit's gate as final evidence.
