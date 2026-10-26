# Cutover copy follow-up disposition

Both ENG-240 findings from the R-279 review are superseded by removal of the
copied-project rehearsal. No current copier needs either repair.

Commit `013f691d63c2790a8d4989059dfb83eff1b9ada5` ("Remove sandbox entry adapters
and launch native project chats", committed 2026-10-12) deleted
`acceptance/existing-project.mjs`, `acceptance/cutover.mjs`, their offline tests
and the BCH fixture. `acceptance/README.md` already documents retirement of the
copied BCH rehearsals. This closeout adds the explicit connection to the two
remaining copy findings.

The deleted copier used a `supportFile` extension allowlist in
`existingProjectFiles`, so extensionless or unfamiliar support files could be
omitted. Its `supervisorRuntime` predicate also embedded `OPEN-STATE.md`,
`TODAY.md` and `GAPS.md` in a regular expression. Deletion removed both behaviors;
there is no surviving constant to extract or copy selection to widen. Historical
reports, including `docs/reports/ENG-238-cutover-files-R-279.md`, remain unchanged
as evidence of the earlier implementation. Restoring this removed rehearsal is
outside this follow-up's scope.

Designated verification: `lane-line-eng-240--9d9b39-390e51`, run R-867;
observed 2026-10-26T22:36:15Z against source
`4a1e2f93843420b325a1df178588c1471f4b2fe6`.

Evidence was read once using:

```sh
git show --stat 013f691d -- acceptance
git show 013f691d -- acceptance/existing-project.mjs acceptance/test/existing-project.test.mjs
git ls-tree --name-only HEAD acceptance/existing-project.mjs acceptance/cutover.mjs acceptance/test/existing-project.test.mjs acceptance/test/cutover.test.mjs
rg -n 'existing-project|existingProjectFiles|copyExistingProject|supervisorRuntime|OPEN-STATE|TODAY\.md|GAPS\.md' acceptance
```

Results: Git identifies the explicit deletion, the current tree contains none
of those four files, and the acceptance source had no matching copier symbols or
snapshot names before this documentation update. The deletion diff preserves
the exact original allowlist and runtime-name expressions.

Focused check selection: none applicable. The ask and dispatch extra scope select
no command, the affected implementation and tests were deleted, and this change
only records that disposition in documentation. No test suite, lane check, tier,
live acceptance or skip-live run was executed; there is no test PASS claim.
The final release coordinator retains the full release obligation.

The owning run report records the finished commit, immutable landed base/head
and the current operator landing waiver. Existing report delivery and the single
record queue-review path retain ownership of intake and independent judgment.
