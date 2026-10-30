# Routine runtime updates and stable adoption

The 30 October 2026 operator direction on ENG-1126 adopts the release model first proven on BCH and recorded
in `.org/evidence/STABLE-RELEASE-20261027/adopt-bch-release-model.md`: nothing
gates main, producers run only new or affected checks once, one asynchronous
capped review follows, and findings fix forward. Full final coverage belongs to
the stable release coordinator. Native source/claim/CAS/STOP/HOLD and actual
outward authority remain enforced at their effects.

The supported routine path is `herdr/release.sh build TAG --landing-checks`, or
`ship TAG --landing-checks` for activation with installed-launcher checks and
automatic rollback. Only the supervisor uses it. It records full coverage UNRUN
and non-READY acceptance, preserving immutable snapshots and pin separation.
It does not execute or certify landing checks again. The producer's report and
existing validation receipts remain the evidence of their actual selected scope.

Live acceptance follows the same rule: it is UNRUN for each routine internal
update, required for the exact stable candidate that a consumer project adopts. Repeating it on
each internal update would retain a per-candidate gate after the offline gate
was removed. The routine safety net is affected landing tests, fix forward,
immutable bundles and rollback. Stable adoption retains one full coverage
obligation, valid evidence reuse, actual live acceptance and corrected Majors.

`build TAG --live` preserves the stable preparation path. Existing
`release-full-coverage/v1` and live continuation verifiers retain their source,
runtime, inventory and native evidence requirements. Only failed, affected or
unrun controls are repeated; UNRUN never means PASS. Routine bundles cannot be
pinned or attested into stable readiness. Existing READY home-policy admission
remains enforced, including for adopted projects following `current`.

## Fit with the release-suite plan

This changes the application of `.org/evidence/RELEASE-SUITE-PLAN-20261030.md`
(ENG-1125/R-1517); it does not rewrite its historical observations or select its
five implementation slices. In particular, its statement that actual live
acceptance runs for every candidate is superseded for routine updates.

| Slice | Application under this model | Next owner after selection |
| --- | --- | --- |
| 1: affected-test selection | Main routine safety net. Complete inventory, known transitive edges and dynamic consumers remain needed; unknown/deferred scope stays owed. No readiness gate on landing. | Engineering selector owner, coordinated by supervisor-herdr |
| 2: coverage continuation | Used for the single stable final coverage obligation, especially red-run correction; no per-routine-candidate coverage certificate. Keep the existing verifier and release-owner reconciliation. | Engineering coverage owner; stable coordinator retains disposition |
| 3: repeated fixture setup | Still useful for affected landing tests and the less frequent stable pass. Measure real fixture savings; its eight files do not alone establish the proposed timing target. | Engineering fixture owner |
| 4: scratch lifetime and waits | Still required across focused and stable runs. Preserve attempt ownership, native failure/UNKNOWN evidence and recovery; no global reaper or service restart. | Engineering fixture-lifetime owner |
| 5: observations and timing target | Record routine build/activation separately from cold stable coverage, continuation and live spans. Use already-required stable runs for the three-sample target; do not schedule full runs for each routine update or to fill a table. | Engineering timing owner and stable release coordinator |

The plan's ≤30-minute cold offline, ≤15-minute small continuation and ≤40-minute
end-to-end goals remain provisional stable-release targets, not routine-update
admission requirements or execution deadlines. No selector, cache, fixture,
cleanup, scheduler or timing implementation from those slices is included here.
