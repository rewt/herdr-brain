**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: c6ac6ff87e692ba104eac76979df0fca60981c32
Topic: steward-unattended
Round: 1
Review ID: lr-a704569a5616c2c91133f7c6abfcde8a
Base branch: main
Base commit: 27bfb12fb2d65a03500e7d251fc73dc91c372fa0

## Findings
- [Minor] supervisor/README.md:17 - The correction makes an unmarked supervisor launch default to \`combined\` when the fleet has no chat receipt for its canonical identity, but the public docs still say a combined supervisor must select \`MONITOR\_SESSION\_KIND=combined\` in its launch environment (supervisor/README.md lines 16 to 18, and discovery/README.md lines 311 to 312 say combined supervisors can select it), and supervisor/README.md line 34 still says bch-cloak's combined conversation needs the explicit kind; an operator reading these would think unmarked supervisors are always ops and that an opt-in is required, which the code no longer does; Fix: rewrite both README passages to state that a supervisor launch without an explicit kind is classified at launch as combined while chats.json has no chat for its canonical Git common-directory identity and as ops once one exists, that explicit ops, chat or combined override it, that unreadable chat state defaults to ops, and that the resolved kind is persisted in the pane receipt for restore; adjust or drop the bch-cloak sentence accordingly

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: supervisor/test/entry.test.mjs
- Test evidence not re-executed: discovery/test/native-sandbox.test.mjs
- Report claim of 25 selected checks: the report cites a temporary TAP file outside the repository that was not available as evidence; the inherited gate log selects a different pattern and shows 113 tests with 17 run and 96 skipped, so the 25-check count is not corroborated, although every new test named for the three findings appears among the 17 run cases.
- ENG-245 composition: Claude passthrough and resume paths call unattendedHookArguments directly while the main path merges by parsing the second element of its returned argument array, so whether a later PermissionRequest hook lands in one settings object on every path depends on ENG-245 adding it inside unattendedHookArguments; not verifiable until that change exists.
- Live behaviour: whether real Claude and Codex builds honour the composed single settings object and the per-launch Codex PreToolUse override was not observed; offline tests prove argument construction only, as the report states.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
