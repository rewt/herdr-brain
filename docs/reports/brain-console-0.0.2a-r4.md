---
run: R-6
outcome: done
summary: |
  Correction round 4 of console 0.0.2a, as .lane/BRIEF-correction-r4.md asked. The review round 4
  record is committed unchanged (f57f2f4). The fixes are in two commits: f9e5a65 (core) and bb385dc
  (console). DOING no longer shows the brief's fixed opening "You are a fresh session.". It takes
  the first sentence after the brief's Work item heading, which is the item title in an org brief.
  A transcript looked up by agent name now reads only files written since the run started, or
  since local midnight when there is no run. The README and the console/lib/cli.mjs header now
  describe the Herdr right-click routing. org today --json lists each agent name's latest
  finished run (read-only), so an idle agent whose run already finished is named
  "lane <topic> r<n>". The settle finding is only partly fixed. The four idle
  lane-brain-console-9621c9-* agents it saw are lane review sessions (role "review" in lane's
  own session files), not org runs. Org does not record their names, so they still show their
  raw agent names. Fixing that needs a source org does not have (proposal below). Tests: npm test
  105/105 (was 100) and npm --prefix console test 66/66 (was 62). Each behaviour change had a test
  that I saw fail first. Nothing was pushed or promoted, and nothing was written to the live org.
headline: The console now says what a session is doing instead of "You are a fresh session."; idle review sessions still show their raw agent names because org does not record them.
blockers: []
proposals:
  - role: engineer
    title: Name lane review sessions in the console from lane's own session records
    why: "The idle lane-<topic>-<hash>-<suffix> agents in the console are lane review sessions (lane writes them to <repo>/.lane/sessions.json.d/*.json with role review, topic and name). No org run carries their names, so SESSION shows the raw name. Reading those files, read-only, would name them 'review <topic>'. The other way is to have lane review record its agent name in org. Choosing between them is a spec decision; ENG-8 covers naming in general and may absorb this."
learnings:
  - "Every brief that org start writes (lib/render.mjs renderBrief) opens with the fixed line 'You are a fresh session. …' and then '## Work item' / '- **<ID>** <title>'. A brief-based description has to skip that opening."
  - "Idle Herdr agents named lane-<topic>-<hash>-<suffix> are not always org runs. lane review sessions use the same naming, and lane records them in <repo main checkout>/.lane/sessions.json.d/<uuid>.json (fields name, topic, role agent|review, brief, pane). Org run meta 'agent' names only the role=agent ones."
  - "org today --json now has agent_runs: the latest finished run of each agent name, newest first, at most 50, with the same fields as running."
  - "console transcriptOf now takes (agent, run). The session reader's transcript() takes sinceMs, which bounds only lookups by name. Lookups by session id are not bounded."
artifacts:
  - "branch lane/brain-console-v1: f57f2f4 (review round 4 record docs/reviews/brain-console-v1/141d4f0-r4.md), f9e5a65 (org today --json agent_runs), bb385dc (DOING, transcript bound, docs, finished-run naming)"
  - "npm test → 105 pass, 0 fail; npm --prefix console test → 66 pass, 0 fail, 0 skipped"
  - "core bin/ and lib/ import only node: and local modules"
---

## Findings

1. **[Moderate] DOING showed the brief's fixed opening.** Fixed in `console/lib/names.mjs`
   (`briefSentence`). DOING now starts after the `Work item` heading when the brief has one. It
   also skips any line that starts with `You are a fresh session`. If nothing usable is left, the
   item title is used. The first test to fail was the new test in
   `console/test/session.test.mjs`, "DOING for a run with no usable title comes from the work in
   the brief org start wrote…". It uses a real `org start` in a temporary org, with Herdr up (an
   untitled Codex agent, plus a run with no agent in Herdr) and with Herdr down. It failed with
   `'You are a fresh session.'` for both rows. The new unit cases in `names.test.mjs` also fail
   against the old `names.mjs` (checked by swapping the file back). I updated the README DOING row.
2. **[Minor] Transcript lookup by name read every old transcript.** Fixed in
   `console/lib/sources.mjs`, where `transcript()` passes `sinceMs` to `find`. In
   `console/lib/session.mjs`, `transcriptOf(agent, run)` sets the bound to the run's start, or to
   local midnight (today's `day.start`) when there is no run. First failing test:
   `sources.test.mjs`, "a transcript looked up by agent name reads only transcripts written since
   the lower bound". It failed with `opened: fresh.jsonl, old.jsonl`. `session.test.mjs`,
   "transcripts are looked up by name from the run's start, else from local midnight", checks
   that the console passes the bound. It fails against the old `session.mjs` (checked by
   swapping the file back). I wrote it after the fix.
3. **[Minor] The right-click routing was not documented.** The README's Keys and mouse section
   now says what the console runs: `herdr pane input --right-click pane $HERDR_PANE_ID` at start,
   and `--right-click herdr` on quit, suspend and crash. It also says that Herdr's pane menu is
   unavailable in that pane while the console runs, and that `m` is the fallback. The closing
   paragraph no longer says that focusing a tab is the console's only action on agents. The
   `console/lib/cli.mjs` header says the same. These are docs only, so there is no test. Before
   writing, I confirmed in `console/app.mjs` that `giveBackTerminal` runs on quit, suspend,
   signals, `exit` and uncaught errors.
4. **[Minor, settle] Rows from earlier rounds could not be told apart.** Partly fixed.
   `org today --json` gained `agent_runs` in `lib/today.mjs`. It is read-only: each agent name's
   latest run that is no longer open. `buildBoard` in `console/lib/model.mjs` matches a Herdr
   agent against those runs too, and an open run with the same name wins. A finished run never
   adds a row by itself. First failing tests: `test/today.test.mjs`, "org today --json names the
   latest run of each agent, finished runs included…" (a TypeError, since `agent_runs` was
   missing), and `console/test/board.test.mjs`, "an idle agent whose org run already finished is
   named after that run…".

   **Why it is only partly fixed.** I checked the live org read-only. The run meta `agent` names
   of R-1 to R-6 are `…-4824f0`, `…-f7c455`, `…-d43333`, `…-4eee8c`, `…-ff430d` and `…-cf4ac2`.
   The idle Herdr agents the settle check saw are `…-9d9b16`, `…-04ac18`, `…-ded26a` and
   `…-da79a2`, and none of them is an org run. lane's session files in the main checkout's
   `.lane/sessions.json.d/` record them as `role: review`, "Independent lane review", created at
   the times of review rounds 1–4. That is also why their DOING reads "Brain console v1
   independent review". Org stores nothing about them. Naming them would need org to store
   reviewer names, or the console to read lane's files, and the brief says to stop in that case.
   The proposal above covers it. None of the finished runs' own agents is still listed in Herdr
   right now, so the new matching changes no live row today.

## Live check (read-only)

I copied the live org to my scratchpad and ran `createSession` against the copy, with the real
`herdr agent list` and tab list (reads only; nothing was focused or messaged). This session
(`…-cf4ac2`) reads `lane brain-console-v1 r6 | Claude Opus 5 · high | working`. The four review
agents still show their raw names, as explained above. Settle sessions with no title show
`no description`, because no org run carries their names either. Naming them belongs to ENG-8.

## Not done

- No live Herdr tab or pty run this round. The changes are to the model, the reader and the
  docs; screen code and terminal modes did not change.
- `docs/spec-brain-console-0.0.2.md` is unchanged. It is on main, and its SESSION and DOING
  sources already allow these rules.
