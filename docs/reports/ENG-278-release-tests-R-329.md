---
run: R-329
outcome: done
summary: |
  Updated the minimal console snapshots to the intended chat footers and expanded width-boundary, chat-key, pipeline-key and print-mode coverage without changing console code. Updated discovery session expectations to require the unattended question guard for existing lanes, resume, fork, review and batch sessions. Utility coverage exposed a Claude entry-classifier mismatch; fixed it so non-session commands remain literal passthrough. All 330 console tests and all 15 discovery review tests passed. The code is committed; this checked report is committed before the required final lane check.
headline: The stale release tests are fixed and utility commands keep their original arguments.
blockers: []
proposals: []
learnings:
  - Claude utility passthrough must be recognized by both freshInteractive and nativeSession; checking only nativeSession is insufficient because fresh entry runs first and adds workflow and hook arguments.
artifacts:
  - 'Code commit: 4350088 on lane/release-tests'
  - console/test/fixtures/minimal-40x24.txt
  - console/test/fixtures/minimal-100x24.txt
  - console/test/minimal.test.mjs
  - console/test/pipeline-view.test.mjs
  - discovery/launch.mjs
  - discovery/test/review.test.mjs
  - '/private/tmp/R-329-console.tap: 330 passed across 27 files, zero failed or skipped'
  - '/private/tmp/R-329-discovery-unrestricted.tap: 15 passed, zero failed or skipped'
  - '/private/tmp/R-329-discovery-regression.tap: regression reproduced Claude agents receiving entry policy and question hooks'
  - '/private/tmp/R-329-discovery.tap: restricted run, 14 passed and one nested macOS sandbox fixture denied'
  - docs/reports/ENG-278-release-tests-R-329.md
  - /Users/rewt/development/rewt/.org/runs/R-329/report.md
  - '.lane/gate.json: final lane-check receipt written after the report commit'
decisions: []
questions: []
challenges: []
---

The 40-column snapshot now expects `Tab · Enter · C chat · q quit`.
The 100-column snapshot retains `p pipeline` and includes `C chat`.
Footer checks cover 20, 31, 32, 40, 59, 60, 80, 100 and 140 columns.
Minimal-session key checks cover both `C` and `p` below, at and above the
footer thresholds, including widths where the pipeline key is not advertised.
Print mode explicitly refuses project chat creation and still issues only reads.
The existing full-console chat, text-entry, footer and pipeline assertions were
inspected and all console test files ran with Ink and React present.

Discovery checks preserve original session arguments, cwd and worktree inventory
while asserting the question tool matcher, unattended hook and operations mode.
Eleven existing-project session launches cover Codex and Claude, including
headless sessions; pre-registration native sessions retain their existing
passthrough assertions. Seventy-eight utility launches cover both the canonical
project and its assigned lane: version/help flags, Codex login/logout and other
non-session subcommands, and Claude auth and its utility subcommands.

The expanded utility check first failed on `claude agents`: its native invocation
received `--settings` and `--append-system-prompt` in a new entry lane. The
existing nativeSession classifier already excluded agents, attach, logs, stop,
kill, rm, respawn and setup-token; freshInteractive did not. Those commands now
bypass entry, and interactiveResume uses the same Claude utility list.
Console rendering and unattended-hook generation are unchanged.

Validation:

- `node test/helpers/run.mjs console/test/*.test.mjs`: 330 passed across 27 files;
  zero failed, cancelled or skipped; exit 0.
- `node test/helpers/run.mjs discovery/test/review.test.mjs`: 15 passed;
  zero failed, cancelled or skipped; exit 0 after approved command escalation.
  The restricted run's sole failure was `sandbox-exec: sandbox_apply: Operation
  not permitted` in the canonical validation fixture, before its expected exit 17.
- `git diff --check`: passed.

The console dependencies came from the explicitly authorized read-only symlink
to canonical console/node_modules. It was removed before committing and is not
part of the change. No dependency install, baseline, npm test, promotion tier,
release tier, live acceptance harness or host test slot was used.

After checking this report and committing its repository copy, the final action
is the focused lane check, outside the worker sandbox for the nested sandbox
fixture:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs discovery/test/review.test.mjs'
```

The resulting `.lane/gate.json` names the final report-inclusive commit and
validation log. This report does not predeclare the gate result.
