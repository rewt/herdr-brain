---
run: R-362
outcome: done
summary: |
  Cutover now accepts the adopting project's equivalent dry-run pass-through unchanged, rewrites the legacy call, asserts the switched end state, and refuses unrelated or duplicate cleanup calls. Other exact replacement clauses accept their equivalent end states; deletion and ambiguous shared-label premises remain strict. All thirteen current bch-cloak inputs passed the read-only snapshot cutover and rollback check, and copied current dispatch/cleanup passed housekeeping's dry-run checks. The focused offline run passed 19 tests; implementation and evidence are committed. The final focused lane check follows the report commit.
headline: Cutover accepts the project's existing dry-run safety fix
blockers: []
proposals: []
learnings:
  - bch-cloak's tidy-tabs.sh already passes --dry-run through with whitespace inside command substitution; its 2026-10-08 dryrun backup retains the old call.
  - ACCEPTANCE_BCH_CLOAK selects a read-only live snapshot premise check and runs the housekeeping regression with copied current scripts; pinned regressions continue to cover the legacy inventory.
artifacts:
  - "Implementation commit: f6626e9"
  - "Branch: lane/cutover-idempotent"
  - acceptance/cutover.mjs
  - acceptance/test/cutover-fixture.mjs
  - acceptance/test/cutover.test.mjs
  - acceptance/test/cutover-housekeeping.test.mjs
  - acceptance/README.md
  - docs/reports/evidence/ENG-303-R362/cutover.tap
  - docs/reports/ENG-303-cutover-idempotent-R-362.md
  - ".lane/gate.json records the final focused lane check against the report commit"
decisions: []
questions: []
challenges: []
---

The current live tidy script and `tidy-tabs.sh.bak-20261008-dryrun` differ only
in the cleanup invocation: the current script has `$( [ "$DRY" = 1 ] && echo
--dry-run )`. Their modification times are 2026-10-08 15:12:00 and 15:11:52
respectively, America/Chicago. Cutover recognizes the exact condition and flag,
allowing whitespace just inside the substitution, and preserves the existing
invocation. The old call is rewritten as before. The resulting script must
contain the dry-run call and exactly one cleanup invocation. Changed conditions,
flags, helper paths and an additional unsafe invocation fail with premise drift.

The shared replacement helper asserts the resulting clause and absence of the
old clause where the strings do not overlap. Exact clauses can already be
switched in the launcher, dispatch watch entry/cap/launch recorder, session-name
command, tidy log location/tail, notice ownership/recipient blocks, routing-test
loop, missing-target diagnostic and event-service comment. Tidy's sweep boundary
also recognizes the switched log location. Regression checks apply these edits
individually and require the identical complete output; unrelated changed clauses
still fail. The empty NW-variable deletion and the short shared se-test label
cannot prove equivalent end states, so their original premises remain required.
The unchanged workspace identity premise and cleanup/retirement boundaries also
remain required. This does not make the entire migration repeatable after its
destructive retirement steps.

All current inputs were copied from `/Users/rewt/development/bastian/bch-cloak`,
including its changed notify watcher, rather than relying on the October 4 kit.
The copy retains source hashes, modes and historical-backup inventory in the TAP
diagnostic. Current tidy SHA-256:
`bc837010b240227060a7c450c2c05b33bc4693791dd480b2de943134e08739e2`.
Current notify watcher SHA-256:
`3a11647c891eeb6127b4a86168380ea8c36736d6c3f84357a92bc0d719f252ff`.

The current watcher includes auto-review, the reported-state exit, bounded
four-hour resume wait, gone-agent check and narrowed placeholder expression.
Its body is retired wholesale by the existing switch, so those edits introduce
no replacement premise. The current snapshot passed every switched-file
transformation, relocated-path audit, notice contract and zero-caller checks,
then restored all thirteen input byte sequences and modes. Current copied
dispatch/cleanup also passed the housekeeping test with scripted Herdr and real
scratch Git/record state: only the settled merged done tab qualifies for
housekeeping closure, and protected/open/legacy/unmerged workers remain. No live
project file was written and no current live watcher was executed.

Validation passed 19/19 tests, zero skips:

```sh
TMPDIR=/private/tmp ACCEPTANCE_BCH_CLOAK=/Users/rewt/development/bastian/bch-cloak node --test acceptance/test/cutover.test.mjs acceptance/test/cutover-housekeeping.test.mjs
```

Host execution was used for the nested sandbox-exec safety check. The tests use
their private offline slot and scratch homes, never the host test slot.
`git diff --check` passed. Zero `--skip-live` passes were used; no live acceptance
harness, baseline, npm test, promotion/lanes/release tier or housekeeping loop ran.
Independent settle review and release-candidate validation remain downstream.

After checking and committing this report, the last operation is:

```sh
node lanes/lane.mjs check --cmd 'TMPDIR=/private/tmp ACCEPTANCE_BCH_CLOAK=/Users/rewt/development/bastian/bch-cloak node --test acceptance/test/cutover.test.mjs acceptance/test/cutover-housekeeping.test.mjs'
```

The gate receipt records its verdict against the final report commit.
