# ENG-160: the route preset defaults to gpt-6.1-sol

Operator, 2026-10-03: "default to sol 6.1". Read ENG-160 (record show). In `lanes/preset.mjs`, every engineer route is
already `gpt-6.1-sol`, but `unblock` and `review-codex` (the settle review route used for every run) are
`gpt-6-astra` at xhigh. Change both to `gpt-6.1-sol`, effort unchanged (xhigh). Astra stays available only when a
project's own route configuration names it.

Also update the two places that present Astra as a default: the adoption text in `discovery/runtime.mjs` (near line
144: "Codex gpt-6-astra xhigh is an alternative" becomes Sol xhigh) and the model table row in
`lanes/docs/REFERENCE.md` (near line 564). Do not touch `kit/` (a frozen copy of bch-cloak) or historical
specs, reports and reviews.

Test first: add one assertion (in the existing preset or routes tests) that no preset route uses a model outside the
Sol engineer family except the deliberate Claude and small Codex routes, or more simply that `unblock` and
`review-codex` resolve to `gpt-6.1-sol` xhigh; watch it fail on main, then pass. Run only that test file and the
discovery test that covers the adoption text, if one exists. This is a five-line change: keep it that size. Commit, write the
report, record check it, commit it, run lane check last. Then stop.
