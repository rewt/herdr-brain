**PASS**
Schema: lane-review/v1
Reviewed commit: fabf4b7e2833c386349253fd417e6a67c4ed4911
Topic: rollback-compat
Round: 1
Review ID: lr-f8c4ee4fdde1254ec58b49a1572a2eb5
Base branch: main
Base commit: ad97e531073dd31e4e6cc885773415a4b55e5b40

## Findings
- [Minor] test/compat.test.mjs:20 - the positive compatibility test archives HEAD as the OLD bundle, so in the promotion gate OLD and NEW are the same source and no cross-version read is ever exercised; the ask suggested an earlier main commit; Fix: archive a fixed earlier main commit when it is reachable (skip with an explicit named reason when history is shallow), or rename the test to state it is a self-compatibility smoke check
- [Minor] herdr/compat.mjs:35 - result identity records only the NEW commit from git rev-parse and does not record whether the NEW working tree was dirty, so committed evidence cannot show that the probed runtime bytes equal the named commit; Fix: add a dirty flag from git status porcelain or a hash over productFiles of NEW to the identity block
- [Minor] herdr/compat-probes.mjs:342 - the housekeeping probe recomputes the owner lock location by hand and copies captured bytes there, so a future change in the NEW location derivation would still pass while a real OLD reader would miss the lock; Fix: run the NEW dry-run with its default state directory inside the scratch record so the writer places owner.json itself, or assert the probe path against the writer-derived path

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/formats.test.mjs
- Test evidence not re-executed: test/compat.test.mjs
- Report record-check validation not independently executed.
- The committed ENG-441 evidence JSON files were not regenerated; their pass, fail and not-covered results are accepted only as committed bytes consistent with the source and inventory hash.
- Activation history was not inspected; the claim that the fallback is the first activated herdr-release/v1 bundle rests on the release directory listing, where it is the earliest non-partial bundle carrying a release manifest.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
