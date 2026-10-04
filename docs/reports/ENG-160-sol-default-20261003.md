---
run: R-214
outcome: done
summary: |
  Changed the portable unblock and review-codex routes to gpt-6.1-sol while retaining xhigh effort.
  Updated the discovery adoption text and marked Astra as an explicit project configuration choice in the model reference.
  The new regression assertion failed before the change and passed afterward; both focused test files passed.
headline: Planning and Codex review now default to Sol 6.1 at xhigh
blockers: []
proposals: []
learnings: []
artifacts:
  - "Commit: 9cbac13830242bd5a7cfcd65c3bc9bda7360d781"
  - "lanes/preset.mjs"
  - "lanes/test/routes.test.mjs"
  - "discovery/runtime.mjs"
  - "lanes/docs/REFERENCE.md"
  - "node --test lanes/test/routes.test.mjs: 8 passed after the change"
  - "node --test discovery/test/entry.test.mjs: 6 passed"
decisions: []
questions: []
challenges: []
---

Added one assertion that resolves both preset routes and checks their model and effort.
Before changing the preset, the routes test file failed only that assertion: both models
were gpt-6-astra and both efforts were already xhigh. After the four production/documentation
line edits, all eight routes tests passed. The discovery entry test file exercises the
pending adoption question and applying its approved preset; all six tests passed.

No changes to kit, historical specifications, reports, or reviews. No broad suites or
live harnesses ran. After this report is checked and committed, the final lane check
uses `--cmd 'node --test lanes/test/routes.test.mjs discovery/test/entry.test.mjs'`
to keep validation limited to the two authorized test files.
