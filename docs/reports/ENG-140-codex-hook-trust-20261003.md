---
run: R-179
outcome: done
summary: |
  Removed the tracked Codex project hook that stopped unattended workers at interactive trust. Retained Codex supervisor entry through the existing adapter launch argument and Claude's persistent SessionStart wiring. Added a tracked-file regression guard, exercised the Codex launch hook on all four lifecycle sources, updated dependent tests and documentation, and passed all 38 focused entry tests. Implementation is committed; this report is checked and committed before the final focused lane check.
headline: Codex workers no longer inherit a repository hook that requires interactive trust
blockers: []
proposals: []
learnings:
  - "Codex supervisor launch arguments already inject hooks.SessionStart when the project has no persistent hook; worker launch arguments supply none."
  - "A direct native restore that loses hook launch arguments needs manual supervisor entry; the durable pane receipt supplies binding only when a hook runs."
artifacts:
  - "111aa01: Remove tracked Codex hook that blocks unattended workers"
  - "supervisor/test/entry.test.mjs"
  - "supervisor/README.md"
  - "node --test supervisor/test/entry.test.mjs: 38 passed, zero failures or skips"
  - "git diff --cached --check: passed before implementation commit"
  - "Final lane check command: node lanes/lane.mjs check --cmd 'node --test supervisor/test/entry.test.mjs'"
decisions: []
questions: []
challenges: []
---

Read the dispatch brief, the record brief for this run, both work items, and the
supervisor entry and discovery adapters, including the entry implementation on main.

Deleted `.codex/hooks.json`. No adapter, supervisor runtime, Claude hook, trust
setting, or dialog configuration changed. Updated the supervisor guide to describe
Codex's adapter hook, the unattended-worker restriction, and manual recovery when
a restore loses launch arguments.

The new regression guard checks Git's tracked files and the checkout for the Codex
project hook. It failed before deletion with `.codex/hooks.json` as the tracked
path, then passed after the deletion was staged. The new supervisor test obtains
the existing adapter's `-c hooks.SessionStart` argument for this repository,
verifies worker arguments are empty, and executes the supplied command with
startup, resume, clear, and compact payloads. Each prints exactly one cold-start
brief. Fixtures disable housekeeping to keep those invocations foreground.
Existing CLI adapter tests also verify actual native arguments for both roles.

Updated restore coverage to use Codex's launch command and retained Claude's
project-hook coverage. An intermediate focused run found four additional tests
reading the deleted Codex file; those now exercise Claude's retained project hook,
while Codex's four sources are covered by the new launch-hook test. The final
focused file run passed all 38 tests in approximately 13 seconds.

All validation was offline. No model, live worker dispatch, native trust dialog,
baseline, full suite, promotion suite, lanes suite, or live acceptance harness was
run. The unattended-worker result is supported by removing the reported trigger
and checking worker arguments; a fresh native UI launch was not exercised here.

The implementation commit precedes this report. After the record CLI validates
the report, it is committed, then lane check runs last with the same focused test
file. Its result is supplied in the final response; no promotion or push is done.
