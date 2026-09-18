---
run: R-13
outcome: done
summary: |
  Brain results now carry a project derived from the shared console configuration,
  the console shows only the active project's results while counting the rest,
  tidy-tabs recognizes completed lane reviews, and Codex final messages land in
  Finished instead of being mistaken for unsent operator text.
headline: One Brain results are project-aware and finished lane work is visible
blockers: []
proposals: []
learnings:
  - Project attribution can be derived consistently from either a checkout prefix or the two supported worktree layouts.
  - A review verdict is sufficient evidence to retire an idle review tab only when it is newer than the registered lane session.
  - Codex final output needs agent-aware prompt trimming because Claude's unsent-input box heuristic misreads Codex's final-message separators.
artifacts:
  - "c87e68d: show project on every brain result"
  - "45c90e7: filter waiting results by console project"
  - "1e1a48d: close lane review tabs after verdicts"
  - "842a2c2: classify Codex final messages as finished"
  - "npm test: 144 passed, 1 optional-dependency skip"
  - "npm --prefix console test: 93 passed"
  - "node console/app.mjs --print 140x45 --project herdr-org: rendered successfully"
---

# One Brain round 2: visibility

The earlier R-12 report for the One Brain fold was restored under the collision-safe name
`docs/reports/one-brain-round-1b-r2.md`; this R-13 record is retained here because the run's
required report path had replaced it.

## Commits

- `c87e68d` — derives and prints a project for every Brain queue and show result, including older stored results.
- `45c90e7` — filters the console's waiting results to the active project and summarizes results waiting elsewhere.
- `1e1a48d` — treats an idle or done lane review as finished when a newer valid verdict exists.
- `842a2c2` — parses Codex screens with agent-aware rules so final assistant messages are classified as finished.
- This commit — records the R-13 outcome and live tidy-tabs evidence.

## Verification

- `npm test` — 144 passed, 1 skipped because the optional console dependency was unavailable to the root suite.
- `npm --prefix console test` — 93 passed.
- `node console/app.mjs --print 140x45 --project herdr-org` — exited successfully.
- The Brain JSON queue showed `herdr-org` and `bch-cloak` on their matching live rows and `other` for unmatched rows.
- The branch is rebased on `main`, has no merge commits, and `git diff --check main...HEAD` is clean.

## Cutover

None. No configuration, service, queue, organization, or other outside-repository state was changed. Promoting these commits makes the canonical Brain executable enrich both new and previously captured rows with project names.

## tidy-tabs dry run

The live snapshot no longer contained registered engineer agents to retire. It did contain eight completed review agents with verdicts newer than their sessions; the planner selected all eight and one old completed settle session, and selected no working agent.

```text
[dry-run] would close wGJ:t3 "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-9d9b16)
[dry-run] would close wGJ:t6 "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-04ac18)
[dry-run] would close wGJ:t8 "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-ded26a)
[dry-run] would close wGJ:tB "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-da79a2)
[dry-run] would close wGJ:tD "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-64e44c)
[dry-run] would close wGJ:tF "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-16397f)
[dry-run] would close wGJ:tK "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-4c46a1)
[dry-run] would close wGJ:tN "agent:brain-console-v1": worker finished and its review verdict is recorded (lane-brain-console-9621c9-118ed6)
[dry-run] would close wGH:tR "settle R-11": session finished (settle-r-11-1621)
```
