**PASS**
Schema: lane-review/v1
Reviewed commit: ae63a6a56950a7964c945bea0e64d2957f4f572b
Topic: one-watcher
Round: 2
Review ID: lr-a2c7c6801da7af5774d9d1660d567cf5
Base branch: main
Base commit: 8ed806ab8b03710e22112b8a64a76c2758053c63

## Findings
- [Minor] watch/watch.mjs:384 - The idle-grace branch is not gated on observedWorking, although watch/README.md and the r3 report say it applies only after a previously working agent stops, and during the grace it waits only for working so a transition to blocked is not noticed until the grace ends (up to 900 seconds for bch-cloak); Fix: add observedWorking to the condition (or correct both documents) and include blocked in the wait set used during the grace, with a fixture test for idle then blocked inside the grace.
- [Minor] docs/reports/ENG-64-one-watcher-20261001.md:95 - The bch-cloak plan says continue.sh only needs its arguments verified, but repointing launch-supervisor.mjs to open-session.mjs changes its behaviour from waiting for a working settle or exec session to refusing immediately, and the plan's SETTLE.md edit does not carry the retry rule; Fix: name the wait-to-refusal change for continue.sh in the parity table, add the retry rule to the planned bch-cloak SETTLE.md edit, and add a check that a refused continue.sh is retried.
- [Minor] supervisor/KICKOFF.md:40 - The refusal-and-retry rule for settle.sh is addressed to the long-running supervisor but lives only in SETTLE.md, which is the fresh session checklist and is not in the supervisor's KICKOFF reading list; the supervisor learns of it only from the refusal message; Fix: add one sentence to KICKOFF.md saying that a refused settle.sh keeps the report notice and is retried after the named session stops, or point it at the SETTLE.md paragraph.

## Re-executed
```json
[]
```

## Non-claims
- No claim is made that npm test passes at the reviewed commit; the recorded gate result is inherited evidence only.
- No claim is made about the live bch-cloak files, the activated release, the Brain service or its plist; only the in-repository kit copy was read.
- No claim is made that the bch-cloak cutover plan works end to end; it was checked for internal consistency against the kit only.

## Unverified
- npm test not re-run: the supplemental brief contains no Review run budget, so the build and test budget is zero.
- Dry runs of supervisor/arm-watch.sh, supervisor/settle.sh and supervisor/continue.sh were not executed under the zero budget; wiring was checked by reading only.
- The new idle-grace and spawn workspace-resolution tests were read but not executed; their timing sensitivity was judged by reading only.
- Whether the live bch-cloak copies still match the kit was not checked; the plan's own step 3 requires that comparison.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
