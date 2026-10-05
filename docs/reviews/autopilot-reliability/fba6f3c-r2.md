**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: fba6f3c34258bb31ba68ae855b651fa363bb3f80
Topic: autopilot-reliability
Round: 2
Review ID: lr-5464101ca97a9c5a8e653e62c7d64a2e
Base branch: main
Base commit: 32e2d78a7436fa6d8811ed403243fd2796ea9b6d

## Findings
- [Moderate] supervisor/autopilot.mjs:195 - After a delayed report creates an awaited landing notification, another report notice for that run with a different entry.id reuses the saved wake disposition and delivery\_summary without consulting the landing marker. The inbox deduplicates by delivery ID, so both notices can send the landing line, contrary to the promised single notification; Fix: bind landing delivery to the marker's original notice\_id, handle other report delivery IDs silently without changing the owner's receipt, and add a two-ID delayed-report regression that also preserves retries of the owning ID
- [Moderate] supervisor/autopilot.mjs:136 - Interruption after saving delivery\_summary but before writing the landing marker leaves a recoverable landing message without run-level deduplication. Receipt recovery returns that message through the interrupted-sequence branch without restoring the marker, allowing a subsequent notice of the other type to send the landing line again; Fix: reconcile the landing marker from the bound acknowledged result under its lock before replaying a saved landing summary without rerunning closure, and add an interruption regression at this write boundary followed by the other notice type

## Re-executed
```json
[]
```

## Non-claims
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.
- Promotion-tier validation is deferred to the promotion batch and is not an unresolved review requirement.

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
