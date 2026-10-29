# Branch inventory cross-check

ENG-873 commit `96004b3c59a4e2ffa71a3ada600e24452d275e9d` already corrected
REV-184's unused lane-ref finding in `measureCloseouts`. This follow-up adds
dedicated proof of that branch contract without changing cleanup effects.

A retained branch needs a linked `branch-kept` receipt and a live ref at the
allocation's recorded head. A deleted branch needs a linked `branch-removed`
receipt and absence of that exact ref. Both require a target branch and an
explicit branch inventory. Short names and `refs/heads/` names match each other.
Unrelated refs cannot prove retention; their presence does not contradict
deletion of the target. Inventory alone cannot establish automated completion.
Missing or contradictory proof retains `branch-inventory-unproven` and
`resource-proof-incomplete` on the allocation without excluding its row.

Select the two dedicated retained/deleted controls through the lane check:

`node test/helpers/run.mjs --test-name-pattern=branch-inventory test/closeout-measurement.test.mjs`

Each control covers matching refs, both name spellings, unrelated refs, missing
inventory/target/receipt, unlinked receipts, the wrong receipt action and a
contradictory live ref. Retention also checks a changed head. The actual pinned
runtime, immutable candidate and runner/landing evidence belong to the R-1374
report and `.org/evidence/ENG-879/R-1374/`. Live acceptance and final-release
coverage remain with their existing coordinator.
