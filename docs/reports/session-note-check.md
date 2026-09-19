---
run: R-18
outcome: done
summary: |
  Checked the console's project-directory slug and agent-name parser against the first five
  lines of one real Claude transcript. Both rules agree with the observed layout, so no
  production code changed; a synthetic regression fixture now pins the observed folder and
  entry shapes. The console suite passes 96/96 and the root suite passes 151/152 with its one
  expected skip.
headline: The real Claude transcript confirms the console's session-note lookup rules.
blockers: []
proposals: []
learnings:
  - The former herdr-org checkout has a Claude project folder whose name exactly matches the console's slash-replacement slug.
  - "A real agent-name entry has the fields type, agentName, and sessionId."
artifacts:
  - "branch lane/session-note-check: c832a6e (plus the report commit)"
  - console/test/sources.test.mjs
  - docs/reports/session-note-check.md
  - "npm --prefix console test: 96 passed"
  - "npm test: 151 passed, 1 skipped"
---

# Session-note lookup check

## What was read

I listed folder and file names under both configured `projects/` directories. No folder for
`/Users/rewt/development/rewt/herdr-brain` exists yet in either directory. The former checkout's
folder exists under `.claude-personal` as
`-Users-rewt-development-rewt-herdr-org`; `.claude` has neither checkout folder.

I read exactly five lines from this one transcript, and did not open any other transcript or
read beyond those lines:

`/Users/rewt/.claude-personal/projects/-Users-rewt-development-rewt-herdr-org/e3c63dc0-55a7-40ae-9437-5af71438135f.jsonl`

The five entry `type` values, in order, were `custom-title`, `agent-name`, `mode`,
`permission-mode`, and `attachment`. An `agent-name` entry therefore did appear in the first
five lines. The first entry's field names were `type`, `customTitle`, and `sessionId`; the
`agent-name` entry's field names were `type`, `agentName`, and `sessionId`.

## Findings

The slug rule is right: for the checkout named by the transcript, replacing path punctuation with hyphens produces the exact observed project-folder name.

The entry shape is right: the observed `agent-name` entry uses `type: agent-name` and the string field `agentName`, with an additional `sessionId` field that does not affect lookup.

`console/test/sources.test.mjs` now has one synthetic five-entry transcript matching the
observed field and type shapes, plus a checkout-to-folder assertion. Production code did not
need a correction.

## Verification

- Before the change, `npm --prefix console test` passed 95/95 and `npm test` passed 150/151
  with one expected skip.
- After the change, `npm --prefix console test` passed 96/96 and `npm test` passed 151/152
  with one expected skip.
- `git diff --check` passed.

## Commits

- `c832a6e test(console): pin Claude transcript lookup shape`
- Report: this commit.

## Cutover
