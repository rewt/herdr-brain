**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: fdba420c1c6f5208f1242104c77a9f83a44e7882
Topic: lessons-entry
Round: 1
Review ID: lr-e9d9f7d75612c84242a38715eb773598
Base branch: main
Base commit: cc0398930a8ed9d818e29a7dc9161e5f0d203be5

## Findings
- [Major] acceptance/lessons.mjs:75 - The UI witness accepts a retained branding line without inspecting the done result. A native CLI that prints its banner and exits with code 1 after its entry receipt is written can still make lessons-entry return success, so the release gate can accept a failed fresh-session launch; Fix: Require native interactive readiness while the session is still running, reject premature exits using the completion receipt, and add offline banner-then-exit negative cases for both transports.
- [Moderate] discovery/lessons.mjs:8 - Entering a valid Git directory named \[slug\] throws because lessonsJson validates the actual directory through normalizeLessonPath, which rejects brackets before checking whether any lessons exist. Both installed adapters then terminate before launching their native session, even in projects with no lessons; Fix: Match literal filesystem entry paths against supported lesson prefixes without rejecting valid directory names, retain matching ancestor and broad lessons, and add installed-adapter regressions for bracket-bearing directories with empty and populated records.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion-tier CI and live release acceptance remain assigned to the canonical supervisor; this review makes no claim of executing either.
- The worker's additional installation and validation counts are report evidence only; the supplied execution log covers the focused entry, acceptance and MCP command.

## Unverified
None

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
