**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: 47f7cfeeeb79f34c5f1d4952089ca22029fc67c4
Topic: cycle-time
Round: 1
Review ID: lr-2bbcfa067cb800bc39d47ba23f646d0f
Base branch: main
Base commit: 05326989cd5088fc35f29fb1779cc408843907c5

## Findings
- [Major] supervisor/cycle-time.mjs:232 - publishCycleTime writes into ORG/published, but at the base commit that path is owned exclusively by writeProjectSummary in lib/project-summary.mjs (housekeeping ticks), which keeps published as a symlink to .published-summaries/HASH; the live record already has that link, so writeFileAtomic (O\_NOFOLLOW per component) refuses and --publish can never succeed on the record it targets (the new test at supervisor/test/cycle-time.test.mjs:172 codifies exactly this refusal), and on a record with no summary yet --publish creates a plain published directory that makes every later writeProjectSummary throw \`published must be the summary generation link\`, breaking housekeeping summary publishing; Fix: publish through the summary generation mechanism (or a coordinated sibling such as a cycle-time generation that project-summary carries forward on each link switch) under the same publish lock, keep the latest cycle-time pair visible after a summary switch, and replace the symlink-refusal test with one that publishes against a record whose published is the summary generation link and then runs writeProjectSummary successfully
- [Minor] supervisor/cycle-time.mjs:117 - the cycle boundary is the seq of the last promotion.reconciled event for the item before the landed run started, so a previous landing known only from a train receipt, or reconciled after the next run was already dispatched, leaves the earlier landed runs inside the later cycle and double-counts their time in dispatch-to-main; Fix: derive the boundary from the preceding landed run in the landings map (exclude runs started at or before that landed run) rather than from reconcile event ordering, and add a fixture where the second run starts before the first landing reconciles
- [Minor] supervisor/cycle-time.mjs:67 - the autopilot receipt directory hash is re-implemented inline instead of reusing receiptDirectory from supervisor/context.mjs, contrary to the ask to extend rather than duplicate, so a future change to the receipt layout silently drops cohort evidence; Fix: import receiptDirectory from ./context.mjs and join autopilot onto it

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: supervisor/test/cycle-time.test.mjs.
- Test evidence not re-executed: promote/test/metrics.test.mjs.
- Test evidence not re-executed: promote/test/metrics-profile.test.mjs.
- Report record-check validation not independently executed.
- Live oracle figures (14 items, median 167.98 min, p90 362.11 min) were checked only against the retained oracle JSON evidence, not re-run; the zero-command budget forbids executing the report.
- The explanation of the 202 min side-chat median as the rounded upper middle sample is the worker's inference; the side-chat calculation was not recovered and cannot be confirmed.
- Live publishing was never exercised by the worker or this review; the Major finding is from reading lib/project-summary.mjs, lib/files.mjs and the live record layout, not from an execution.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
