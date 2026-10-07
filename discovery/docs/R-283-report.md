---
run: R-283
outcome: done
summary: |
  Monitor now sets PYTHONPYCACHEPREFIX to pycache inside each run temp for Codex and Claude, including Claude's generated shell environment. Inherited PYTHONPYCACHEPREFIX and PYTHONDONTWRITEBYTECODE are preserved. Offline adapter tests prove actual Python imports leave clean worktrees, respect operator overrides and remove default caches with run cleanup. Documentation and implementation are committed; this report is committed before the final lane check.
headline: Monitor sessions keep Python bytecode caches out of worktrees by default.
blockers: []
proposals: []
learnings: []
artifacts:
  - e8ba50150c012231549f3db61471ba37405c3e7d — implementation, documentation and offline regressions
  - lane/pycache-prefix
  - discovery/temporary.mjs
  - discovery/native-sandbox.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/README.md
  - discovery/docs/R-283-report.md
  - node --test discovery/test/native-sandbox.test.mjs — 33 passed, zero failed, one existing opt-in Codex boundary probe skipped
  - Python import probes with PATH=/nonexistent — all six explicitly skipped because python3 was unavailable
decisions:
  - text: Default Python bytecode to a pycache subdirectory of the run temp only when neither Python environment variable is inherited, and copy inherited Python values into Claude settings.env.
    category: tooling
    why: Keeps imports out of worktrees while respecting the operator's environment, including explicit empty values, within the existing run-temp lifecycle.
questions: []
challenges: []
---

The shared temporaryEnvironment helper accepts the launch environment explicitly,
so callers with a supplied env do not accidentally inherit the current process's
Python preferences. Validation also receives the default through its existing
helper call. Claude's settings.env carries the same Python values because its
shell commands receive generated settings as well as the launch environment.

Six offline adapter cases launch the real Monitor entry adapters against a native
stand-in that imports a local Python module. Both harnesses prove default cache
files exist under the run temp during execution, then disappear at normal exit,
and git status remains clean with no worktree __pycache__. An operator prefix
receives the cache and survives run cleanup. PYTHONDONTWRITEBYTECODE suppresses
cache creation without injecting a prefix. Additional environment assertions
cover both inherited variables together and explicitly empty values.

Development validation: node --test discovery/test/native-sandbox.test.mjs passed
33 tests with zero failures and one existing opt-in native sandbox probe skip.
Running only the six Python cases with PATH=/nonexistent verified their explicit
python3-unavailable skip messages. git diff --check passed. The adapter stand-ins
call no model and make no network requests.

After checking and committing this report, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && node --test discovery/test/native-sandbox.test.mjs'

This binds the normal fast tier and the changed regression file to the final
clean commit in .lane/gate.json. The regression file is included explicitly
because it is outside the inherited fast tier. The final gate result remains
in the lane receipt without changing the report after that check.
