# Brief: check the session-note lookup against one real transcript (ENG-3)

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file before touching anything.

## What you are doing, in one paragraph

The console names Herdr sessions and shows their last note by reading Claude
transcripts. Two rules in that code were taken from a spec and verified only
against fixtures: the shape of the `agent-name` entry, and how a checkout path
becomes the project folder name under a Claude config directory. Check both
against one real transcript, fix them if they are wrong, and prove it with a
fixture test. This is a verification, not a feature.

## The permission you have, exactly

The operator granted on 2026-09-18: you may open the first lines of **one** real
Claude transcript under `~/.claude` or `~/.claude-personal`, read-only, to verify
the session-note lookup. Nothing else in any transcript is to be read or quoted.
Concretely: listing folder and file names under `<config dir>/projects/` is fine;
`head -n 5` of one `.jsonl` file is the whole read; you quote field names and
entry `type` values in your report, never message text, never paths from inside
the file beyond the one checkout it names.

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-brain` (`main` at `5986745`).
- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-session-note-check`
  on branch `lane/session-note-check`. Work only there.
- The code: `console/lib/sources.mjs` (`agentNames`, `projectSlugs`, `candidates`, `transcript`),
  its test `console/test/sources.test.mjs`, and the console config reader
  `console/lib/config.mjs` (`claude_config_dirs`).
- Config dirs to look in: `/Users/rewt/.claude-personal` and `/Users/rewt/.claude`.
  The checkout to check the slug for is `/Users/rewt/development/rewt/herdr-brain`; until
  this evening it was `.../herdr-org`, so both folder names may exist.
- The organization (read-only for you): `ORG_DIR=/Users/rewt/development/rewt/.org`,
  CLI `node bin/org.mjs`. Never run a command that writes to it.
- Do not read or write anything under `/Users/rewt/development/bastian`, `~/Library`, or `~/.config`.

## Steps

1. Read `projectSlugs` and `agentNames`. Write down what folder name the code expects
   for the checkout above and what entry shape it expects for a name.
2. `ls` the `projects/` folder of each config dir. Say whether a folder for the checkout
   exists, what it is called, and whether the code's slug rule produces exactly that name.
3. Pick the newest `.jsonl` in that folder (by mtime). Run `head -n 5` on it, once.
   From those lines note: the `type` values present, whether an `agent-name` entry
   appears in the first lines at all (it may not; say so), and the field names of the
   first entry. Do not open a second file and do not read further into this one.
4. If the slug rule or the entry shape disagrees with what you saw, fix the code and
   add or adjust a fixture in `console/test/sources.test.mjs` using synthetic values in
   the real shape. If both agree, add one fixture that pins the real shape you saw
   (field names, synthetic values) so the next change cannot silently break it.
5. `npm --prefix console test` and `npm test` pass. `bin/` and `lib/` gain no dependency;
   no push; no writes to any live organization.
6. **Stop** with the worktree clean and the report written.

## The report

Write it to `docs/reports/session-note-check.md` in the worktree and commit it on the
branch. Front matter as earlier rounds (`run`, `outcome`, `summary`, `headline`,
`blockers`, `proposals: []`, `learnings`, `artifacts`). Then:

- **What was read**: the one file's path and the count of lines read (five).
- **Findings**: slug rule right or wrong, entry shape right or wrong, each in one sentence.
- **Commits**: every commit, in order, one line each.
- **Cutover**: expected empty.

## Acceptance (what the reviewer will check)

- Exactly one transcript was opened and only its first five lines; the report quotes
  field names and type values only.
- The slug rule and the `agent-name` shape are each confirmed or corrected, with a
  fixture test that pins the real shape.
- Both suites pass; nothing outside `console/` changed except the report.
