---
run: R-2
outcome: done
summary: |
  Correction round 1: fixed all ten findings from review f141f8e-r1 (2 moderate, 8 minor) in two
  commits on lane/brain-console-v1 (a8ad380 core, e6bb066 console). Approve/decline prompts
  now shorten only the title, so the reason, cursor and Enter/Esc keys always fit. An overrule
  now records the opposite answer, and org answer refuses an overrule that would not change the
  answer. Replies whose first word is yes or no count as that answer. A declined blocker reads
  "declined (answered no)" in briefs and org show. Agent text is stripped of escape and control
  characters. The reason is passed as --note=. Opened text documents go to a private temp file
  that is later removed. Transcripts are read incrementally. The size check uses the real
  terminal height. ~/ note paths are expanded. npm test 58/58 (0 skipped);
  npm --prefix console test 25/25. Each fix was reverted in a scratch copy and failed the suite.
  A real 80x20 pty smoke on a scratch org passed. Ready for review round 2. Nothing was pushed
  and no live organization was written.
headline: The console review fixes are in. Long questions no longer hide your typed reason, and an overrule now flips the answer.
blockers: []
proposals:
  - role: engineer
    title: Strip terminal escape sequences from agent text in the org CLI views
    why: The console now removes escape sequences from agent-written titles and notes, but org show, status, today and briefs still print them raw. The R-2 smoke showed a colored question title in org show. An agent could recolor or hide parts of the operator's terminal or a brief.
learnings:
  - "Node's parseArgs refuses an option value that starts with a dash when passed as a separate argument (`--note -x`); `--note=-x` is accepted. Pass free text to the org CLI in the --opt=value form."
  - "In the console model tests, a prompt check needs `renderFrame(view, cols, rows, { termRows })`. The app draws one row fewer than the terminal, and the size check uses termRows."
  - "The transcript reader now uses fsApi.openSync/readSync/closeSync, not readFileSync. A test fsApi that stubs reads has to stub readSync."
  - "A reply to org answer that starts with the word no (for example \"no preference, either works\") is now a decline. Operators who mean a text answer must not start it with yes or no."
artifacts:
  - "branch lane/brain-console-v1: a8ad380 (core: first-word yes/no, no-op overrule refused, declined blockers in show and brief), e6bb066 (console: prompt fitting, overrule to the opposite answer, sanitize, --note=, private temp file, incremental transcript reads, terminal-row size check, ~/ paths, README)"
  - "npm test → 58 pass, 0 fail, 0 skipped; npm --prefix console test → 25 pass"
  - "new tests: test/approvals.test.mjs (first-word replies, no-op overrule, declined blocker in show and brief); console/test/model.test.mjs (80-column prompt with a 60-character title, overrule answer, sanitizing, 80x20 terminal, ~/ paths, incremental transcript reads); console/test/session.test.mjs (dash-leading reason, overrule from the console, private temp file)"
---

## Findings and what changed

| # | Finding | Fix | Test |
|---|---------|-----|------|
| 1 | Moderate, frame.mjs:208: the prompt was clipped from its end | `promptParts()` (controller) returns head/title/mid/reason/tail. `promptLine()` (frame) keeps head and tail and gives the title at least 10 cells. A long reason shows its end while typing and its start at confirm. | model: "a long title never hides the reason, its cursor or the keys" (80 columns, 60-character title, reason and confirm modes, approve) |
| 2 | Moderate, controller.mjs:87: overrule always recorded no | `overruleAnswer()`: a recorded `no` becomes `yes`; anything else becomes `no`. The prompt reads "Overrule to yes/no". `org answer --overrule` refuses the same answer (case-insensitive) and records nothing. | model (overrule effect), session "overruling from the console records the opposite answer" (auto `no` → `yes`, overruled=true), approvals (refused same-answer overrule) |
| 3 | Minor, render.mjs:269/358: a declined blocker showed as `done` | `blockerStatus()` prints `declined (answered no)` in the brief's Blockers section and in `org show`'s `blocked by:` | approvals: declined test checks `org show` and a started run's brief |
| 4 | Minor, org.mjs:241: `"No."` was stored as a text answer | `parseReply()`: a first word of yes/no, followed by punctuation or the end, is that answer, and the rest goes in front of `--note`. `ask --recommend` refuses extra words. `yesterday…` and `nothing…` stay text. | approvals: table of 7 replies plus two --recommend cases |
| 5 | Minor, text.mjs:36: control sequences reached Ink | `sanitize()` removes CSI/OSC/DCS (7- and 8-bit), lone ESC, C0/C1 controls and bidi overrides. It runs in `clip`, `clipStart` and `wrap` (keeping newlines), and on every frame line as a backstop. | model: "agent text cannot drive the terminal" (all three tabs, header, message) |
| 6 | Minor, cli.mjs:37: a dash-leading reason was rejected | `--note=<reason>` | session: `- not now` recorded end to end; argument-array test |
| 7 | Minor, session.mjs:236: predictable temp file | `mkdtempSync` folder (0700), file written with 0600 and `wx`. The folder is removed after a blocking editor, or at `stop()` for a detached `open`. | session: "a text document opens from a private file that is removed afterwards" |
| 8 | Minor, sources.mjs:85: whole transcripts re-read on every refresh | Per-file offset. Only appended bytes are read, in 1 MiB chunks; a partial last line waits for the next read; a file that shrank is read again from the start. Names and the last note are kept per file. Folders are listed once per `notes()` call. A missing name is not searched again until the candidates' sizes change. | model: "a growing transcript is read only from where the last read stopped" (checks the byte positions read; no whole-file read) |
| 9 | Minor, app.mjs:153: 80×20 showed the resize hint | `renderFrame(..., { termRows })`: the app passes the real height. | model: 80×19 frame with termRows 20 has no hint; the pty smoke at 80×20 showed none |
| 10 | Minor, sources.mjs:172: `~/` paths were not expanded | `firstMarkdownPath(text, home)` expands `~/` | model: parse test |

The README describes the new answer parsing, the overrule rule, the declined-blocker label, sanitizing and the temp file. The in-app help line for `n` now says the overrule flips the answer.

## Evidence

- Suites: root `npm test` gave 58 pass, 0 fail, 0 skipped (console dependencies are installed, so the Ink launch test ran). `npm --prefix console test` gave 25 pass.
- Negative controls: I copied the tree to a scratch directory and reverted one fix at a time. Each revert failed at least one new test.
  - `bin/org.mjs`: first-word and overrule tests failed.
  - `lib/render.mjs`: the declined test failed.
  - `console/lib/cli.mjs`: the session and argument-array tests failed.
  - The temp-file block in `session.mjs`: the temp-file test failed.
  - `console/lib/sources.mjs`: the incremental-read and path tests failed.
  - The termRows check: the size and prompt tests failed.
  - The first incremental-read test passed against the old code (it counted only `readSync`). I tightened it to require read positions and zero whole-file reads, and it then failed as expected.
- Smoke: I used a scratch org under the session scratchpad, with ORG_DIR pointing there and ORG_ACTOR unset. The console ran in a Python pty at 80×20, and its question title contained `ESC[31m`.
  - No resize hint appeared.
  - The prompt showed `Reason: - now`.
  - Enter twice recorded `no` with the note `- now`, and the console printed `Recorded no …`.
  - The raw SGR sequence never reached the terminal output.
  - `q` quit with exit code 0.
  - `org show ENG-1` then printed `blocked by: HUM-1 (declined (answered no))`.

## Limits and notes

- At 80 columns in confirm mode with a long title and a long reason, only about 18 cells of the reason fit. The full reason was already visible while typing, and the title is also shown on the reader title line.
- `org show` still prints the raw escape codes of an agent-written title (see the proposal). The review scoped this finding to the console.
- A detached `open` gets its temp folder removed only when the console quits. It is not removed on a crash (SIGKILL).
- The review's Unverified items (real Herdr focus, real Claude transcripts) are still open. ENG-3 covers the transcript check.
- The untracked `docs/reviews/` folder in the worktree is the review's public copy. I left it uncommitted.
