---
run: R-12
outcome: done
summary: |
  Corrected all five independent-review findings. The supervisor now creates its ignored runtime directory before taking the session-open lock, with regression coverage for a fresh checkout and for the legacy checklist-adjacent STOP default. Script headers, repository boundaries, and cutover ordering are now explicit, and both test suites plus every original acceptance check pass.
headline: The folded supervisor now works from a fresh checkout and all checks pass
blockers: []
proposals: []
learnings:
  - A dry run returns before the session-open lock, so it cannot prove that a missing runtime directory works in a real open-session path.
  - Callers that omit --ledger-dir still use the checklist directory for STOP, session ledgers, and the open-session lock.
  - The ignored deliver-r1.sh is a completed one-off whose last command still names the old arm script, so cutover must retire it rather than preserve it as runtime state.
artifacts:
  - "commit 5e0ec45: independent review round 1 record"
  - "commit a7b1e41: fresh-checkout runtime fix, regression tests, script documentation, repository boundary, and corrected cutover"
  - "npm test: 140 pass, 0 fail"
  - "npm --prefix console test: 92 pass, 0 fail"
  - "node brain/bin/brain.mjs status: not watching · service on"
  - "env -u NO_COLOR node console/app.mjs --print 140x45 --project herdr-org: rendered successfully"
  - "sh supervisor/arm-watch.sh R-1 --dry-run: R-1 already has a recorded report; nothing to watch"
---

The Moderate finding was valid: `takeTurn()` tried to create
`.lane/supervisor/.session-open.lock` with a non-recursive `mkdir` before anything created
`.lane/supervisor`. The catch path mistook the missing parent for a stale lock and retried forever.
`openSession()` now recursively creates the resolved ledger directory before `takeTurn()`, does
nothing in dry-run mode, and stops with the directory and underlying error if creation fails.

`test/settle-watch.test.mjs` now exercises a non-dry `--open` with an absent explicit ledger
directory. It asserts that the process advances instead of timing out and that the directory was
created. A second regression puts `STOP` beside the checklist and omits `--ledger-dir`, proving
the old caller contract remains intact.

The two tracked shell scripts now say both what they do and who runs them, and `continue.sh`
again documents its optional focus and dry-run arguments. `AGENTS.md` now scopes `brain/` as the
model-calling background service with private state and no event-log writes, and identifies
`supervisor/` as the tracked settle prompt and scripts.

The round-one-b report's Cutover section now tells the operator to wait for every watcher armed
from the old scripts to fire before removing those scripts or their checklist. It also identifies
the stale absolute arm-script call in `.lane/supervisor/deliver-r1.sh` and says to retire that
completed one-off after promotion. No file outside this worktree was changed.

All eight original Brain commits remain ancestors of the branch head. `git diff --check` passes,
the root and console suites pass, the console frame renders, the folded Brain status command
runs, and the tracked arm script completes its dry-run path.
