**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: def4de81403cd05e149c553f82ed518548561310
Topic: chores
Round: 1
Review ID: lr-af4722fbff0b50aeda2b717b25c97bc9
Base branch: main
Base commit: 2a040174254cba42dc15356258192370d0fc17a5

## Findings
- [Moderate] dispatch/metrics.mjs:70 - adding admission\_lock to waitKinds in lib/run-timing.mjs makes dispatch\_wait\_s require a measured admission\_lock sample, so every reused-worker dispatch (dispatch/dispatch.mjs takes the lock only on the non-reuse branch, as dispatch/README.md now states) and every run recorded before this change with complete memory\_open and memory\_worker samples now reports dispatch\_wait\_s null and is counted as missing; the updated timing tests only exercise runs that carry all three kinds; Fix: total dispatch\_wait\_s over the two memory gates plus admission\_lock only when the run attempted it (an absent admission\_lock is not applicable for reuse and pre-change runs, while an entry without a grant stays missing), and add a firing case with memory-only metadata asserting the total remains measured
- [Moderate] docs/contracts/CONTINUATION-AND-REVISION-CAP.md:57 - the public contract still says precedence falls back to 0 (unlimited), and line 61 says the unconfigured default stays 0 and Brain's project cap stays 1, contradicting settle/config.mjs DESK\_DEFAULTS review\_round\_cap 3, settle/README.md and the .lane.json change to 3; Fix: amend the precedence sentence to fall back to 3 completed review rounds, keep the legacy pending receipts remain unlimited sentence, and replace line 61 with the new unconfigured default of 3 and Brain's project cap of 3
- [Minor] dispatch/dispatch.mjs:494 - the new validation instruction is sent to every dispatched worker, including configured projects, and says both to capture tests through lane check before reporting and not to rerun tests solely to create a receipt; where the declared fast command is a tier script (this project declares npm run test:fast) a worker following an ask's targeted file list must either run an extra tier or skip the receipt, so the review loop ENG-461 targets can persist; Fix: state one rule, for example run the ask's final test selection once through lane check --cmd and use the declared or default fast command only when the ask names no selection, and assert that wording in dispatch/test/dispatch.test.mjs
- [Minor] lib/run-timing.mjs:4 - older releases validate timing kinds strictly, so after a rollback or in a mixed-version window an older metrics view counts every new run as invalid\_metadata and an older watch readTiming throws on a journal containing admission\_lock and silently drops process\_end metadata; the REGISTRY run-timing row still says additive and the timing compatibility probe writes only process\_end, so test/compat.test.mjs cannot observe this; Fix: note the reader-visible kind addition in the docs/contracts/REGISTRY.md run-timing row and extend the herdr/compat-probes.mjs timing probe to write an admission\_lock event and assert the older reader's documented behaviour
- [Minor] test-slot/test/memory-floor.test.mjs:10 - the new unit case is inserted between the module's import declarations, leaving imports on lines 20 to 25 after a test body; it is valid only through import hoisting and does not match the file's layout; Fix: move the test below the final import declaration

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Report record-check validation not independently executed.
- Test evidence not re-executed: settle/test/config.test.mjs
- Test evidence not re-executed: settle/test/round-cap.test.mjs
- Test evidence not re-executed: settle/test/default-validation.test.mjs
- Test evidence not re-executed: settle/test/record-safety.test.mjs
- Test evidence not re-executed: test-slot/test/memory-floor.test.mjs
- Test evidence not re-executed: dispatch/test/session-cap.test.mjs
- Test evidence not re-executed: dispatch/test/timing.test.mjs
- Test evidence not re-executed: dispatch/test/dispatch.test.mjs
- Test evidence not re-executed: test/retire-archive.test.mjs
- Test evidence not re-executed: test/retire.test.mjs
- Test evidence not re-executed: test/record-guard.test.mjs
- Test evidence not re-executed: test/closeout.test.mjs
- Test evidence not re-executed: test/compat.test.mjs
- The worker report itself records failures it attributes to the sandbox (process inspection, incomplete independent-review transport, fs.watch EMFILE) in the settle config, round-cap, receipts and record-safety files, lanes/test/validation.test.mjs and test-slot/test/memory-floor.test.mjs; native results for those files were not supplied and the inherited validation log contains no worker receipt or TAP totals.
- The worker report describes HEAD 87e96ecb with nine uncommitted patches; the reviewed commit def4de81 contains eleven per-item commits made afterward, and the correspondence between those commits and the worker's patch manifest was not checked byte for byte beyond reviewing the full base-to-head diff.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
