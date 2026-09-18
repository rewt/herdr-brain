# Brief: round two of "One brain" (ENG-20), visibility

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file, then `README.md`'s "Where things live" section.

## What you are doing, in one paragraph

The operator looks at one queue for every project and cannot tell which
project a row belongs to; the console shows an item code and nothing else.
Finished review tabs pile up because nothing knows they are finished. And
brain misreads a Codex session's final message as text the operator typed
and never sent. Fix those four things. You do not touch `supervisor/` or
`.claude/`; another lane (round-two-rules) is editing those at the same time.

## Where things are

- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-org/lane-round-two-visibility`,
  branch `lane/round-two-visibility`. Work only there.
- brain: `brain/bin/brain.mjs`, `brain/lib/*` (capture, classify, queue, digest). Its queue is
  `~/.local/state/herdr-brain/queue.jsonl`; read it, never write it by hand.
- The console: `console/` (Ink app), its brain rows come through `console/lib/brain.mjs`.
- tidy-tabs: `contrib/tidy-tabs.mjs`, with `test/tidy-tabs.test.mjs`. It has a pure `planTidy`.
- The console config the operator uses: `~/.config/herdr-org/console.json` (read it; do not edit it).
  Its `projects[]` carry `name`, `cwd`, `org`, `ledger_dir`.
- Herdr: `herdr agent list` (JSON) gives every agent's `cwd`, `agent` (claude or codex), `name`,
  `agent_status`. Read-only for you: never send, prompt, close or start anything.
- The organization is read-only for you: `ORG_DIR=/Users/rewt/development/rewt/.org`.
- Do not read or write under `/Users/rewt/development/bastian`, `~/Library`, or edit `~/.config`.

## The four changes

1. **Project on every row.** brain derives a project for each captured result from the
   session's folder: the console config's project whose `cwd` is a prefix of the folder, or
   whose checkout name matches a worktree folder under `.worktrees/<name>/` or
   `~/.herdr/worktrees/<name>/`. If results do not carry the folder yet, capture it from
   `herdr agent list` at capture time. `brain queue` and `brain show` print it on every row.
   Rows with no matching project print `other`.
2. **Console filters the queue to its project.** Waiting on you shows only rows whose project
   is the tab's project, and one line at the bottom of the section: `N waiting in <other
   project>, M in <other project>`. Pressing the existing project switch key shows them.
3. **tidy-tabs knows a review is finished.** A `lane-*` agent that is idle or done, whose lane
   has a review record under `docs/reviews/<topic>/` newer than the agent's tab, counts as
   finished. Run `tidy-tabs --dry-run` against the live listing for the herdr-org checkout:
   it must plan to close the finished review and engineer tabs in the lane workspace and
   nothing that is working. Put that dry-run output in the report.
4. **Codex final messages.** When the captured agent is `codex`, its final assistant message
   must not be classified as stranded operator text. Add a fixture from a real Codex screen
   (there are finished Codex sessions in Herdr right now; `herdr agent read <name>` is read-only)
   and a test that the row lands under finished, not "your answer never landed".

## Rules

`bin/` and `lib/` gain no dependency; nothing but the org CLI writes `events.jsonl`; no
push; no writes to any live organization or to brain's live queue; small commits, one per
change above, each with a test. `npm test` and `npm --prefix console test` pass, and
`node console/app.mjs --print 140x45 --project herdr-org` renders.

## The report

`docs/reports/one-brain-round-2.md` in the worktree, committed on the branch, with the same
front matter as the earlier rounds (`run`, `outcome`, `summary`, `headline`, `blockers`,
`proposals: []`, `learnings`, `artifacts`), then **Commits** (one line each), **Cutover**
(outside-repo edits, expected: none), and the tidy-tabs dry-run output.
