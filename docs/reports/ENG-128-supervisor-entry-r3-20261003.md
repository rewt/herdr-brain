---
run: R-173
outcome: done
summary: |
  Resolved both promotion failures by updating obsolete policy assertions in test/plugin-install.test.mjs to the intentional native SessionStart recovery contract. Canonical workspace resolution already worked; neither failure required a production code change. All 39 tests in that file pass, with evidence committed in a808867. This report is checked and committed before the final lane check, which uses only the same focused test file.
headline: Supervisor entry promotion tests now verify native session recovery
blockers: []
proposals: []
learnings:
  - "Both promotion failures were in test/plugin-install.test.mjs and failed on the same obsolete manual housekeeping instruction; the workspace case had already passed its canonical cwd assertion."
  - "Commit 0ea52d8 intentionally replaced manual unconditional housekeeping instructions with native SessionStart recovery; installed hooks must point into the pinned runtime."
artifacts:
  - "a808867: Align installed supervisor tests with native entry recovery"
  - "test/plugin-install.test.mjs"
  - "docs/reports/ENG-128-supervisor-entry-r3-evidence/plugin-install-tests.log"
  - "node test/helpers/run.mjs test/plugin-install.test.mjs: 39 passed, zero failures or skips"
  - "git diff --check: passed"
  - "Final lane check command: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/plugin-install.test.mjs'"
decisions:
  - text: "Update both failing test expectations to the intentional native SessionStart contract, retaining all other assertions."
    category: prover
    why: "Both failure stacks expect the former policy text after canonical checkout assertions pass; the earlier implementation intentionally changed that text."
questions: []
challenges: []
---

Read the ask, R-173 run brief, ENG-128 record history, prior report, and copied
promotion log. Reviewed this correction against the brief and the original
implementation's policy change in commit 0ea52d8.

Failure 102, `release carries entry, pins final versions, rolls back and restores
exact shell state`, expected `At session entry, start the default project
schedule`. That behavior changed intentionally: native SessionStart runs the
foreground entry and resumes housekeeping only when enabled and resume are true.
Updated the assertion to verify that contract. Replaced the following obsolete
absolute housekeeping-command expectation with verification that the hook command
points to an existing `supervisor/session-start.mjs` inside the activated release.
The existing activation, rollback, pinned-version, native-binary and exact shell
restoration assertions remain intact and passed.

Failure 107, `supervisor resolves the selected workspace to canonical Git instead
of its plugin cwd`, failed on exactly the same obsolete policy sentence. Its
preceding canonical checkout assertion had succeeded in the promotion log.
Updated its policy/hook assertions; canonical project selection from the linked
workspace and rejection of missing or conflicting plugin context remain intact
and passed. This failure does not demonstrate a workspace-resolution regression.

Both cases now verify policy coverage for startup, resume, clear and compact;
enabled/resume housekeeping conditions; dead open-run watcher recovery; retained
stale locks; and diagnostics that allow session startup after entry failure.
They also inspect the actual native hook matcher for all four sources and check
the installed runtime's hook command and file. Production code is unchanged.
Runtime idempotence and failure-path coverage shipped in the earlier entry tests;
this correction verifies the installed policy and hook transport offline, without
claiming a live reboot, native hook trust flow, or housekeeping recovery exercise.
Existing documented native hook availability and trust limitations remain.

Ran only the failing/touched test file through the project's offline runner:
39 passed, zero failures or skips, in approximately 68 seconds. That file's
existing installation-isolation test internally invokes its scratch release
tests; no additional test file was independently selected. The first runner
attempt could not inspect fixture ownership because the sandbox denied `ps`;
the permitted rerun completed successfully. Evidence is retained in the tracked
log above. No baseline, full suite, promotion suite, lanes suite, or live
acceptance harness was run.

Committed the test change and passing evidence before writing this report.
The report is checked with the record CLI and committed next. The final action
is lane check with an explicit command for this same file, respecting the
requested test scope; its result is reported in the final response. Shared Git
configuration and excludes were not edited.
