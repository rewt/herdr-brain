**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: ba24bcd6c5a7537069635b29661b7973b81ef694
Topic: release-module
Round: 1
Review ID: lr-ba001942eb5013b948e6e33d46d3ed5a
Base branch: main
Base commit: ec20c67dcc4e1bb203a0e1cc133933454116d8eb

## Findings
- [Major] .release.json:2 - The repository gate supplies neither \`--npm-cache\` nor \`--bch-cloak\`, and the acceptance harness has no defaults for them. Even with live prerequisites available, console build and existing-project compatibility remain PENDING, the harness exits 1, and the module permanently records a failed gate instead of reaching the operator decision; Fix: wire a project gate wrapper or complete argv that resolves and supplies both required inputs, document their setup, and cover the declared invocation with offline assertions.
- [Moderate] release/release.mjs:150 - The preview unconditionally sets \`RELEASE\_NO\_NPM=1\`. Combined with the declared \`MONITOR\_INSTALL\_BUILD\_ONLY=1\`, this skips both work sections of the installer, so the retained preview only archives sources and invokes acceptance; it does not establish the requested build proof or support the report's claim of a built candidate; Fix: perform real build-only preparation inside the isolated snapshot, using a scoped offline dependency cache if needed, and retain build evidence before the skip-live gate invocation; correct the preview report accordingly.
- [Moderate] bin/org.mjs:524 - The operator reservation guards \`record reopen\` but leaves an indirect reopening path through \`record start\`. After the operator answers a release question, an agent can start a run on that question and the start transaction emits \`item.reopened\` without checking \`operator\_reserved\`, clearing the derived release decision and blocking later candidates; Fix: enforce the reserved-question restriction in the start transaction before any events are written, and cover agent attempts to start an already answered release question.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- No independent build, test, preparation, installation, check, mutation witness, live harness, shipping, activation, or lifecycle action was performed.

## Unverified
- The required repository dry run on an actually built candidate lacks supporting evidence: the retained preview skipped preparation work, and the zero-command budget prohibits producing replacement build and gate evidence.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
