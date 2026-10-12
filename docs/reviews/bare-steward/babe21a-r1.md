**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: babe21a142ef1a94c0fd0caf06ec4a399c2e8c4a
Topic: bare-steward
Round: 1
Review ID: lr-76157d66ae72f5def491ac6726d48e08
Base branch: main
Base commit: b7af494b162c027c3b557e381412937cfa8019dd

## Findings
- [Moderate] supervisor/chats.mjs:171 - Removing the pre-tab Codex coordinating preflight and Claude fallback leaves the refusal in place one layer down: chats run the adapter with \`--role chat\`, \`coordinatingRole\` treats chat as coordinating, and discovery/native-sandbox.mjs line 177 still calls \`codexCoordinatingPreflight\`, which throws for a legacy \`sandbox\_mode\` selector or a Codex without permission-profile support. A default chat in that environment now creates and retains a tab, records a receipt, the adapter refuses inside the pane, and openProjectChat throws \`chat startup not detected\` after the startup wait, where it previously fell back to Claude before creating any tab. The new test at supervisor/test/chats.test.mjs line 106 and discovery/README.md line 128 claim selectors are the harness's business, but the test only passes because monitor-codex is a fake that ignores its sandbox; Fix: either drop the coordinating Codex selector/profile refusal from nativeSandboxLaunch for the chat role in this lane (so the README and test claims become true for the real adapter), or keep the pre-tab preflight and Claude fallback in openProjectChat until discovery stops enforcing it, and add a test that exercises the real adapter path (or nativeSandboxLaunch with role chat and a legacy selector) rather than the fake adapter.
- [Minor] supervisor/arm-watch.sh:3 - The header comment still says \`SETTLE.md tells that supervisor how to open a fresh settle session\`, but supervisor/SETTLE.md is deleted by this commit; Fix: change the comment to point at supervisor/PROTOCOL.md or the settle module, without touching the script's behaviour, path or flags.
- [Minor] discovery/policy.mjs:45 - The worker entry policy paragraph this lane edits still gives \`npm --prefix mcp ci\` as the dependency-install example although mcp/ was removed in the reviewed delta, so every worker is told about a module that no longer exists; Fix: replace the example with a generic dependency install or drop the parenthetical.

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- No build, test, prepare, install or check command was executed; the run budget was zero and no supplemental budget authorized any.

## Unverified
- No suite or individual test file was run (zero run budget), so the behaviour of the rewritten release, chats, entry, signals and supervisor tests is established by reading only.
- The chat regression in the Moderate finding is derived from reading supervisor/chats.mjs, discovery/adapters/codex.mjs, discovery/control-socket.mjs and discovery/native-sandbox.mjs; it was not reproduced with a live or offline adapter run.
- herdr/release.sh plist refusal ordering was verified by reading only: it runs before entry check, remember and any link switch, and rollback inherits it through activate; no scratch activation was executed.
- The first commit in the delta (console, MCP, kit, workflow engine and plugin removal) was reviewed only for dangling references and test wiring; the supplemental brief scopes this round to the second commit.
- The accepted interim gap (discovery still reads chat.herdr\_mode, so a committed read or scoped mode refuses inside the adapter) was not assessed further, per the brief.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
