---
run: R-232
outcome: done
summary: |
  Added a read-only minimal profile of the modern console, confined to console/.
  It shows live project sessions across the canonical checkout and lanes with
  name, provider/model, stage, local start time and elapsed time. Flag and config
  selection work; the full console remains available. The minimal development
  loop is running in the operator's console live pane wHJ:p8. All 69 focused
  tests passed; the ten minimal tests passed again after the final detection fix.
headline: The minimal session console is running in the live tab.
blockers: []
proposals: []
learnings:
  - Herdr idle chats remain live; done means unseen idle completion, not process exit. Reported workers disappear once neither working nor blocked, while chats and supervisors remain until absent from a successful inventory.
  - Lane session metadata uses created_at for launch time and roles such as review-codex and engineer-xhigh. Correction origins are available as fromRun in the recorded dispatch journal.
  - Herdr agent list can include launch_pending named shells with no agent or session identity. The minimal profile waits for detection before listing those shells.
artifacts:
  - "Implementation commit: 44d0872"
  - "Branch: lane/console-autonomy"
  - "console/modern/minimal.mjs"
  - "console/modern/minimal-session.mjs"
  - "console/app.mjs"
  - "console/lib/config.mjs"
  - "console/modern/README.md"
  - "console/test/minimal.test.mjs"
  - "console/test/fixtures/minimal-100x14.txt"
  - "node --test console/test/minimal.test.mjs console/test/modern.test.mjs console/test/session.test.mjs console/test/paint.test.mjs — 69 passed"
  - "node --test console/test/minimal.test.mjs — 10 passed after the final launch-pending detection fix"
  - "Live pane wHJ:p8: node console/dev.mjs --project herdr-brain --minimal"
  - "Final validation, after this report is checked and committed: node lanes/lane.mjs check --cmd 'node --test console/test/minimal.test.mjs console/test/modern.test.mjs console/test/session.test.mjs console/test/paint.test.mjs'; .lane/gate.json holds the resulting receipt."
decisions:
  - text: Use a separate read-only session controller for the minimal profile and share the modern terminal painter.
    category: design
    why: The profile has no navigation or action paths, performs only inventory and record reads, never calls a model, and writes terminal rows only when their rendered content changes.
  - text: Order working sessions first, then newest starts; retain idle chats, omit settled workers from the display, and count rows that exceed the pane.
    category: design
    why: Current work leads the screen; completed lane work is hidden while live operator chats stay visible. Canonical Git common-directory identity establishes project ownership.
  - text: Support --minimal, --profile minimal and the top-level profile config preference, with --profile full as an explicit override.
    category: design
    why: The operator can choose the minimal default while keeping both existing full console interfaces available without a config write.
questions: []
challenges: []
---

Read the supplied ask, the R-232 brief, and the complete G-1 decision history.
Implementation changes are exclusively under `console/`; this report is the
requested exception under `docs/reports/`.

The profile has one screen with five columns. Stage is engineering, review, fix,
supervisor or chat, derived from structured roles, run associations, correction
origins and established session names. Titles and task prose do not decide a
stage. Models come from lane/run metadata or Claude's session transcript; absent
models leave only the provider. Session launch time leads transcript and run
start, preserving age when a correction reuses a worker. Missing starts say
unknown. Starts use local HH:MM today and MM/DD HH:MM on earlier days. Durations
show minutes, hours/minutes or days/hours and never go negative.

At 80 columns, name/provider/stage/start/duration widths are 21/21/11/11/8,
separated by two spaces. Extra width goes equally to name and provider. Short
panes show a count of extra rows; below 80 columns the screen asks for more width.
Provider and name cells truncate safely in terminal cells, including Unicode.
Inventory refresh uses the existing refresh_seconds preference. Source failures
retain last known rows with an explicit notice. q quits; other console action
keys and mouse clicks do nothing. Ctrl-C also exits.

The offline tests cover provider/model and launch precedence, all five stages,
duration boundaries, canonical project isolation, working/newest ordering,
finished-session removal, session replacement, unknown launch-pending shells,
terminal-safe bounded frames, quiet painting, source failure/recovery, config
selection/override, and an actual --print subprocess snapshot. The print fixture
logs every child CLI argument and proves action keys invoke only read commands.
The existing modern, classic-session and painter tests also passed. Promotion
and release suites remain deferred to their designated batch/candidate gates.

Replaced the running full development console in wHJ:p8 by quitting its child,
stopping the waiting wrapper, and launching the requested minimal command from
the confirmed shell. Verified both the visible screen and foreground argv through
the [Herdr skill](/Users/rewt/.agents/skills/herdr/SKILL.md). The live screen showed
engineering workers, a Codex review session, the Claude supervisor and operator
chats, with start/duration columns and only q quit in the footer. No project
housekeeping, worker, review, focus or session lifecycle was changed.

To choose this as the default, set `"profile": "minimal"` in the console config.
`--profile full --modern` restores the full modern console; `--profile full`
opens the classic interface. The operator's config was not changed.

Per the ask, the final lane check runs after the report commit; its receipt is
authoritative for that report-inclusive tip. No gate result is claimed in this
pre-check report.
