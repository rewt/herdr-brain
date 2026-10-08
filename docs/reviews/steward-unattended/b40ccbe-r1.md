**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: b40ccbeeb7d92edeede7c9bd6997536a9c6d6ddf
Topic: steward-unattended
Round: 1
Review ID: lr-12a1e9bf874403aafc66275f75bb68f1
Base branch: main
Base commit: 27bfb12fb2d65a03500e7d251fc73dc91c372fa0

## Findings
- [Moderate] supervisor/unattended.mjs:18 - Every supervisor launch without an explicit MONITOR\_SESSION\_KIND is classified as ops, and no launch path in the repository ever sets \`combined\`, so a combined chat plus ops supervisor in a project that has no ENG-248 chat has its question dialog denied even while the operator is present; the operator decision says such supervisors ask normally until the project has a chat, which implies the chat-less state is detected rather than requiring a manual environment opt-in that nothing supplies; Fix: when a supervisor launch carries no explicit kind, treat it as combined if the fleet chat state has no project chat receipt for its canonical identity (and ops once one exists), keep an explicit \`ops\` kind as an override, persist the result in the pane receipt, and add offline tests for the with-chat and without-chat cases
- [Minor] supervisor/session-hooks.mjs:42 - When the adapter SessionStart hook is needed, Claude now receives two separate inline \`--settings\` values; the supported native sandbox path merges them, but the unsupported-build fallback in nativeSandboxLaunch returns the arguments unchanged, and a single-valued \`--settings\` option would keep only the last one, silently dropping the supervisor SessionStart entry that worked before this change; Fix: build one \`--settings\` JSON whose hooks object contains both SessionStart and the PreToolUse question guard, and assert a single \`--settings\` occurrence in the entry test
- [Minor] discovery/adapters/claude.mjs:38 - Passthrough launches now route through sessionHookArguments with the inherited MONITOR\_SESSION\_ROLE, so an interactive resume in a pane that kept \`supervisor\` in its environment also gains the adapter SessionStart hook (always for Codex at discovery/adapters/codex.mjs:47, since the project tracks no Codex hooks file), which is an unreported and untested change to resume entry beyond the requested registration-only edit and contradicts the supervisor README statement that a direct native restore requires manual entry; Fix: call unattendedHookArguments directly in both passthrough paths, or keep the new resume entry deliberately and document it in supervisor/README.md with an offline test for Claude and Codex resume

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: supervisor/test/unattended.test.mjs
- Test evidence not re-executed: supervisor/test/entry.test.mjs
- Test evidence not re-executed: discovery/test/native-sandbox.test.mjs
- Codex coverage: whether a live Codex request\_user\_input call reaches the per-launch PreToolUse hook and honours the Claude-shaped deny payload was not verified; the report states the same limit and defers it to release acceptance.
- Codex hook layering: whether the per-launch hooks.PreToolUse config override replaces operator or project PreToolUse hooks, and whether the parallel ENG-245 permission hook on the same launch path would overwrite or be overwritten by this guard, was not verified from the diff and needs a composition check when ENG-245 lands.
- macOS presence parsing was reviewed only against the fixture format in the tests; parsing of real ioreg console-user output on current macOS was not observed, so a false away classification for chats on a present operator cannot be excluded.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
