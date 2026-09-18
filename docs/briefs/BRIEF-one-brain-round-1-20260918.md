# Brief: round one of "One brain" (ENG-13)

Written 2026-09-18 by the operator's drop-in session. You are an engineer on
Codex. Read this whole file before touching anything.

## What you are doing, in one paragraph

The console the operator uses every day lives on the branch
`lane/brain-console-v1`, which is ahead of `main` and never merged. Bring it
up to date with `main`, prove it still works, and check seven defects that
earlier runs found in it: fix the ones that are still real, and say plainly why
each of the others no longer applies. Leave the lane rebased, clean and green.
You do not merge into `main` yourself; the operator promotes after an
independent review.

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-org` (`main` at `feaa888`).
- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-org/lane-brain-console-v1`
  on branch `lane/brain-console-v1`. Work only there.
- The organization (read-only for you): `ORG_DIR=/Users/rewt/development/rewt/.org`,
  CLI `node /Users/rewt/development/rewt/herdr-org/bin/org.mjs`. `org show ENG-n`
  gives each defect's full text and history. Never run a command that writes to it.
- The console's live config: `~/.config/herdr-org/console.json` (two projects,
  bch-cloak and herdr-org). Do not edit it.
- Do not read or write anything under `/Users/rewt/development/bastian`.

## Steps

1. **Rebase** `lane/brain-console-v1` onto current `main`. A dry merge shows no
   conflicts; if you hit one, resolve it in favour of keeping both sides working
   and say so in the report.
2. **Prove it works.** In the worktree: `npm test`, then
   `npm --prefix console ci` and `npm --prefix console test`. Then render one
   frame per project and confirm each draws without an error:
   `node console/app.mjs --print 140x45 --project bch-cloak` and the same with
   `--project herdr-org`.
3. **Check the seven defects.** For each of ENG-2, ENG-3, ENG-4, ENG-5, ENG-8,
   ENG-9 and ENG-12, read `org show <ID>`, then look at the current code on the
   branch. Decide one of:
   - **still real** — fix it on the branch with a test that fails before and
     passes after; one commit per defect, named for the defect.
   - **no longer applies** — write one sentence saying what changed so it
     cannot happen (name the file or commit).
   - **cannot tell without the operator** — say exactly what you would need.
   Do not close or edit the org items; the report carries your outcomes and a
   later session records them.
4. **Keep the rules the core has always had:** `bin/` and `lib/` gain no
   dependency; nothing but the org CLI writes `events.jsonl`; no push; no writes
   to any live organization while developing (use a temporary copy if a test
   needs an org).
5. **Stop** with the worktree clean (`git status --short` empty) and the report
   written.

## The report

Write it to
`/Users/rewt/development/rewt/.worktrees/herdr-org/lane-brain-console-v1/docs/reports/one-brain-round-1.md`
and commit it on the branch. It must start with a front matter block the org
can parse, in this shape:

```
---
run: R-8
outcome: done            # or blocked
summary: |
  Plain sentences: what you did, what passed, what you fixed, what you left.
headline: One sentence the operator can read in a list.
blockers: []             # or a list of one-line reasons
proposals: []            # leave empty; the defect outcomes go in the body
learnings:
  - One line each, only things a later session would otherwise rediscover.
artifacts:
  - branch lane/brain-console-v1: <commit list>, npm test → N pass, console test → N pass
---
```

Below the front matter, a section **Defects** with one line per defect:
`ENG-n — still real, fixed in <commit> / no longer applies: <why> / needs the operator: <what>`.

Then a section **Commits** listing every commit you made, in order, one line each.

## Acceptance (what the reviewer will check)

- The branch is rebased onto current `main`, with no merge commits, and the
  worktree is clean.
- `npm test` and `npm --prefix console test` pass; both frames render.
- Every one of the seven defects has an outcome in the report, and every
  "still real" has a commit with a test.
- `bin/` and `lib/` gained no dependency; nothing new writes `events.jsonl`.
- The report is at the path above, with parseable front matter.
