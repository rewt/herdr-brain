---
run: R-276
outcome: done
summary: |
  Restored partial release candidates by keeping their driver self-contained with Node's argument parser and local help. Audited file-by-file fixtures and installers; the other named modules are distributed with the shared lib directory. The unchanged candidate tests passed 7/7, module help passed 41/41, zero-setup installation passed 19/19, and offline acceptance verification passed 4/4 with host permissions. The implementation is committed; this checked report and evidence precede the final focused lane check.
headline: Partial release candidates work again and retain command help
blockers: []
proposals: []
learnings:
  - Build-only release fixtures intentionally copy just herdr/release-candidate.mjs and herdr/install.sh; the candidate driver must remain self-contained.
  - Other entry runtime modules are copied through productFiles, which includes the full lib directory, or through complete archives; their shared help import requires no fixture changes.
artifacts:
  - "Implementation commit: 5cb798332ab3bc1319abd78bd6df993ea9f2da8b"
  - "Branch: lane/entry-pin"
  - herdr/release-candidate.mjs
  - docs/reports/ENG-229-entry-pin-R-276.md
  - docs/reports/evidence/ENG-229-R276/partial-copy.tap
  - docs/reports/evidence/ENG-229-R276/verification-host.tap
  - docs/reports/evidence/ENG-229-R276/standalone-help.txt
  - ".lane/gate.json records the final focused check against the report commit"
decisions: []
questions: []
challenges: []
---

The merge queue's five failing candidate cases imported a missing
`candidate/lib/cli-help.mjs`. The driver now imports `parseArgs` from `node:util`
and handles `--help` and `-h` locally before candidate validation or any build
operation. Existing strict argument parsing and release safety checks remain.
No fixture or test was changed.

Copy audit covered repository-wide `copyFileSync` and `cpSync`, inventory-based
copies, runtime snapshots, and shell/archive installation paths:

- `release/test/candidate.test.mjs:28` is the only direct single-file copy of
  the six named module CLIs. It copies the driver and install script with no
  `lib/`; keeping the production driver standalone preserves that contract.
- `lib/product-files.mjs` enumerates the complete `lib/`, `herdr/`, and
  `release/` runtime directories. `copyProduct` and `herdr/entry-runtime.mjs`
  use this inventory, so `entry-install.mjs`, `native-entry.mjs`,
  `prerequisites.mjs`, `dependencies.mjs`, and `release/release.mjs` retain their
  shared help import. Installed-module verification checks every relative
  import in the copied product.
- Inventory callers include `test/plugin-install.test.mjs`,
  `test/zero-setup-install.test.mjs`, `test/entry-upgrade.test.mjs`, discovery's
  entry/owner/validation fixtures, housekeeping's CLI fixture, promote's
  workflow-train fixture, and acceptance's `plugin-entry.mjs`, `live.mjs`,
  `lessons.mjs`, `transport.mjs`, and verification fixtures.
- `acceptance/run.mjs` and `acceptance/test/snapshot.test.mjs` copy full
  candidates or extract full Git archives. `herdr/release.sh`,
  `release/release.mjs`, adoption rehearsal, and acceptance verification's
  archive path likewise include `lib/`. Old-release compatibility copies in
  `test/plugin-install.test.mjs` copy complete historical releases.
- Acceptance's remaining single-file copies carry isolated worker transports,
  security/environment helpers, receipts, or evidence. None copies one of
  the six named module CLIs without its runtime inventory.

Evidence and commands:

```
MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-partial-copy -- node test/helpers/run.mjs release/test/candidate.test.mjs test/cli-help.test.mjs test/zero-setup-install.test.mjs acceptance/test/verification.test.mjs
```

`partial-copy.tap`: all seven unchanged candidate cases, 41 module help cases,
19 installation cases, and the installed-relative-import verification case
passed. Three additional acceptance verification cases failed under this
session's sandbox: two could not apply nested `sandbox-exec`, and one could not
bind a scratch Unix socket. Those were rerun with host permissions:

```
MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-copy-verification -- node test/helpers/run.mjs acceptance/test/verification.test.mjs
```

`verification-host.tap`: all four offline verification cases passed. Combined
coverage is 71 distinct passing cases, zero unresolved failures. The candidate
suite's preparation runs its fixture's tiny scripted `test:release` command;
it does not run this project's release suite or live harness.

`standalone-help.txt` records two additional scratch-copy checks: copied only
the driver to an otherwise empty directory, invoked `--help` and `-h` with an
isolated HOME and PATH, asserted exit zero and stage/option usage, and verified
that neither invocation wrote files. `git diff --check` passed.

No baseline, full project test/promotion/lane suite, live acceptance harness,
model call, or housekeeping loop was run. The report is written to the requested
record path, checked with `record check`, and committed with these logs. The
final action after that commit is the same focused four-file lane check with
host permissions:

```
node lanes/lane.mjs check --cmd 'MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-final-partial-copy -- node test/helpers/run.mjs release/test/candidate.test.mjs test/cli-help.test.mjs test/zero-setup-install.test.mjs acceptance/test/verification.test.mjs'
```

Its gate and content-checked log bind the result to the report commit. No
subsequent lane mutation is planned.
