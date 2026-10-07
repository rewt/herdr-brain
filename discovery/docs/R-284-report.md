---
run: R-284
outcome: done
summary: |
  Replaced Claude's shared-worktree add-dir grant with scoped native Read permissions and sandbox allowRead. Working directories are the checkout and private run temp; sibling lanes receive native Edit and shell write denies, with a native PreToolUse guard covering file writes to lanes created after launch and symlink targets. Codex inline project trust and Claude's safe-ownership socket fallback remain intact. Focused offline checks passed; implementation and this checked report are committed before the final lane check.
headline: Claude sessions can read lane reports without gaining permission to edit sibling lanes.
blockers: []
proposals: []
learnings:
  - Claude 2.1.292 scoped Read allow rules return an explicit rule decision before the interactive outside-read gate; sandbox allowRead alone does not grant file-tool permission.
  - Claude file tools consult Edit path rules for Edit, Write and NotebookEdit; a Write path rule alone does not enforce this boundary.
  - A launch-time sibling deny list needs a native PreToolUse guard to protect lanes created after launch; the guard should deny cross-lane targets and leave ordinary permissions unchanged.
  - Claude's explicit blockReadsOutsideWorkingDirectories setting takes precedence over scoped Read allow rules; do not clear the operator's persistent read block to prevent a prompt.
artifacts:
  - b3625e8 — correction, offline regressions and native-access documentation
  - lane/steward-prevent
  - discovery/native-sandbox.mjs
  - discovery/lane-file-access.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/docs/worktree-access.md
  - discovery/docs/R-284-report.md
  - /Users/rewt/development/rewt/.org/runs/R-284/report.md
  - /private/tmp/R-284-focused.tap — focused offline run, 31 passed and 1 existing opt-in OS sandbox probe skipped
decisions:
  - text: Use scoped Claude Read permissions and sandbox allowRead instead of registering the shared lane root as an additional working directory.
    category: security
    why: The supervisor's correction explicitly requires read-only shared-lane access, and the installed native permission functions and interactive prompt gate prove that scoped Read rules prevent the prompt without granting edits.
  - text: Deny sibling Edit and shell writes, reject configured write roots overlapping siblings, and add a per-launch native PreToolUse file-write guard.
    category: security
    why: Native Edit rules deny Edit, Write and NotebookEdit even with conflicting allows; a tool-time guard also protects newly created lanes and resolved symlink targets without granting any ordinary edit permission.
questions: []
challenges: []
---

Read the correction brief, run brief and full supervisor decision on ENG-242.
The correction keeps both accepted mechanisms: Codex's per-launch inline
projects trust (including its inherited-policy branch) and Claude's safely owned
shared socket fallback. No operator trust or settings file was changed.

Claude now receives --add-dir only for private run temp. The primary checkout
remains its working directory. The generated session file supplies scoped
Read(//absolute/worktrees/**) and sandbox allowRead for the project's worktree
root. Existing record, request and configured extra write roots use scoped Edit
permissions and sandbox allowWrite, rather than additional working directories.
Supervisors get an Edit deny and sandbox denyWrite for the shared root. Workers
get those denies for sibling entries, resolved spellings and nested layouts;
configured write roots overlapping siblings are refused.

A native PreToolUse command hook checks Edit, Write and NotebookEdit at tool
time. It denies shared-root targets outside the current checkout, including late
sibling lanes, relative paths and aliases into those lanes. Missing leaves are
resolved through existing ancestors; dangling links and unknown targets fail
closed. Reads and ordinary edit requests produce no hook decision. Existing
hooks are retained, and the generated command quotes paths with spaces/apostrophes.

Offline proof uses installed Claude Code 2.1.292 and Codex CLI 0.160.0. The
Claude preload imports the actual DE read and Iy edit permission functions and
evaluates the exact installed san prompt-gate body with an interactive auto-mode
context. Without the generated Read allow, the supervisor's lane read is ask
with a workingDir reason and opens the outside-read gate. With the allow, it is
allow with a rule reason and the gate stays closed, while the shared root remains
outside the working-directory predicate. Both roles deny sibling Edit, Write and
NotebookEdit in default, acceptEdits, auto and bypass modes despite a conflicting
broad Edit allow. A worker's symlink to its sibling is denied; its own lane stays
editable. The generated hook command is tested offline against late siblings,
aliases, malformed targets and ordinary writes. Codex config-reader trust,
adapter launch/resume, persistent-config preservation, temp cleanup, socket
ownership fallback and existing peer/coordination denies also pass.

Validation during development:

    MONITOR_TEST_CODEX_CONFIG=/Users/rewt/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex MONITOR_TEST_CLAUDE_READ=/Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe node --test discovery/test/native-sandbox.test.mjs

Result: 31 passed, 0 failed, 1 existing opt-in OS sandbox probe skipped.
git diff --check passed. No live session, model, pane mutation, promotion,
project-wide housekeeping or release acceptance harness was run.

Native explicit read blocks, ask/deny rules and managed policy retain precedence.
Operator overrides are diagnosed under the existing native-settings policy;
unknown builds retain the unsupported-native warning. The proof is an offline
permission/prompt decision check, not a live TUI canary. Mechanism, commands and
limits are documented in discovery/docs/worktree-access.md.

After record check and committing this report, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && MONITOR_TEST_CODEX_CONFIG=/Users/rewt/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex MONITOR_TEST_CLAUDE_READ=/Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe node --test discovery/test/native-sandbox.test.mjs'

The final clean-commit result is retained in .lane/gate.json; this report remains
unchanged after that last command.
