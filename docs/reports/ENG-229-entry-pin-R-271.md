---
run: R-271
outcome: done
summary: |
  Generated entry wrappers resolve native Codex and Claude at launch, skipping managed entry directories and retaining stable launchers as fallback. Claude's default Codex validator follows the same lookup. Module CLIs now print help before operational work. Upgrade/help/installation checks passed 61/61; discovery regressions passed 58 with five provider-specific skips; all 21 release lesson checks passed. One separate native sandbox validation receipt failure remains reproducible and is proposed below. The implementation is committed; the checked report commit precedes the final focused lane check.
headline: Entry wrappers follow harness upgrades and module commands explain their usage
blockers: []
proposals:
  - role: engineer
    title: Investigate native Codex validation returning exit 125 after successful offline project tests
    why: The installed live discovery offline regression reaches both green project tests, then validation returns 125 without its lifetime receipt. Reproduced outside the agent sandbox both with the bounded test runner and directly. The other two discovery setup checks pass. This can prevent worker validation and promotion with the current native harness; investigate descriptor forwarding and the native lifetime owner.
learnings:
  - Launch-time native lookup requires installed-entry fixtures to name their fake codex and claude on an isolated PATH; an absolute fake supplied only at install no longer overrides the current PATH launcher.
  - Keep the release canaries' private native transports on PATH ahead of host harnesses so wrapper lookup cannot bypass their delivery and boundary receipts.
artifacts:
  - "Implementation commit: 3befa16e655b903efee349cf4ea6949b6f169944"
  - "Branch: lane/entry-pin"
  - discovery/native-binary.mjs
  - lib/cli-help.mjs
  - test/entry-upgrade.test.mjs
  - test/cli-help.test.mjs
  - docs/reports/ENG-229-entry-pin-R-271.md
  - docs/reports/evidence/ENG-229-R271
  - "Final lane check: node lanes/lane.mjs check --cmd 'TMPDIR=/private/tmp node test/helpers/run.mjs test/entry-upgrade.test.mjs test/cli-help.test.mjs test/zero-setup-install.test.mjs'"
  - ".lane/gate.json records the final lane check result against the report commit"
decisions: []
questions: []
challenges: []
---

Read the operator's installed codex, monitor-codex and monitor-claude wrappers.
They select Codex release 0.160.0 by absolute path; monitor-claude uses that
same path as its default validator. Those installed files were read only.

The generator now supplies an entry-directory identity and native fallback to
its adapters. Each launch searches the current PATH, excluding entry directories,
other managed installs, directory aliases and executable aliases of wrappers.
Native symlinks are preserved instead of realpathed into a versioned release.
An executable supplied outside PATH remains a fallback. Explicit validator
selections retain their meaning. Machine upgrades prefer current PATH launchers
before older receipt paths, while ownership, recovery and removal checks remain.

Help is handled before entry, native lookup, stdin hooks, locks, record discovery,
background launches, builds or dependency installation. The shared parser renders
usage plus each module's option schema; positional transports handle bare help
before their operational arguments. Existing CLI help remains covered. Native
arguments after the adapter's separator retain their passthrough behavior.

Offline proof:

- `TMPDIR=/private/tmp node --test test/entry-upgrade.test.mjs test/cli-help.test.mjs test/zero-setup-install.test.mjs`: 61 passed, no failures or skips. The upgrade cases install copied product snapshots, change both native versions, delete the old release, and launch all four wrappers without reinstall. They also exercise entry aliases, quoted arguments, current validator lookup, help with absent native binaries, off-PATH fallback and installer checks after upgrade. Help checks cover 39 module entrypoints with an untouched scratch home.
- Selected `test/plugin-install.test.mjs` ownership/concurrent-install/rollback/shell-upgrade cases: six passed. The default-discovery assertion now expects the preserved Claude launcher symlink.
- Bounded host runner over the six changed discovery test files: 58 passed, five explicit provider-applicability skips, no failures.
- `acceptance/test/lessons.test.mjs` through the bounded host runner: all 21 passed after naming each private canary transport on PATH.
- Acceptance cases/environment/launch/results logic: 27 passed, no failures or skips.
- `acceptance/test/live-session.test.mjs`: two setup checks passed; the concurrent-worker validation case fails as proposed above. A direct host rerun reproduces green inner tests followed by exit 125, so runner containment alone does not explain it.
- `git diff --check`: passed before committing.

Initial broader attempts inside the enclosing lane sandbox encountered denied
nested sandbox-exec, Unix sockets and process inventory. Their inherited TMPDIR
also caused scratch-path applicability failures. Final test commands use
/private/tmp, and the new fixtures choose that root explicitly. Older entry
fixtures initially selected host harnesses from inherited PATH; they now supply
named fakes and private native homes. The bounded host discovery rerun verifies
those fixes. A superseded broad host acceptance run was stopped through its
coordinator after reproducing the corrected lesson-transport issue; it is not
claimed green. No live release harness, housekeeping loop or model task was run.

The focused lane check is the final action after this report is checked and
committed. Its exact report-commit result is retained in .lane/gate.json.
