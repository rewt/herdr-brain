**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 0e6bbaa1944d020bd950a46e50850c4dc8b2449f
Topic: pin-acceptance
Round: 1
Review ID: lr-43cae1fc533aabe3e814338337cd7cae
Base branch: main
Base commit: ad97e531073dd31e4e6cc885773415a4b55e5b40

## Findings
- [Moderate] watch/watch.mjs:553 - The saved dispatch-bundle check only runs when watch.mjs is invoked through a mutable path, so the documented re-arm adapters (installed supervisor/arm-watch.sh and release.sh exec watch/watch.mjs, which go through runRelease and selectRelease) spawn the pin or current bundle by its immutable path, skip the check, and re-arm an admitted dispatched run on a fresh pin or current lookup; this contradicts the ENG-439 item 4 requirement and the new Operation inventory row at herdr/RELEASE-PINS.md:124 that says re-arm of a dispatched run re-enters its saved dispatch bundle; Fix: read the run dispatch journal whenever the executing bundle is installed (not only when argv differs from SELF) and call continueRelease with receipt.release when its root differs from bundleRelease().root, keep the operation-release-missing refusal for legacy receipts, add a fixture that re-arms through arm-watch.sh after a pin change, and correct the inventory row
- [Minor] lib/releases.mjs:268 - pinStatus calls committedPin outside any try, so when the committed pin is missing from the canonical working tree or the committed pin JSON is invalid, pin-status aborts with an error instead of reading back the committed HEAD pin, the differing working-tree state and the admission refusal, which is exactly the prepared-versus-committed drift the read-back is meant to expose; Fix: catch the committedPin error, report the HEAD commit, the committed pin bytes when readable, a prepared entry labelled prepared, not accepted for the missing or differing working-tree file, and the error as admissionError, and add a fixture for a deleted working-tree pin
- [Minor] supervisor/PROTOCOL.md:147 - The release protocol still says the live acceptance harness is optional and the supervisor ships with ship TAG, which never passes --live, so every release shipped by the documented procedure now records acceptance ran false and can never be pinned; nothing in the protocol tells the supervisor that a pin candidate must be built with build TAG --live and then activated; Fix: state in PROTOCOL.md that ship TAG releases are unpinnable and that a pin candidate is built with build TAG --live followed by activate TAG, linking herdr/RELEASE-PINS.md

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/release-acceptance.test.mjs.
- Test evidence not re-executed: test/release.test.mjs.
- Test evidence not re-executed: test/release-pins.test.mjs.
- Test evidence not re-executed: test/setup.test.mjs.
- The worker focused log shows 5 of 47 failing in supervisor/test/supervisor.test.mjs with fixture ownership and process enumeration errors; supervisor/supervisor.mjs changed in this delta and the review could not establish whether any failure is caused by the new requestRelease pre-forward path rather than the harness.
- The worker primary log shows 7 watcher cases failing with EMFILE; watch/watch.mjs changed in this delta (new pre-forward readRun and journal check) and those watcher tests were not observed passing anywhere.
- The worker primary log shows 6 acceptance offline cleanup or deadline cases failing; acceptance/run.mjs and acceptance/results.mjs changed and those cases were not observed passing.
- The real build TAG --live summary-file handoff into the partial bundle and its interaction with the live harness directory candidate (including the macOS tmp realpath comparison against SELF in watch.mjs) were not exercised; only a fake harness and the writeSummary unit were.
- The inherited settle validation log contains no TAP totals; it states no worker validation receipt exists at the captured tree.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
