---
run: R-288
outcome: done
summary: |
  Fixed all three review findings. Claude preserves Python bytecode settings in CLI and native settings sources without injecting a competing default. Empty inherited Python values now allow the run-temp cache default, and Python import probes skip explicitly when python3 is missing or non-functional. The implementation, documentation and offline regressions are committed; this report is checked and committed before the final lane check.
headline: Python cache defaults now respect Claude settings and handle empty inherited values.
blockers: []
proposals: []
learnings: []
artifacts:
  - cbaa7cc — implementation, documentation and offline regressions for all three review findings
  - lane/pycache-prefix
  - discovery/temporary.mjs
  - discovery/native-sandbox.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/README.md
  - discovery/docs/R-288-report.md
  - node --test discovery/test/native-sandbox.test.mjs — 48 passed, zero failed, one existing opt-in sandbox probe skipped
  - Python import probes with isolated PATH — 14 explicit skips with python3 missing and 14 explicit skips with a stub exiting 7
decisions:
  - text: Add the Python cache default only when no nonempty Python bytecode choice is inherited from the process or configured in Claude settings, preserving settings in their native scopes.
    category: tooling
    why: Prevents generated defaults from replacing operator choices while matching Python's treatment of empty environment values.
questions: []
challenges: []
---

Read the R-283 review at the canonical checkout's
.lane/reviews/pycache-prefix/35eadda-r1.md and fixed its three Minors.

Claude examines user, project, local, managed and CLI settings for nonempty
PYTHONPYCACHEPREFIX or PYTHONDONTWRITEBYTECODE. When a settings source supplies
either, generated settings leave those Python fields in their native scopes,
and the launch environment retains the original inherited values rather than
the generated cache default. This avoids competing defaults in both the
generated settings file and the harness process.

temporaryEnvironment now chooses its default using only nonempty values.
Inherited values pass through, except that an empty PYTHONPYCACHEPREFIX becomes
the default when neither Python variable is nonempty. The README documents this
behavior and Claude settings inheritance. The Python availability probe skips
on any spawn error or nonzero --version status, with an explicit reason.

Offline regressions cover user, project, local, inline CLI, file CLI, managed
settings and managed fragments. Both adapters run actual Python imports for
the default, operator prefix, disabled bytecode, empty prefix, empty disable
and both-empty cases. Claude also imports with CLI-configured prefix and
disabled bytecode. These cases check a clean worktree, cache placement and
run-temp cleanup. Settings tests use private files or mocks; adapters use a
native stand-in and call no model or network service.

Development validation: the changed test file passed 48 tests with zero
failures and one existing opt-in sandbox probe skipped. Two isolated-PATH
runs selected all 14 Python import probes: each explicitly skipped with Python
absent, and each explicitly skipped with a non-functional stub exiting 7.
git diff --check passed.

After record check and the report commit, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && node --test discovery/test/native-sandbox.test.mjs'

This binds the normal fast tier and changed regression file to the final clean
commit. The gate result remains in .lane/gate.json without editing this report
after the check. Real Codex and Claude binaries were not exercised.
