---
run: R-365
outcome: done
summary: |
  Implemented the narrowed committed scoped chat mode, its installed wrapper, launcher-owned kernel identity binding, same-tab layout, bounded stop and committed command/cwd presets. Arbitrary input/run and foreign or own-pane mutations refuse. Targeted offline fake-Herdr checks, installer transaction regressions and a model-free native Claude 2.1.296 exclusion probe passed. The code is committed on lane/chat-scoped; the final clean-tree lane check follows the report commit.
headline: Scoped chats can manage their tab with bounded stop and committed presets.
blockers: []
proposals: []
learnings:
  - Excluded wrappers must clear inherited Git repository, object and config variables before reading canonical HEAD; otherwise a chat can substitute an attacker repository's committed preset declarations.
  - Claude Code 2.1.296 honours the exact absolute scoped wrapper exclusion while direct Unix socket access and writes to the binding, installed product, canonical config and Git metadata remain denied. Its bundled loader, decision and sandbox export names differ from 2.1.295.
  - Herdr exposes no atomic expected-tab/workspace or empty-shell precondition for these mutations. Final membership and idle rechecks reduce but cannot remove an external move or foreground-process race.
artifacts:
  - "988a7ea: Add scoped chat layout, bounded stop and committed presets"
  - "branch: lane/chat-scoped"
  - discovery/herdr-scoped.mjs
  - discovery/herdr-scoped-probe.mjs
  - discovery/test/herdr-scoped.test.mjs
  - discovery/README.md
  - docs/reports/evidence/R-365/scoped-read-chats.tap
  - docs/reports/evidence/R-365/native-sandbox-regressions.tap
  - docs/reports/evidence/R-365/installer-regressions.tap
  - docs/reports/evidence/R-365/scoped-installer.tap
  - "/Users/rewt/development/rewt/.org/runs/R-365/report.md"
decisions: []
questions: []
challenges: []
---

The narrowed handoff takes precedence over the earlier full-control wording in
this run's item summary. ARCH-30 still owns shell confinement and arbitrary
command/input control; this change does not enable them.

The installed launcher pins its real Herdr executable and binding directory.
The project-chat tab launcher records the exact workspace/tab/chat pane,
canonical project, pinned socket and shell PID plus kernel start identity in
private mode-0600 state under the installed entry bin's `.herdr-scoped/`.
Before the native sandbox starts, the adapter verifies its actual ancestry to
that shell and claims the binding with its own PID/start identity. The wrapper
requires both live identities in its process ancestry and rechecks the binding
for mutations. It ignores caller pane, workspace, binding, socket, binary and
run-temp environment values; its strict argv has no alternate binding option.
The native profile protects the binding directory, launcher/interpreter/product,
canonical config and Git metadata using the same exclusions as read mode.

Scoped reads preserve the read wrapper grammar and can address any workspace.
Mutations resolve the chat and target pane from Herdr immediately before the
mutation, checking both workspace and tab. Stop emits one `ctrl+c`, waits
1000 ms, then checks membership again before close. Presets are read from
canonical committed HEAD through pinned Git with a clean environment; the chat
supplies only a preset name and `new` or an explicit pane ID. An existing
preset destination requires the shell alone in the foreground and a stable
prompt; idle and membership checks repeat before the fixed command is sent.
Arbitrary run, send-text, send-keys, extra cwd/env and undeclared presets refuse.

Herdr has no separate pane-create operation. `pane new` and preset creation use
the chat pane only as a geometric split anchor to produce a sibling while
preserving focus. Explicit own-pane split/rename/resize/focus destinations,
close, stop and preset input are refused. Focus also refuses the chat pane as
the resolved destination neighbor.

Residual race: CLI reads and mutations are separate server requests. An
external actor can move a target or change its foreground process after the
last membership/idle read; focus has an additional neighbor-selection race.
Creation validates the returned new pane, but a postcheck cannot undo a prior
mutation. Presets are trusted operator-declared execution capabilities in
ordinary unconfined terminals, including whatever binaries and dependencies
they load. A fixed declaration does not confine a program or make mutable
project scripts immutable. These limitations are documented in discovery's
README; no assertion of full arbitrary-command confinement is made.

Validation evidence:

- Final scope/read/chat checks: 43 cases, 42 passed, no failures; the separate
  opt-in read-native probe was skipped. The scoped native probe ran and passed.
  Command: `MONITOR_TEST_CLAUDE_SCOPED=/Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe node --test discovery/test/herdr-scoped.test.mjs discovery/test/herdr-read.test.mjs supervisor/test/chats.test.mjs`.
- Targeted native-sandbox regressions plus scope/read/chat checks: 102 cases,
  98 passed, no failures, four unrelated opt-in native probes skipped. The later
  43-case run above covers the final Git environment hardening.
- Targeted installer regressions, including all existing read-wrapper
  install/upgrade/remove write-failure and termination recovery tests: ten
  selected tests passed. Six new scoped-wrapper transaction tests passed for
  the same three operations and two failure modes.
- The installed Claude probe loads its real CLI settings loader, real exclusion
  decision and real sandbox wrapper via Bun preload and exits before CLI main.
  It proves wrapper execution/refusal with a private fake socket, direct socket
  EPERM, binding/product/config/Git write denial and Git commit denial. No model
  call or live pane was involved.
- `git diff --check` passed. Initial socket fixtures were denied by the worker
  sandbox, so the targeted fake-socket runs used approved command escalation.
  No baseline, npm test, promotion/release tier, acceptance harness or host test
  slot was used. No installation, release activation or live pane mutation was
  performed.

After validating and committing this report, the final command is a clean-tree
`lane check` with only the pure scoped grammar and membership/idle recheck tests
plus `git diff --check`. This avoids rerunning fake socket fixtures inside the
lane validator's socket-denying sandbox. Its gate is not claimed in advance.
