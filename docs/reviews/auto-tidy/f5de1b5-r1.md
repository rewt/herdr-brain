**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: f5de1b5e0c9036b10252ef6a7b26ce204c6d90c0
Topic: auto-tidy
Round: 1
Review ID: lr-665ddc76f7c3d50b81a7e9081c29b42c
Base branch: main
Base commit: eb710c0782e2d86e47d6bdc6977387888528d259

## Findings
- [Major] supervisor/tidy-tabs.mjs:279 - Review completion still authorizes live tabs by agent name alone. A completed review-codex session with no worker run leaves its name eligible from the old verdict; a later idle occupant reusing that name is closed even when its pane, cwd, workspace, terminal\_id or agent\_session\_id differs. The final observation repeats this authorization, so the worker replacement guard does not protect reviewers; Fix: bind review verdict evidence to the recorded review occupant and require matching live pane, cwd, workspace and immutable identity before planning and closing, preserve missing or mismatched evidence, and add automatic-pass coverage for replacement reviewers without worker runs.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Full promotion suites and live release acceptance remain deferred to promotion and release.

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
