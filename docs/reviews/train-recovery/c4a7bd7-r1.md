**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: c4a7bd7a99e0c69852de9a31571c52b15e5235b7
Topic: train-recovery
Round: 1
Review ID: lr-90467a41852260cc10d20d18b11f5ed0
Base branch: main
Base commit: eb710c0782e2d86e47d6bdc6977387888528d259

## Findings
- [Moderate] settle/settle.mjs:197 - Intake-stage item closures still become permanent refusals. If the supervisor closes an item before handling its done report, conditional reopen produces a completed \`Conditional reopen refused\` escalation; a dropped item produces \`The item was dropped\`. Neither reason matches this recovery classifier, and the record stage is also excluded from continuation. Explicitly reopening the item then leaves both \`--retry\` and a fresh handle returning the saved refusal without checking readiness, so the claimed recovery from temporary item closure is incomplete; Fix: narrowly recognize closure-only intake refusals, retain or reconstruct their record-stage continuation for new and legacy receipts, recheck identity, report, supersession and current readiness, and add regressions that close or drop an item before intake, explicitly reopen it, and prove exactly one review across retries.

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- The inherited validation logs and committed TAP artifacts were inspected as historical evidence only. Promotion-tier CI remains deferred to the promotion batch.

## Unverified
- Recovery after explicitly reopening an item whose report intake was refused solely because it was closed or dropped lacks implementation and regression evidence; the remaining terminal-receipt defect is identified in Findings.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
