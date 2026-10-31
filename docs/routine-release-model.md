# Routine runtime updates and consumer offers

The operator's HUM-43 answer on 30 October 2026 supersedes ENG-1126's stable
full-coverage prerequisite: **canary pass plus landing tests replaces the full
suite for consumer offers; the full suite is non-blocking background information**.
This applies to every consumer project on a pinned Brain release. Corrected
Majors still precede an offer. The consumer project decides whether and when to
activate; an offer grants no release, publishing, pin or native execution authority.

Nothing gates main. Producers run only new or affected checks once, self-land
owned source and hand off one asynchronous capped diff/evidence review. Findings
fix forward. Native identity/claim/source/CAS/STOP/HOLD checks remain at effects.

The canonical supervisor uses `herdr/release.sh build TAG --landing-checks` or
`ship TAG --landing-checks` for routine runtime updates. These retain immutable
snapshots, installed-launcher checks, rollback and pin separation. They record
full coverage and live acceptance UNRUN. They neither replay nor certify the
producer's landing tests. Routine updates have no new readiness gate.

## Stable consumer-offer handoff

Build the exact candidate in routine mode, run the installed canary (A2 / ENG-1135),
bounded Brain probation (A3 / ENG-1136) and real-work soak (A4 / ENG-1137) through
their owners, then use:

```sh
bash herdr/release.sh offer TAG /absolute/path/to/offer-evidence.json
```

The command verifies an already sealed candidate and writes one immutable offer
under `RELEASE_HOME/offers/TAG.json`. It never builds, executes tests, activates,
changes a pin, sends a message or starts a background full suite. It refuses
missing canary PASS, missing or red landing evidence, unaccounted/unresolved
Majors, stale source/manifest bindings, altered evidence and absent recorded
coordinator disposition. Existing/unknown offers are inspected, never replaced.
The offer makes that exact bundle eligible for existing READY pin/home admission;
it does not fabricate the historical live-harness acceptance summary. Existing
bundles predating this rule retain their legacy acceptance contract. Newly built
bundles require this offer even if an optional full/live preparation was green.

The coordinator assembles `consumer-release-offer/v1` evidence as described in
[the release tooling reference](../herdr/README.md#consumer-offer-evidence).
The recorded disposition binds the complete packet, including the A2/A3/A4
results, full source range/producer selection and the complete applicable Major
inventory. Semantic coverage remains the coordinator's responsibility: a hash
or a green check filename alone does not establish that coverage. A canary FAIL,
INCOMPLETE or missing actual soak is not PASS. Reuse valid producer receipts;
reconcile ancestor or pre-rebase checks against the exact candidate tree delta
instead of replaying green runs. The verifier checks recorded applicable Major
finding discharges, the canonical coordinator and owning disposition item, and
PASS/candidate bindings inside the canary stage files. Genuine soak and semantic
coverage remain with the release coordinator.

The full-suite field defaults to UNRUN. FAIL, UNKNOWN, PASS and UNRUN are all
informational and never veto an otherwise qualified offer. Retain original
failures and assign real defects; an applicable uncorrected Major blocks through
the Major obligation, not through the broad suite's exit status. Historical
full-coverage certificates and `build --live` remain diagnostic/preparation tools,
not consumer-offer prerequisites. They run only when separately selected by their
owner; this rule starts no background jobs or extra runs.

## Fit with the release-suite plan

This supersedes the stable full-coverage obligation in the historical
`.org/evidence/RELEASE-SUITE-PLAN-20261030.md` and ENG-1127's original proposal.
Affected-test selection, fixture efficiency, scratch ownership and observable
readiness remain useful. Full-coverage continuation and timing work describe
optional background diagnostics, not consumer admission. Existing groups, limits,
failed-attempt preservation and UNRUN truth still apply. No canary construction,
consumer pin change, service restart or release is included in this policy change.
