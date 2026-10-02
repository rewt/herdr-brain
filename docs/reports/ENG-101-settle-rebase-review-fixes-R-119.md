---
run: R-119
outcome: done
summary: |
  Resolved all three independent review findings. Settle refuses affected custom
  merge drivers before automatic preparation, including merge.default, overridden
  built-in names and intermediate attributes. The proved rebase replaces only
  the saved lane ref through a compare-and-swap transaction coordinated with
  HEAD/index locks, preserving concurrent commits and branch switches. Directory
  rename conflicts now include paths from informational conflict records.
  Clean rebases still reach promotable after validation, and conflict or
  preservation refusals retain the reviewed lane. The fixes and this report are
  committed on the lane; the final lane gate follows the report commit.
headline: Settle preserves reviewed work and concurrent commits while reporting directory conflicts
blockers: []
proposals: []
learnings:
  - A successful custom merge driver can discard reviewed edits in both the expected merge and actual replay, so equal trees cannot independently establish preservation.
  - Git allows custom merge driver definitions to override built-in names such as text, and check-attr sentinel spellings can also be literal driver names.
  - Git update-ref from the lane also acquires its HEAD lock for the reflog; running the named-ref transaction from the canonical checkout permits holding the lane HEAD lock throughout replacement.
  - A directory rename split can return a nonzero merge-tree exit with no unmerged-file entries; its directory path appears only in NUL-delimited informational conflict records.
artifacts:
  - "Commit: Guard settle rebase preservation and concurrent lane updates"
  - "Commit: Report settle rebase review fixes for run R-119"
  - "Branch: lane/settle-rebase"
  - "settle/settle.mjs; settle/replace-lane-head.mjs; settle/README.md; settle/test/rebase-review.test.mjs; settle/test/rebase-safety.test.mjs"
  - "Baseline npm test: 693 passed, 11 skipped, zero failures out of 704 tests."
  - "Post-change npm test -- --suite-timeout=540000: 702 passed, 11 skipped, zero failures out of 713 tests; /private/tmp/R-119-post-tests.log."
  - "Additional custom-driver sentinel regressions: 2 passed, zero failures; /private/tmp/R-119-sentinel-drivers.log."
  - "record check /Users/rewt/development/rewt/.org/runs/R-119/report.md"
  - "Final command: ORG_ACTOR=run-R-119 LANE_VALIDATE='npm test -- --suite-timeout=540000' node lanes/lane.mjs check; /private/tmp/R-119-lane-check.log and .lane/gate.json bind validation to the final report commit."
decisions:
  - text: Refuse automatic preparation for affected custom merge drivers in current, base, upstream and replayed trees, including merge.default and overridden built-in names.
    category: design
    why: A content-discarding successful driver invalidates the independent preservation oracle; a handoff retains the reviewed lane for judgment.
  - text: Replace unconditional reset with a named lane-ref compare-and-swap transaction while holding the lane HEAD and index locks, and verify branch identity and clean worktrees under those locks.
    category: design
    why: A concurrent commit cannot be overwritten, a branch switch cannot redirect the update, and the edit-preserving checkout runs only after the saved ref has been reserved.
  - text: Parse informational merge-tree records and collect only conflict paths alongside the unmerged-file paths.
    category: design
    why: Directory conflicts may have no unmerged files; ordinary auto-merge notices must not create false conflict paths.
questions: []
challenges:
  - "The restricted post-change test invocation could not inspect processes for fixture cleanup. The same offline suite was rerun with process inspection enabled and the existing supported 540000 ms suite bound; no test runner or project configuration was changed."
---

Regressions use real Git with explicit fixture actors, bounded tests/subprocesses
and scripted review transport. Successful drivers that discard reviewed content
are witnessed before settle refuses them, covering named/default drivers,
overridden text and sentinel-spelled names, and intermediate attributes. Injected
commits and branch switches during the final record read remain intact. Native
commit/switch attempts during replacement are excluded by Git locks, and a direct
ref change after identity verification is refused by the expected-old-value CAS.
Lost-response recovery still adopts only the exact prepared commit.

The directory-rename regression witnesses a real split-directory conflict with
an empty unmerged-file section and verifies the handoff names its directory while
excluding an ordinary auto-merge notice. Existing regressions retain clean rebase
readiness, binary/mode/rename preservation, independent same-file edits, net-tree
and intermediate replay conflicts, preservation failures, post-rebase red
validation, upstream movement and unrelated-branch isolation.

Unexpected interruption during checkout retains the owned HEAD/index locks for
inspection rather than rolling back over possible concurrent work. No push,
promotion, shared configuration, release, live pane, housekeeping schedule or
contrib watcher changes were made. The previous report remains unchanged.
