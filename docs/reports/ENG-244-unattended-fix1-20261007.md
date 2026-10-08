---
run: R-311
outcome: done
summary: |
  Resolved all three findings from the unattended-mode review in implementation commit 02d0ca6 on lane/steward-unattended. Unmarked supervisor launches use combined conversation mode until their canonical project has a fleet chat receipt, then ops; explicit kinds override and the resolved kind is persisted. Claude receives one adapter settings object containing both hook events, and native passthrough/resume launches receive only the question guard. All 25 selected offline checks passed with no failures. This report is checked and committed before the required final lane check, restricted to the touched test files.
headline: Supervisor conversation defaults and native question hooks now match the operator's decision.
blockers: []
proposals: []
learnings:
  - Fleet chat receipts live in chats.json beside fleet.json and are keyed by canonical Git common-directory identity, not checkout paths or project labels.
artifacts:
  - 'Implementation commit: 02d0ca6 on lane/steward-unattended'
  - supervisor/unattended.mjs
  - supervisor/chats.mjs
  - supervisor/session-hooks.mjs
  - discovery/adapters/claude.mjs
  - discovery/adapters/codex.mjs
  - supervisor/test/entry.test.mjs
  - discovery/test/native-sandbox.test.mjs
  - '/tmp/R-311-focused-tests.tap: 25 passed, 0 failed, 88 unselected cases skipped'
  - docs/reports/ENG-244-unattended-fix1-20261007.md
  - '.lane/gate.json: final lane-check receipt written after the report commit'
decisions: []
questions: []
challenges: []
---

The correction is limited to the three findings in
`docs/reviews/steward-unattended/b40ccbe-r1.md`.

The chat launcher and unattended policy share the existing chat-state parser.
An unmarked supervisor resolves to `combined` without its canonical identity in
the fleet's chat receipts and to `ops` with one. Explicit `ops`, `chat` and
`combined` retain their meaning. Unreadable receipt state defaults to ops.
The launch environment records the resolved kind before writing the existing
pane receipt, so native restore retains the launch decision even when chat state
changes afterward. Worker and bypass guards still take precedence.

Claude's adapter constructs one hooks object containing `SessionStart` and
`PreToolUse` and emits one `--settings` flag. Additional hook events can be
added to that same object. A complete project SessionStart hook still suppresses
the adapter's duplicate entry. Both native passthrough paths call
`unattendedHookArguments` directly, keeping the question guard without adding
an adapter SessionStart hook during resume.

Selected checks ran through the offline runner against only
`supervisor/test/entry.test.mjs` and `discovery/test/native-sandbox.test.mjs`.
They cover missing and present chat receipts, a checkout-key mismatch, explicit
ops/chat overrides, unreadable receipt state, launch-kind persistence, a single
Claude settings flag, Claude and Codex interactive resume with inherited
supervisor role, existing project hook reuse, worker/headless launches and
native sandbox hook merging. All 25 selected checks passed. `git diff --check`
passed. The final lane check uses an explicit command selecting the affected
launch checks in these same two files, with its result recorded in the gate
receipt after this report commit.

The prior report's live Codex hook and native-presence limitations remain;
these offline regressions validate launch construction and receipts. No live
acceptance, promotion or release tier was run.
