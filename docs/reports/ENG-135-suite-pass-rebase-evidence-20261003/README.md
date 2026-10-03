# Rebase verification for R-184

Rebased `lane/suite-pass` from `24d99ff` onto main `62b4f69b443eb29c2a53bfe6b878dac5b98f91d1`, then onto `6e7905e83927a521d60f2e91bcb9e96c84cd83e2` after main advanced during the host-slot wait. The five original commits remain in order; only the first changed in the range comparison.

The two conflicts preserve ENG-122's non-setuid `lookupProcess` identity source, source-failure injection and diagnostics, alongside the accepted suite's load-aware allowances, atomic PID receipts and CPU-idle blocked-loop fixtures. No new implementation work was added.

`range-diff.txt` records the old/new commit comparison. `resolved-diff.patch` records the two resolved files relative to the rebase base. Both resolved files passed `node --check` and scoped `git diff --check`. A whole-lane diff check also identified pre-existing blank lines at EOF in `settle/test/helpers/ref-transaction.mjs` and `test/deadline-boundaries.test.mjs`; the accepted files were left as-is for this rebase-only round.

The first host-slot request waited 600 seconds and returned 75 without starting tests; `slot-refusal.log` retains the diagnostic. A second request queued the same command and ran it once after the holder released its slot:

```sh
node test-slot/test-slot.mjs run ENG-135-rebase-focused --wait 1200 -- node --test --test-concurrency=1 test-slot/test/test-slot.test.mjs discovery/test/review-r3.test.mjs discovery/test/owner.test.mjs test/test-hangs.test.mjs
```

`focused.log` retains the complete TAP output: 103 tests, 102 passed, one Linux-only skip, zero failures/cancellations; 92.185 seconds of test time, exit 0. These are the slot file and every test file using the conflicted detached-descendant helper. No full tier or live acceptance harness ran for this focused verification. Git operations disabled hooks through `core.hooksPath=/dev/null`; no hook-trust dialog appeared.

The final rebase completed without conflicts. SHA-256 verification confirmed that both resolved files and all three helper consumer test files were byte-identical to the focused run. `tested-sha256.txt` retains those hashes. No suite retry was needed.
