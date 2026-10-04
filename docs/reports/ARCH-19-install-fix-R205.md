---
run: R-205
outcome: done
summary: |
  Resolved all three independent review findings on the existing install lane. Machine installer fixtures now supply explicit scratch Codex and Claude config destinations; native startup and resume honor the canonical project's entry opt-out before any fleet join or controls; dependency installation resolves its directory through import.meta.url for the documented Node 20 minimum. Regression tests and offline acceptance passed, with evidence retained in the repository. The requested fresh macOS account rehearsal and live native UI observation remain with the operator.
headline: Install review fixes pass the focused and offline acceptance checks
blockers: []
proposals: []
learnings:
  - Changing HOME alone does not isolate native hook destinations when CODEX_HOME or CLAUDE_CONFIG_DIR is inherited; machine installer fixtures must explicitly set both.
  - Native entry must read projectEntrySettings from the canonical checkout before joining the fleet, resolving supervisor bindings or opening project controls, including when a linked worktree enables its own entry.
  - Node 20.0 through 20.10 supplies import.meta.url without import.meta.dirname; the dependency installer can use fileURLToPath without raising the documented minimum.
  - The outer lane sandbox prevents offline acceptance scratch socket and nested sandbox-exec fixtures from operating; the same offline suite passed outside that outer sandbox with its own boundaries retained.
artifacts:
  - commit a1c59de on lane/install
  - herdr/native-entry.mjs
  - herdr/dependencies.mjs
  - test/zero-setup-install.test.mjs
  - test/fleet.test.mjs
  - test/plugin-install.test.mjs
  - test/release.test.mjs
  - acceptance/run.mjs
  - acceptance/plugin-entry.mjs
  - docs/reports/evidence/ARCH-19-R205/README.md
  - docs/reports/evidence/ARCH-19-R205/install-corrected.tap
  - docs/reports/evidence/ARCH-19-R205/install.tap
  - docs/reports/evidence/ARCH-19-R205/acceptance-unsandboxed.tap
  - docs/reports/evidence/ARCH-19-R205/node20-before.log
  - docs/reports/ARCH-19-install-fix-R205.md
decisions: []
questions: []
challenges:
  - This correction proves the review findings with offline fixtures; it does not claim that the operator's fresh-account rehearsal or live native UI observation has run or that release acceptance is complete.
---

The inherited settle validation log passed 148/148 checks. The independent review
had three findings, all addressed without changing the earlier report.

Installer fixtures now set both native configuration destinations in the plugin,
fleet, legacy release, release acceptance and native plugin-canary environments.
The fleet regression simulates another account entirely in scratch and compares
its original hook bytes and mode after installation and removal. The existing
child release-suite regression now also verifies both parent hook files.

The actual installed Codex and Claude hooks are tested on disabled startup and
resume. Resume enters through a linked worktree whose local config enables entry
while the canonical checkout disables it. No Herdr calls, fleet state, record,
runtime state or pane receipt are created. The dependency build regression
deletes `import.meta.dirname` after the shebang and exercises the actual plugin
build, prerequisite refusal before npm and repeated dependency reuse.

Tests were added before implementation. Five initial cases reproduced the hook
isolation and opt-out failures. The compatibility fixture initially inserted its
fault injection before the shebang; that fixture mistake was corrected. A
separate scratch copy of the original dependency installer then reproduced the
actual `ERR_INVALID_ARG_TYPE` with the dirname property absent.

Validation: plugin and fleet tests passed **60/60** in the focused installer run;
the corrected zero-setup file passed **18/18**. The initial offline acceptance run
was restricted by the outer lane sandbox; the same suite outside it passed
**155/155**, with no skips. Full attempts and commands are retained under
`docs/reports/evidence/ARCH-19-R205/`. Product/acceptance syntax checks and
`git diff --check` passed. I reviewed the final diff against the ask and findings.

No baseline, full npm suite, promotion suite, lanes suite, live release harness,
model call, account rehearsal or project-wide housekeeping loop was run. The
final required command after committing this checked report is
`node lanes/lane.mjs check`; its output and receipt are retained locally as
`.lane/ARCH-19-R205-check.log` and `.lane/gate.json`.
