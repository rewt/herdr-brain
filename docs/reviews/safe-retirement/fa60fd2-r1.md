**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: fa60fd2448ba63b8bb529b6f2b94521d0ad63386
Topic: safe-retirement
Round: 1
Review ID: lr-724b9ca72479972ded508ada010d43bc
Base branch: main
Base commit: 91ca2b83985257380097bcfab0d1055fff03f9d0

## Findings
- [Moderate] lib/retire-trigger.mjs:13 - The ingestion, review/disposition, verify-completion and reconciliation triggers only write a coalesced retirement/request.json hint, and no code anywhere reads that file; with housekeeping deliberately not started, a report ingestion or job completion never causes a re-observation or guarded retirement, so the acceptance requirement for cheap idempotent triggers is not met in behaviour (each trigger also re-reads the whole event log just to write an unread revision); Fix: add a foreground consumer that compares the hint revision with the last handled revision and runs the shared plan/apply once (for example in supervisor entry and the promote drain), or replace the hint with a direct guarded plan/apply call, and add a test proving a trigger leads to a fresh plan
- [Moderate] supervisor/retire.mjs:138 - When the adapter reads the record through the record CLI (the housekeeping default and tidy-tabs with --org-cli), events stays empty, so handoffs is always an empty array and successorWorkspaces is empty; the confirmed-handoff release path and successor reservation are unreachable from housekeeping fast and strict paths, so the one shared planner gives different decisions per caller and superseded older-round panes are never releasable there; Fix: always load the retirement.handoff events (for example via loadEvents on the discovered org, or by exposing handoffs in the record JSON output) independent of the record reader, and add a housekeeping-path test for a confirmed handoff release
- [Moderate] contrib/settle-watch.mjs:179 - On this ENG-64 stable surface, --close-tab-on-exit (always appended by --spawn) no longer closes the watcher tab: retireTabs runs project-wide planning, the live watcher process keeps its own tab, and after exit the tab is an unrecorded shell that the planner keeps forever; together with the removed exited-watcher and finished-session pruning in tidy-tabs, every spawned watch tab and settle/executive session tab now accumulates indefinitely while the flag still advertises self-closing; Fix: give the watcher a narrow guarded self-retirement (its own HERDR\_TAB\_ID, pane and pid as the only occupant, after the run report is ingested) or let the planner release a shell-only tab whose recorded watcher process has exited for a completed settle callback, and cover the --spawn exit path with a fixture
- [Minor] lib/retire.mjs:180 - The per-tab token hashes complete process\_tree rows including the volatile kernel state letters, so an idle agent sampled as running between plan and execute yields skip-close with authority changed, causing spurious refusals unrelated to authority; Fix: bind process identity fields only (pid, birth identity, command, parent) in the token and keep state checks in the fresh decision rather than the token
- [Minor] promote/promote.mjs:284 - retryCleanup re-runs full record, Git, Herdr and native process observation for every promoted result with cleanup pending at the start of every drain, with no bound or revision check; lanes whose panes stay kept (unrecorded reviewer or watcher shells) are retried forever and make each drain slower; Fix: retry only when the record or request revision changed since the last attempt, or cap and back off retries per result, recording the last refusal reason
- [Minor] lanes/lane.mjs:2497 - lane close now refuses whenever the Herdr CLI cannot list workspaces (including hosts without Herdr), yet the retained comment still says herdr unavailable falls back to git, and the lanes documentation does not mention the new refusal; Fix: update the comment and lanes README to state that lane close requires a readable Herdr inventory, or explicitly distinguish an absent Herdr installation from an unreadable server

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: test/retire.test.mjs
- Test evidence not re-executed: test/retire-paths.test.mjs
- Test evidence not re-executed: test/tidy-tabs.test.mjs
- Test evidence not re-executed: promote/test/promote.test.mjs
- Test evidence not re-executed: lanes/test/lane.test.mjs
- Test evidence not re-executed: housekeeping/test/auto-tidy.test.mjs
- Test evidence not re-executed: housekeeping/test/housekeeping.test.mjs
- Report record-check validation not independently executed.
- Lab-job-owned workspace exclusion: the live adapter never populates lab\_owned, persistent, operator or labWorkspaces; exclusion is only proven in pure fixtures and otherwise relies on non-lane branch and unlinked-worktree checks, which this review could not confirm cover lab job workspaces.
- Practical releasability: the read-only adoption plan released 0 of 48 tabs (14 kept for background or unknown pane processes, 25 as unknown shells); no live evidence shows that any real idle native agent pane, which normally has child helper processes, can satisfy the zero-descendant process rule.
- The committed lane TAP evidence for the final tree covers 12 of 150 lane tests; modified lane tests outside that selection (for example the stale Herdr metadata close refusal) appear only in an earlier whole-file run with 11 failures recorded before fixes.
- Chain scope: chainFor pulls in blocker links and all their descendants, so a closed item linked to an open long-lived prerequisite may keep its panes indefinitely; the intended chain boundary versus the review, correction and integration chain was not confirmed against the ARCH-23 decision note.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
