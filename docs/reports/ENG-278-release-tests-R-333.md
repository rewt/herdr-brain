---
run: R-333
outcome: done
summary: |
  Fixed the review's utility-classification finding with shared Claude and Codex patterns and a shared option-aware subcommand scanner. Fresh entry, interactive resume and native session classification now ignore utility words used as option values, resume IDs or explicit prompts. Focused offline discovery validation passed: 78 tests passed, zero failed, and three optional native probes skipped. The code is committed; this report is checked and committed before the required final lane check.
headline: Utility words in option values and prompts now retain session handling.
blockers: []
proposals: []
learnings:
  - Claude -c means continue, whereas Codex -c consumes a config value; Claude --resume and -r optionally consume a session ID.
artifacts:
  - 'Code commit: bd1e469 on lane/release-tests'
  - discovery/native-command.mjs
  - discovery/launch.mjs
  - discovery/native-sandbox.mjs
  - discovery/test/launch.test.mjs
  - discovery/test/review.test.mjs
  - '/private/tmp/R-333-focused-unrestricted.tap: 78 passed, zero failed, three optional probes skipped'
  - '/private/tmp/R-333-focused.tap: restricted attempt stopped after nested sandbox and local fixture socket denials'
  - docs/reports/ENG-278-release-tests-R-333.md
  - /Users/rewt/development/rewt/.org/runs/R-333/report.md
  - '.lane/gate.json: final lane-check receipt written after the report commit'
decisions: []
questions: []
challenges: []
---

Only the first argument outside an option and its value can name a utility.
The utility patterns live once in discovery/native-command.mjs and are shared
by freshInteractive, interactiveResume and nativeSession. Existing help,
version, print, resume, continue, fork-session and worktree option checks remain.
Codex's exec, review, resume and fork commands continue to bypass fresh entry
while retaining native session handling.

The operator confirmed that `claude stop` names the utility and `claude -- stop`
is the explicit prompt. The shared scanner stops utility classification at `--`.
It skips separate and inline option values and Claude's optional resume ID.
Claude's flag-only `-c` is distinguished from Codex's value-taking `-c`.

Five focused classifier tests cover `claude --add-dir logs`, `claude -- stop`,
`claude --resume rm`, short and inline resume options, utility words later in
prompt text, Codex resume IDs, actual utilities after options, option-value
scanning, and the existing option exclusions. The review suite adds installed
shim checks for fresh Claude entry with `--add-dir logs`, `--model logs` and
`-- stop`; existing-lane resume with `--resume rm` and Codex `resume help`;
and literal utility passthrough with model options and `mcp list`.

Validation:

- `node test/helpers/run.mjs discovery/test/launch.test.mjs discovery/test/review.test.mjs discovery/test/native-sandbox.test.mjs`:
  81 tests total, 78 passed, zero failed or cancelled, three skipped; exit 0.
  The skips require explicit opt-in for real native Codex config, Claude read
  permissions and Codex sandbox boundary probes.
- `git diff --check`: passed before the code commit.
- The restricted attempt encountered `sandbox-exec: sandbox_apply: Operation
  not permitted` and `fake control socket did not start`. Only that attempt's
  test process group was stopped; the complete focused run then passed through
  approved command escalation. Tests stayed offline and called no model.

The change is limited to the review finding. No baseline, full suite, promotion
tier, release tier, live acceptance harness or project-wide housekeeping ran.

After record-checking this report and committing its repository copy, the final
action is the focused lane check through approved command escalation:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs discovery/test/launch.test.mjs discovery/test/review.test.mjs discovery/test/native-sandbox.test.mjs'
```

The resulting `.lane/gate.json` and validation log identify the final commit.
This report does not predeclare the gate result.
