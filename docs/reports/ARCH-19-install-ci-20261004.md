---
run: R-209
outcome: done
summary: |
  Rebased lane/install onto local main without conflicts and fixed release candidate preparation in herdr/install.sh.
  Build-only preparation again installs pinned console/MCP dependencies directly, without loading machine-install helpers or requiring installed Herdr; machine installation retains prerequisite checks and dependency reuse.
  All 30 tests in release/test/ passed, including the three isolated CI failures, with no test expectations changed. The code and focused evidence are committed; the final narrow lane check follows the report commit.
headline: Release candidate preparation works again after the installer changes
blockers: []
proposals: []
learnings:
  - Release candidate fixtures intentionally copy only herdr/install.sh and herdr/release-candidate.mjs; build-only preparation must remain standalone and cannot require machine-install helper modules.
  - Build-only release preparation needs clean npm ci against its private offline cache, while machine installation can reuse dependencies and must preflight machine prerequisites and destinations.
artifacts:
  - "Commit 0b5b73c: Restore standalone release candidate dependency builds"
  - herdr/install.sh
  - docs/reports/evidence/ARCH-19-R209/release.tap
  - "node test/helpers/run.mjs release/test/*.test.mjs: 30 passed, 0 failed"
  - "bash -n herdr/install.sh and git diff --check: passed"
  - "Final check after report commit: node lanes/lane.mjs check --tier fast --cmd 'node test/helpers/run.mjs release/test/*.test.mjs'; receipt .lane/gate.json"
decisions: []
questions: []
challenges: []
---

The isolated train log showed `ERR_MODULE_NOT_FOUND` for the newly introduced
`herdr/prerequisites.mjs` in release fixtures, followed by failed preparation.
Moving that invocation into the machine-install branch also avoids imposing
Herdr, Python and machine-entry prerequisites on a dependency-only build.
The new dependency reuse helper presented the same standalone-build dependency,
so build-only mode now uses the original direct npm loop. Both modules retain
the same pinned install flags and inherit the candidate's offline cache settings.
Normal machine installation still checks prerequisites and entry destinations
before the dependency reuse helper runs, then installs machine entry.

The unchanged release tests prove configured and optional compatibility inputs,
real offline npm installation and build evidence, and retrying the same commit
after invalid inputs without cutting a candidate prematurely. Only the two
`release/test/` files ran. Their bounded fixture helpers use temporary test slots;
no host test slot, full suite or live acceptance harness was used. The final lane
check uses the fast tier with the same explicit narrow command to avoid the
project's default full-suite validation and host slot acquisition. Its receipt
is written after this report is checked and committed, as required by the ask.
