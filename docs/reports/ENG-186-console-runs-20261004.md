---
run: R-240
outcome: done
summary: |
  The minimal console now replaces Now with an aligned Runs table imported from
  supervisor/status.mjs, showing run, item and short title, stage, short provider
  and model, local start time or older day, and running duration. Open runs come
  first, followed by today's landed runs with dim styling and frozen durations.
  The shared projection also fixes reviewer selection and stale report stages.
headline: The console now shows the supervisor's runs table with accurate stages and clocks
blockers: []
proposals: []
learnings: []
artifacts:
  - "commit 7fd492d: Show shared supervisor runs in the minimal console"
  - "console/modern/minimal-session.mjs"
  - "console/modern/minimal.mjs"
  - "supervisor/status.mjs"
  - "supervisor/test/status.test.mjs"
  - "console/test/minimal.test.mjs"
  - "console/test/fixtures/minimal-100x14.txt"
  - "docs/reports/evidence/ENG-186/focused-tests.tap"
  - "docs/reports/evidence/ENG-186/console-100x30.txt"
  - "docs/reports/evidence/ENG-186/console-60x30.txt"
decisions: []
questions: []
challenges: []
---

The console calls the imported `supervisorStatus` projection with the same native
Herdr agent facts used by the status command. It adds no independent run-stage
derivation, record writes, model calls, or lifecycle authority. Supervisor and
chat sessions remain in the compact Context line; Reports and Train remain.

Reviewer selection also addresses ENG-182: it matches the settlement's configured
`reviewRoute` (including names such as `engineer-xhigh`) and verifies the session
and terminal identities, plus recorded pane and workspace when present. Working
reviewers outrank idle reviewers, with newest matching session as the tie-breaker.
Foreign metadata and reused occupants cannot supply reviewer facts. An unavailable
verified reviewer leaves its provider/model unknown instead of inheriting the
engineer's model.

Completed reports in retained checkouts no longer imply active review. An
in-progress settlement remains review, a ready settlement awaiting promotion is
train, and blocked reports or refused promotion remain blocked. In the live
snapshot, R-99 is blocked with a frozen 39-minute report duration, rather than
review with a 57-hour clock. Today's landed rows follow open work, newest
integration first; older landed rows are omitted.

Validation: `node test/helpers/run.mjs supervisor/test/status.test.mjs
console/test/minimal.test.mjs console/test/feed.test.mjs` passed all 33 offline
tests. Regressions cover opaque routes, working versus idle reviewers, session and
terminal replacement, foreign metadata, stale completed reports, blocked clocks,
today's landed rows, ordering, dim styling, Unicode alignment and bounded frames
at 40, 60, 80, 100 and 140 columns. The actual `--print` path matches the committed
100x14 fixture for the configured profile and both minimal flags, while action
keys perform reads only. `git diff --check` passed before the implementation commit.

Read-only live `--print 100x30` and `--print 60x30` snapshots are included in the
evidence directory. They show this run as engineering, the older blocked run,
and today's landed work in the requested order. Plain snapshots cannot convey
ANSI dim styling; the frame regression verifies the landed spans' dim attribute.

The final lane check is intentionally performed after this report is checked and
committed, as requested; its result belongs to the lane validation receipt.
Promotion and release suites remain deferred to their owning stages.
