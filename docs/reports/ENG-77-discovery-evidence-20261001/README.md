# Discovery evidence for R-49

`attempt-4/summary.json` is the passing independent installed-product discovery probe.
Attempts 1–3 retain the failed development probes; they are not release acceptance.
`all-usage.json` includes all sixteen actual Luna sessions, including failed attempts.
The tested product adapters are included per attempt so the observed behavior is reproducible.
The final repository adds startup Git filter/root refusal, inherited-config isolation, and
managed-requirement preservation after the successful live snapshot; the final offline
native sandbox suite verifies those refinements.

The projects and installed product use separate scratch roots, outside repository trees.
The final command audit has zero references to either herdr-brain source checkout.
No authentication files are retained here.

The full ENG-74 acceptance harness remains the release gate and was not changed or
claimed green; R-50 is correcting its source-adjacency contamination.
