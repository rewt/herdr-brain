**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: e9e0d2b7ea657d6912443fb88b256d3f8aa729e6
Topic: board-inventory
Round: 1
Review ID: lr-7451c85a3828a7040dff8d58087b87bd
Base branch: main
Base commit: de11d4b0eec7e7d46acdbf194111eaed2508745b

## Findings
- [Major] board/board.mjs:68 - Missing per-session observations fall back to unqualified lane and report keys in maps merged across repositories. When repository A lacks a branch or report that exists under the same name in repository B, A can display B's dirty state, gate, or report; Fix: namespace observation keys by canonical repository and session, prohibit unqualified fallbacks for inventory rows, and cover two repositories with matching topics but missing evidence in one.
- [Major] board/inventory.mjs:414 - An agent outside Git inherits its workspace repository, while an agent that changes checkout still takes its branch from the workspace mapping. Repository filtering and Git or gate observations can therefore describe a checkout the agent is not using; Fix: derive repository and checked-out branch from the actual cwd, verify any workspace mapping against that checkout and Git common directory, and retain unknown identity or branch when verification fails.
- [Moderate] board/inventory.mjs:330 - A missing recorded workspace disables workspace matching instead of rejecting the registry join. A completed stale record with a reused name and pane can claim an idle agent in a different workspace and hide it; multiple records can also claim the same agent without an ambiguity check; Fix: require a verified workspace and one-to-one registry-to-occupant match, reject replacement or ambiguous identities, and preserve unmatched live agents as unregistered rows through final projection.
- [Moderate] board/inventory.mjs:598 - Every observation creates empty preview runtime maps, so a successful preview followed by a pane-read error loses the previous message instead of retaining it as stale. The next document also erases tripwire state accumulated by the watch; Fix: retain runtime for the watch lifetime, keyed by endpoint and verified occupant, carry it into refreshes, and add integration coverage for a successful read followed by failure and a tripwire followed by refresh.
- [Moderate] lane.mjs:2418 - Watch shutdown closes only subscription clients. The in-flight inventory owns separate snapshot and pane-read clients, receives no cancellation, and can continue probing later endpoints and reading panes after SIGINT or SIGTERM; Fix: propagate cancellation into collection, close all active observation clients on stop, prevent subsequent probes, and cover interruption during a pending multi-endpoint collection.
- [Moderate] lane.mjs:2465 - The new watch assigns the entire matched output line or read text to \`tripwire\`, whereas the existing event reducer exposes the configured matching substring. This changes an existing schema-v1 field and allows unrelated output to replace the selected tripwire; Fix: preserve the configured-substring reduction and occupant binding, with a regression whose matched line contains extra text around the configured pattern.
- [Moderate] lane.mjs:2388 - Plain machine output drops scope, inspected endpoint and repository records, display suffixes, and active-after-done state. With successful endpoints it shows only a generic connection label, so same-named sessions can be indistinguishable and the requested coverage is absent; Fix: add a plain coverage summary and repository or group identifiers with collision suffixes, render the active-after-done marker, and cover same-named repositories and sessions in plain output.

## Re-executed
```json
[]
```

## Non-claims
- The captured gate and delivery measurements are inherited evidence only; this review makes no fresh execution claim.
- This verdict applies only to the fixed reviewed commit and does not establish readiness for another commit or authorize lifecycle actions.

## Unverified
- Runtime reproductions, negative controls, the full suite, and OpenSpec validation were not run because the review budget authorizes zero build, test, prepare, install, check, or mutation commands.
- Live endpoint behavior, minimum-version compatibility, alternate hosts, and interactive rendering were not exercised; the findings follow from source inspection and committed fixture coverage.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
