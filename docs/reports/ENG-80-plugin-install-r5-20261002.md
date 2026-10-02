---
run: R-100
outcome: done
summary: |
  Resolved the independent review's mode-only recovery finding. Recovery now compares exact before and after byte-and-mode states before treating matching original bytes as an untouched file, so failed or terminated reinstallation restores the inspected permissions after an applied mode-only replacement.
  Six scratch regressions cover failure and termination after replacement, before replacement, and after a distinct operator chmod. The two applied-replacement cases reproduced the original bug; all six pass with the fix. All 39 plugin installation tests and the full offline suite pass, with 547 passes, zero failures and five existing optional skips.
  The fix is committed on the lane, and main remains its ancestor. Report checking, the report commit and a final clean-commit lane gate complete the handoff.
headline: Plugin recovery restores permissions after interrupted mode-only reinstallations
blockers: []
proposals: []
learnings:
  - Identical before and after bytes do not mean a replacement was untouched when its mode changed. Recovery must compare exact byte-and-mode states before applying its exception for a caller's chmod of original bytes.
  - Reinstallation can plan a mode-only shell replacement because the shell receipt retains its original mode while inspection captures a later operator chmod. Recovery must restore that inspected mode rather than the original installation receipt's mode.
artifacts:
  - Commit subject Restore inspected modes after interrupted entry replacement on lane/plugin-install
  - Commit subject Report mode-only entry recovery correction on lane/plugin-install
  - herdr/entry-transaction.mjs; herdr/README.md; test/plugin-install.test.mjs
  - docs/reviews/plugin-install/ca20a64-r1.md
  - /Users/rewt/development/rewt/.org/settle/R-97.validation.log
  - /private/tmp/eng80-r100-red.log
  - /private/tmp/eng80-r100-plugin-install.log
  - /private/tmp/eng80-r100-core.log
  - /private/tmp/eng80-r100-runner.py
  - docs/reports/ENG-80-plugin-install-r5-20261002.md
  - /Users/rewt/development/rewt/.org/runs/R-100/report.md
  - /private/tmp/eng80-r100-final-gate.log; .lane/gate.json
decisions:
  - text: Compare the exact before-state first and restore the exact after-state before allowing the exception for original bytes with a caller's distinct mode.
    category: design
    why: Applied mode-only replacements must roll back while untouched files and separate operator chmods retain their current state.
  - text: Inject failures and process termination at the actual shell replacement boundary in isolated scratch installations.
    category: prover
    why: Both synchronous rollback and subsequent recovery need executable evidence of permissions restoration, staged-file cleanup and retained surrounding installation state.
questions: []
challenges: []
---

The independent review has one moderate finding. Recovery previously skipped a
started replacement whenever its current content matched the inspected original
content, without first checking the planned replacement's mode. Reinstallation
after a shell chmod from 0644 to 0600 can replace identical bytes at the receipt's
original mode of 0644. Both synchronous rollback and recovery after termination
then left 0644 behind and removed the recovery journal.

Recovery now first recognizes an exact original state. Otherwise, an exact
replacement state is restored to the inspected original bytes and mode. Only a
state that matches neither exact state can use the existing exception for an
operator chmod of the original bytes. Other recovery edits still refuse.

The six regressions first install a shell file at 0644, then change its mode to
0600 before reinstallation. They inject either an EIO failure or process exit
at three points: while a replacement remains staged, immediately after its
rename, or after a separate operator chmod to 0640 before rename. Each witness
checks durable write intent, identical planned bytes and the 0600-to-0644 mode
change. Recovery must preserve or restore every adapter, receipt and shell
file's bytes and mode, retain the installed runtime, remove the journal and
temporary replacement, release the installation lock and remain idempotent.
The distinct operator mode of 0640 must survive unchanged.

Validation:

- Before changes, npm test passed 541 tests with zero failures and five optional
  skips, out of 546 tests.
- Against the original recovery code, the six new cases had four passes and
  two failures. Both applied-replacement cases observed 0644 instead of 0600.
- With the correction, the complete plugin installation suite passed all 39
  tests with zero failures or skips.
- After changes, npm test passed 547 tests with zero failures and five optional
  skips, out of 552 tests. The skips remain three opt-in native sandbox cases
  and the optional console and MCP dependency cases.
- The inherited validation log also had zero failures; it contained no further
  validation finding to resolve. No previous report was changed.

The focused and full post-change suites run with an isolated actor and a
ten-minute process-group bound. Each new fixture owns its HOME, ZDOTDIR, entry
bin and native stub, sets its own ORG_ACTOR, and bounds every subprocess and test.
No model, network download, live installation, launchd service, housekeeping
loop or Herdr pane is involved in this correction's tests.

Native Herdr launch interception and supervisor housekeeping instruction
transport remain supported by the earlier canary evidence recorded in
docs/reports/ENG-80-plugin-install-r4-20261002.md. This correction does not rerun
that canary or claim model execution, housekeeping startup, network downloads
or launchd coverage. Absolute native binary entry needs a harness entry hook or
explicit launch adapter. Desktop entry needs the app's instruction or entry
transport. Remote entry needs installation on the remote host or a remote
harness hook; those transports remain tracked by ENG-93.

Main remains at commit subject Brief for ENG-94: the supervisor module and is
an ancestor of this lane. Nothing is pushed, published, promoted or activated.
After record check and the report commit, the final action is lane check with
npm test. Its bounded output goes to /private/tmp/eng80-r100-final-gate.log,
and .lane/gate.json records the final committed head and gate result. Then this
run stops.
