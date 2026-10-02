**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: efc0fdb934fe7847e350e5dfe398f367cc68d12c
Topic: settle-rebase
Round: 1
Review ID: lr-ade924d7d32be897acc903f7d345d42f
Base branch: main
Base commit: a49d6be69d6a3da08dfebfe1a9e122cf6ebbeb94

## Findings
- [Major] settle/settle.mjs:200 - The preservation oracle inherits custom Git merge drivers, as does the replay. With a reviewed file configured as \`merge=keep-current\` and \`merge.keep-current.driver=true\`, divergent upstream and reviewed edits both resolve to the upstream version: preflight and replay trees agree even though the reviewed edit disappeared. Validation can then return readiness, violating reviewed-diff preservation; Fix: refuse automatic preparation for affected paths using custom merge drivers, including \`merge.default\`, or establish preservation independently of those drivers, and add a regression where a successful driver discards reviewed content.
- [Major] settle/settle.mjs:246 - The lane head replacement is unconditional after the earlier \`unchanged()\` check and an intervening record subprocess. If another actor commits to the lane in that interval, \`reset --keep\` removes that clean committed work from the branch; the following check sees the prepared head and cannot detect the lost commit. A concurrent branch switch can also redirect the reset to another branch; Fix: bind the update to the saved lane branch and expected \`rebase.from\` with a compare-and-swap operation coordinated with worktree/index locking, and add regressions for a commit and branch switch during the final record read.
- [Moderate] settle/settle.mjs:202 - Only the conflicted-file section of \`merge-tree\` output contributes paths. Git can report directory-rename conflicts with a nonzero exit and an empty conflicted-file section, leaving the paths solely in informational conflict records. Such cases receive a generic preflight-failed handoff with an empty \`conflicts\` array instead of the required conflict paths; Fix: also parse the NUL-delimited informational records, collect paths from conflict records while excluding ordinary informational messages, and cover a directory-rename conflict without unmerged file entries.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Findings are based on source inspection and installed Git documentation; no runtime reproduction is claimed.

## Unverified
- Reviewed-diff preservation with a content-discarding custom merge driver lacks inherited regression evidence; the zero-command budget prohibits a mutation witness.
- Preservation of concurrent commits and branch identity during the final head replacement lacks inherited regression evidence; the zero-command budget prohibits an injected-race witness.
- Conflict-path reporting for directory-rename conflicts without unmerged file entries lacks inherited regression evidence; the zero-command budget prohibits a fixture execution.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
