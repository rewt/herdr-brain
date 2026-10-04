---
run: R-235
outcome: done
summary: |
  Redesigned the read-only minimal console into compact Now, Reports and Train
  sections, with purpose-led work rows, short model names, explicit watch checks,
  recent record headlines and promotion queue/receipt visibility. Fixed all three
  R-232 review Moderates with regressions. The operator's existing development
  pane picks up the changes on save; wide and narrow print snapshots are saved.
  Focused validation passed, including the populated print snapshot. A current
  CI start time is not persisted by the train writer, so the view honestly shows
  unknown for that clock and proposes the small producer-side follow-up.
headline: The console now shows current work, checked report headlines and the merge train.
blockers: []
proposals:
  - role: engineer
    title: Persist in-flight promotion batch CI telemetry
    why: The train writer saves a prepared attempt before CI and the gate clock only after CI finishes. Persist the current check command, started_at and running phase in the batch receipt before validation so the read-only console can display an exact running check clock without relying on a log line. This requires changes outside this run's console-only scope.
learnings:
  - Report outcomes and headlines are available in record status from ingested events. Explicit watch checks come from org-report notices in the supervisor inbox journal; a done outcome alone is not a validation pass.
  - Promotion batches retain attempts, jobs and results in Git-common-directory promote/batches/ID/train.json. While CI runs the current writer still records prepared and supplies the command in train.log; its started_at is saved only in the completed gate.
  - Immutable lane session matches must precede name fallback. A mismatched recorded session ID cannot borrow another occupant's model, role or launch time, and a pane alone cannot bind an occupant to a recorded run.
artifacts:
  - "Implementation commit: e5c6ebd"
  - "Branch: lane/console-feed"
  - "console/modern/feed.mjs"
  - "console/modern/minimal.mjs"
  - "console/modern/minimal-session.mjs"
  - "console/lib/sources.mjs"
  - "console/modern/README.md"
  - "console/test/feed.test.mjs"
  - "console/test/minimal.test.mjs"
  - "console/test/sources.test.mjs"
  - "console/test/fixtures/minimal-100x14.txt — deterministic populated CLI snapshot"
  - "console/test/fixtures/feed-live-116x30.txt — live wide print evidence"
  - "console/test/fixtures/feed-live-60x30.txt — live narrow print evidence"
  - "Focused six-file run: 85 passing tests before the additional train-rendering test and populated snapshot revision; the final minimal file then passed all 15 tests."
  - "Final report-inclusive check: node lanes/lane.mjs check --cmd 'node --test console/test/minimal.test.mjs console/test/feed.test.mjs console/test/sources.test.mjs console/test/modern.test.mjs console/test/session.test.mjs console/test/paint.test.mjs'; .lane/gate.json is the authoritative result."
decisions:
  - text: Use three compact read-only sections with intrinsic work-column widths, a 116-cell maximum reading width and two-line entries below 90 columns.
    category: design
    why: Run and item purpose replaces internal session labels. Wide panes do not stretch gaps, narrow panes retain the content, and each section receives room before history consumes remaining rows.
  - text: Keep the eight newest reports plus unresolved exceptions, newest first, and display explicit watch checks independently of outcomes.
    category: design
    why: The operator sees the record headline, outcome and actual watch validation without model calls. Superseded notices and resolved historical outcomes do not claim current attention; delivery alone does not resolve an exception.
  - text: Derive Train from the canonical repository's queue and batch receipts, with current-command evidence from its existing log.
    category: design
    why: Waiting lanes, current batch members and phase, interruptions and recent promotion/refusal results become visible without running train mutations. Missing CI timing is labelled unknown rather than using queue age as a check clock.
  - text: Select projects by stable ID and canonical repository identity, require name or immutable session identity for run matching, and make lane session IDs authoritative.
    category: design
    why: These address the three review Moderates and prevent duplicate display names or reused pane occupants from inheriting another project's work or an old run's metadata.
questions: []
challenges:
  - The console-only scope cannot add missing in-flight CI started_at to the promotion writer. The current view shows batch creation time and elapsed time, the logged CI command, and unknown for the unpersisted check start. A proposal identifies the producer change needed for the exact clock.
---

Implementation changes are confined to `console/`; this report is the requested
exception under `docs/reports/`. Read the supplied ask, R-235 brief, ENG-178
record decisions, G-1 decisions in the brief, and ENG-175's implementation report.

Now shows active lane workers, fixes and reviewers by purpose. Review rows may
show the latest recorded run in their lane as their subject, but do not inherit
that worker's report/abandonment lifecycle. Supervisors and operator chats occupy
one muted context line. Stage and duration use structured metadata; known models
are shortened to Sol, Astra, Luna, Opus, Sonnet or Haiku while provider remains
visible. Unknown facts remain explicit. Canonical repository scope remains the
basis for live session ownership.

Reports uses the folded record report fields and a pure projection of the
supervisor's transport journal. It deduplicates watch notices, preserves blocked,
invalid, no-report and unavailable exceptions after transport delivery, and
supersedes them with newer notices or ingested reports. Closed or superseded
items do not count as current exceptions. The journal reader ignores only an
unfinished appended tail; malformed completed lines produce a source notice.
Read failures retain last good data; repository changes clear old source data.
The view does not read the unfinished autopilot action schema. The pure feed
projection leaves a direct extension point for ENG-177 and a web renderer.

Train reads the shared Git common directory, not the lane's `.git` pointer. It
shows queued lanes, batch members and phase, available start/age/CI information,
interrupted batches and three recent outcomes. Refusals include their reason and
log path; long paths retain their identifying end in narrow panes. Queue results
and persistent receipts are merged by job ID so rotated queue history is still
available. Foreign queue or receipt identities fail explicitly. Release
candidate gates are omitted to keep this profile compact.

Times use local HH:MM today and MM/DD HH:MM earlier throughout. Outcomes/checks
and promotions receive restrained teal; exceptions and failures receive amber.
The unchanged-frame painter still emits no output for identical frames. The
screen stays within the pane height, reserves room for all three sections and
counts omitted lines. Only q and Ctrl-C quit; all other action keys and mouse
input remain inert.

Regression coverage proves all three identity fixes, reviewer subject isolation,
feed ordering/check provenance/notice supersession, bounded history, exception
resolution, malformed/optional journal handling, train queue/receipt merging,
repository identity refusal, independent source recovery, narrow/wide rendering,
refusal log visibility, explicit unknown clocks, quiet painting and populated
`--print` subprocess output for flag/config profile selection. The mock CLI log
also proves action keys issue only read operations. Existing modern, classic
session and painter coverage passed in the focused run.

Read-only live verification used the
[Herdr skill](/Users/rewt/.agents/skills/herdr/SKILL.md) on the designated wHJ:p8
pane and `console/app.mjs --minimal --project herdr-brain --print` at 116x30 and
60x30. The saved snapshots show current work, the supervisor/chat context,
checked record headlines, empty running/waiting train state and recent promoted
lanes. The live pane rendered the same sections. No session lifecycle or pane
layout changes were made.

Per the ask, the final lane check runs after this report is checked and committed.
Its report-inclusive receipt is authoritative; this pre-check report does not
claim a gate result. Promotion, release and live acceptance suites were not run.
