# ENG-119: release gate setup inputs, and a gate any machine can pass

RC-1 (2026-10-03) failed at preparation because RELEASE_BCH_CLOAK was unset. The release module recorded a failed
gate, and a gated commit is never gated again, so a setup omission burned the candidate. Check machine inputs before
claiming the gate; a missing input leaves the candidate ungated, with the setup message, and gateable later.

This repo's gate also requires a bch-cloak checkout, which a fresh machine (ARCH-19) won't have. Make the existing
project compatibility cases optional: when no such project is configured, report them as skipped with a visible
reason, and let the rest of the gate decide. When one is configured, nothing about those cases weakens.
See release/README.md and herdr/release-candidate.mjs. Never write bch-cloak's checkout.

Run npm run test:fast, the release and acceptance offline tests, and at most one acceptance --skip-live pass. Never
run the live harness or the release cycle itself. Commit, write the report, record check it, commit it, run lane
check last. Then stop.
