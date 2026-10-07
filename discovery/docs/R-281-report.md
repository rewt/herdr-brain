---
run: R-281
outcome: done
summary: |
  Monitor launches now give Claude its selected project's worktree root, record and private run temp through native working-directory and sandbox read grants. Codex receives launch-only trust for the canonical repository and current checkout, including when an inherited sandbox selector keeps native policy. Offline generated-settings, adapter and native interpretation checks pass without writing persistent trust/settings; implementation and this report are committed before the final lane check.
headline: Project launches prevent the native worktree access prompts without saving persistent trust.
blockers: []
proposals: []
learnings:
  - Codex 0.160.0 splits dotted CLI override keys literally even inside quoted path keys; use an inline projects TOML table value to trust paths containing dots such as .herdr-monitor.
  - Codex linked-worktree folder trust resolves to the canonical repository; the launch trust override must also apply when an inherited sandbox selector returns early.
  - Claude 2.1.292 checks working-directory membership separately from sandbox allowRead; per-launch add-dir covers file tools while allowRead covers inherited shell read restrictions.
artifacts:
  - 3ddcdb3ff8f50ac46425c5a2761249973b21f10f — implementation, offline regressions and documentation
  - lane/steward-prevent
  - discovery/native-sandbox.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/README.md
  - discovery/docs/worktree-access.md
  - discovery/docs/R-281-report.md
  - node --test discovery/test/entry.test.mjs discovery/test/settings.test.mjs — entry 15 passed; settings initially hit four nested macOS sandbox restrictions, then all 13 passed outside the enclosing sandbox
  - MONITOR_TEST_CODEX_CONFIG=/absolute/native/codex node --test discovery/test/native-sandbox.test.mjs — 28 passed, one existing opt-in sandbox probe skipped before adding the Claude native predicate case
  - MONITOR_TEST_CLAUDE_READ=/absolute/native/claude node --test --test-name-pattern='Claude 2.1.292 native working' discovery/test/native-sandbox.test.mjs — native predicate passed for both roles
decisions:
  - text: Supply native per-launch access and project trust only for the selected project and private run temp; never rewrite operator trust records or settings.
    category: security
    why: The ask explicitly authorizes these scoped launch settings to prevent the captured native access prompts; global allow, fleet-parent trust and whole-temp-root grants would exceed that scope.
  - text: Use Claude additional working directories and matching sandbox read grants, and Codex inline-table CLI trust even under an inherited sandbox policy.
    category: security
    why: Native version inspection and offline native checks prove these are the relevant mechanisms; Claude additional directories also permit edits under its native permission mode, while existing peer and coordination write denies remain.
questions: []
challenges: []
---

Read the task brief, R-281 record context, ENG-241 and ENG-242, fleet mapping and
the exact overnight queue screens. Installed versions are Claude Code 2.1.292
and Codex CLI 0.160.0. Claude's blocked read was an experimenter lane report
under the default fleet worktree root. Codex's folder dialog explicitly named
the canonical repository as the trust target, and its preceding warning showed
the inherited workspace-write policy branch.

Claude receives --add-dir for the selected project's worktree root, record,
private run temp, request queue when present and configured extra directories.
Matching allowRead entries reopen shell reads beneath inherited read masks.
The variadic flags terminate at --settings; existing CLI settings/hooks merge
normally, the private 0600 settings file is cleaned on exit, and the global
outside-read block is not disabled. Other projects and shared fleet/temp parents
receive no generated working-directory grants. Native --add-dir grants project
access, including edits under suitable permission modes; sibling lanes are not
claimed to be read-only. Existing peer/coordination denies remain in place.

Codex receives an inline projects TOML table for only the canonical and working
checkout. A first model-free native config check caught that dotted override keys
containing quoted paths do not work in 0.160.0. The final inline-table native
check proves exact paths with dots and quotes load as trusted, the worktree's
project configuration loads, a peer's untrusted setting survives, and persistent
user config bytes stay unchanged. The test uses a scratch home without
credentials and sends only initialize/config-read messages, never a model call.
The launcher retains inherited sandbox/profile/approval choices and the existing
warning, adding trust even on that early-return branch.

The opt-in Claude proof imports the installed binary's own working-directory
predicate via Bun preload and exits before CLI entry. Without generated roots,
the candidate reads fail the predicate; with them, project worktrees, record and
private temp pass for both roles while all four peer roots remain outside.
Default offline regressions capture arguments/settings for both roles and both
harnesses, real default-fleet scratch Git worktrees, assigned/headless/resume
launches, generated/legacy/overridden Codex sandbox branches, persistent-file
preservation and cleanup. Entry tests passed 15/15. Settings tests initially hit
the enclosing sandbox's sandbox-exec restriction; their outside-sandbox rerun
passed 13/13. git diff --check passed.

Proof limits and reproducible commands are in discovery/docs/worktree-access.md.
No persistent machine trust/settings, installation, live panes, model session,
promotion or release acceptance harness was changed or run. Native managed
policy and explicit denies still apply; unsupported harnesses retain the prior
visible warning. Existing host runtime read access is not a new cross-project
read-isolation guarantee.

After record check and committing this report, the final command is:

    node lanes/lane.mjs check --cmd 'npm run test:fast && MONITOR_TEST_CODEX_CONFIG=/Users/rewt/.codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex MONITOR_TEST_CLAUDE_READ=/Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe node --test discovery/test/native-sandbox.test.mjs'

This binds the normal fast tier and focused generated/native regressions to the
final clean commit. The final result is retained in .lane/gate.json, leaving the
checked report unchanged after the last command.
