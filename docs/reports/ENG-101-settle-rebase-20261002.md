---
run: R-118
outcome: done
summary: |
  Settle now prepares a clean mechanical rebase onto its captured integration
  branch after independent review, verifies that the reviewed diff survives, and
  reruns validation at the rebased head before returning readiness. Net-tree and
  intermediate replay conflicts name their files and leave the reviewed lane
  intact. Preservation failures also leave the lane intact. The implementation,
  regression tests and this report are committed on the lane; the final lane gate
  follows the report commit.
headline: Settle rebases clean lanes and validates the preserved reviewed changes before promotion
blockers: []
proposals: []
learnings:
  - Git merge-tree can establish the expected full tree of the reviewed lane diff integrated with the captured main, including binary content, file modes, renames and upstream edits within the same file.
  - A clean net-tree merge does not prove every intermediate commit will replay cleanly; settle performs the actual replay in an owned detached scratch worktree before moving the reviewed lane.
  - Git rebase hooks inherit Git index variables; cross-worktree test hooks must clear those variables before changing their own fixture's canonical checkout.
artifacts:
  - "Commit: Settle cleanly rebased lanes with reviewed-tree preservation"
  - "Commit: Report settle rebase completion for run R-118"
  - "Branch: lane/settle-rebase"
  - "settle/settle.mjs; settle/README.md; settle/test/rebase.test.mjs; settle/test/rebase-safety.test.mjs"
  - "Focused offline validation: 55 tests passed, none failed; /private/tmp/eng101-settle-tests.log and /private/tmp/eng101-rebase-safety.log."
  - "Post-change npm test -- --suite-timeout=540000: 692 passed, 11 skipped, 1 failed out of 704; the sole failure was the unrelated copied Codex discovery probe subprocess timeout. Its isolated rerun passed both Codex and Claude cases; /private/tmp/eng101-post-tests.log and /private/tmp/eng101-discovery-retest.log."
  - "record check docs/reports/ENG-101-settle-rebase-20261002.md"
  - "Final command: LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check; .lane/gate.json pins the final implementation and report commit."
decisions:
  - text: Prepare the actual rebase in an owned detached temporary worktree and require its tree to match the mechanical merge before replacing the clean lane head with Git reset --keep.
    category: design
    why: Conflicts and lost or altered reviewed changes cannot modify the reviewed lane. The full-tree comparison preserves reviewed content while allowing independent upstream changes.
  - text: Retain the original reviewed commit and capture the original lane head, target, expected and actual trees, replay log and prepared commit in the settle receipt.
    category: design
    why: The review remains bound to its original source; a lost head-update response can adopt only the exact previously proved commit without repeating review or replay.
  - text: Preserve the captured integration commit, merge-commit refusal, branch isolation, clean-worktree checks, record readiness and promotion authority, and validate after rebase before returning readiness.
    category: design
    why: A rebase is a mechanical preparation step; it cannot waive independent review, unresolved findings, concurrent work, validation or supervisor authority to promote.
questions: []
challenges:
  - "The baseline npm test required host process inspection for fixture cleanup and then exceeded the default 360000 ms suite bound without reporting a test failure. The post-change full suite and final lane gate use the existing supported 540000 ms suite bound; no test runner or project configuration was changed. The post-change full suite had one 15-second copied Codex discovery-probe timeout; that probe calls discovery and lane promotion rather than settle. Both copied Codex and Claude probe tests passed on the isolated rerun."
---

Offline tests use real Git, record intake, lane review/check and settle receipts
with scripted model/Herdr transport, explicit fixture actors and bounded tests
and subprocesses. New cases cover clean rebase to promotable, net-tree conflict
paths, intermediate conflict paths despite a clean final merge, a rewrite hook
that removes reviewed content, an already-upstream reviewed patch, red validation
after rebase, binary/mode/rename preservation and disjoint edits in the same file,
branch isolation with Git updateRefs enabled, lost head-update response recovery,
and main moving during replay. Existing settle tests cover capped findings,
record readiness, immutable report receipts, correction recovery and cached gates.

Scratch replays are aborted on conflicts and removed without forcing deletion.
Unexpected dirty scratch data or uncertain preparation is retained for inspection.
Main moving during settlement still refuses stale evidence. Rebase never moves
main or other branch refs, promotes, pushes, starts housekeeping or changes panes.
No shared lane configuration, release, bch-cloak or contrib watcher was changed.
