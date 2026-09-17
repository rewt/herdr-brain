---
run: R-5
outcome: done
summary: |
  Build round 0.0.2a (the screen) of Herdr Brain console 0.0.2, as .lane/BRIEF-console-0.0.2a.md
  asked. The review round 3 record is committed as-is (e3e556d), and the lane is rebased onto main
  without conflicts. The work is in five commits. Core (eb88362): org today --json gives each open
  run its harness, model, effort, workspace and round. Console: 5440484 (the screen), d2bdbcb
  (README), 161ea9d (Herdr right-click routing) and e288535 (codes from other organizations, menu
  placement). The console now has a black background on every row, powerline header and footer
  segments, and rounded group caps. It lists Waiting on you, then every Herdr agent grouped by
  repository (worktrees under their main repository) with SESSION, WHO, WHERE, UP, STATE and DOING.
  Enter and a left click on a session go straight to its Herdr tab; on a question they open the
  summary. The screen also has the s summary popup, the right-click menu and its keyboard twin m,
  wheel scrolling, the h history, the / scope popup, the rail at 180+ columns, and the 100 and
  80 column layouts. glyphs is nerd or plain; NO_COLOR implies plain. The version is 0.0.2. The
  old reader and the Decided and Finished lists are gone. The launch bar is drawn resting only;
  n and Tab say "task launching comes in the next round". Tests: npm test 100/100 and
  npm --prefix console test 62/62, including a fake herdr on PATH for go-to-session. A pty run
  of the real app confirmed mouse reporting on at start and off at quit, suspend and SIGTERM, and
  a right-click report opening the menu. In one Herdr test tab of my own, against a copy of the
  org, the console drew the live sessions, and s, h, m and an injected right-click report worked.
  I closed that tab afterwards. I never focused another agent. I could not click with a real
  mouse (see Mouse). Nothing was pushed or promoted, and nothing was written to the live org.
headline: The operator can now open the 0.0.2 console in a Herdr tab and drive it (sessions by repository, Enter or click to go to a session, summary, menu, history and answers); launching tasks comes in round 0.0.2b.
blockers: []
proposals:
  - role: engineer
    title: "Build console 0.0.2b: the launch bar, pickers, review and contrib/launch-task.mjs"
    why: "The spec's second round. 0.0.2a draws the bar resting only, so the operator cannot start work from the console yet (acceptance 5 and the routes part of 7 are still open)."
  - role: reviewer
    title: Independent review of console 0.0.2a (lane/brain-console-v1 at e288535 and the report commit)
    why: The spec gives each round its own review before the next round builds on it.
  - role: engineer
    title: Name Herdr sessions better when neither org nor Herdr gives a short name
    why: "Lane agents from other organizations show as their truncated Herdr names (lane-seal-selector-mal-02…) and unnamed agents as tab labels (tab 1). The worktree folder (lane-<topic>) or the Herdr workspace label would read better, but the spec's sources do not list them."
learnings:
  - "Herdr keeps right clicks for its own pane menu unless the pane asks: `herdr pane input --right-click pane <PANE_ID>` routes them to the pane (and `--right-click herdr` gives them back). Left clicks and the wheel reach a pane app that turns on mouse reporting, according to Herdr's config text (mouse_capture: 'Pane apps like lazygit and btop can still receive mouse when they request it'). HERDR_PANE_ID names the current pane."
  - "Ink 6 splits an SGR mouse report into one input event and hands useInput the sequence without its leading ESC ('[<0;10;5M'), so the console parses mouse reports inside its useInput handler."
  - "`herdr agent list` gives many agents no `name`; they carry `agent` (the tool), `agent_session.value` (the Claude session id, which is the transcript's file name) and `terminal_title_stripped`. Such an agent is reached with `herdr tab focus <tab_id>`, because `herdr pane focus` only moves to a neighbouring pane."
  - "A Claude transcript's model is `message.model` on assistant entries; some entries say `<synthetic>` and must be skipped."
  - "Node 20's `node --test` (no arguments) runs every .mjs under a test/ directory, fixtures included, and counts each as a test. console/test/fixtures/board.mjs is counted that way, like test/helpers.mjs already was."
  - "`herdr pane wait-output` has no timeout option and can block for good; poll with `herdr pane read --source visible` instead."
  - "Choosing `org console` from the main checkout runs main's console. To try a lane's console, run that worktree's own bin/org.mjs console (it uses the worktree's console/ and passes its own bin as HERDR_ORG_BIN)."
artifacts:
  - "branch lane/brain-console-v1 (rebased onto main 35e1da5): e3e556d review round 3 record; eb88362 core read-model fields; 5440484 console screen; d2bdbcb README; 161ea9d right-click routing; e288535 cross-org code stripping and menu placement; plus this report's commit"
  - "npm test → 100 pass, 0 fail; npm --prefix console test → 62 pass, 0 fail, 0 skipped (before: 67 and 29)"
  - "new console modules: console/lib/theme.mjs, names.mjs, repos.mjs, mouse.mjs; reworked model.mjs, controller.mjs, frame.mjs, session.mjs, sources.mjs, cli.mjs, config.mjs, app.mjs"
  - "new tests: console/test/names.test.mjs, sources.test.mjs, board.test.mjs, controller.test.mjs, frame.test.mjs; fixture console/test/fixtures/board.mjs and two transcripts"
  - "node console/app.mjs --config <copy> --print 140x40 (and 80x24 --keys h; NO_COLOR 100x20 --keys s) for snapshots against a temporary org copy"
---

# Console 0.0.2a: the screen

## What the operator gets

```text
 herdr-org > 21:25 > 4/30 sessions today > nothing waiting > 2 alerts >        < console 0.0.2 < ? help
     SESSION                    WHO                    WHERE              UP      STATE     DOING
 ( bch-cloak ) ~/development/bastian/bch-cloak ─────────────────────────────────────────── ( 12 )
 >   lane-seal-selector-mal-02… Claude Opus 5          lane-seal-selecto… 2m      ● working Seal v2 branch selector…
 ( herdr-org ) ~/development/rewt/herdr-org ────────────────────────────────────────────── ( 7 )
     lane brain-console-v1 r5   Claude Opus 5 · high   lane-brain-consol… 24m     ● working Brain console 0.0.2a
     settle-r-2-1852            Claude Opus 5          herdr-org          2h      ✓ done    no description
 ( costco ) ~/development/costco ───────────────────────────────────────────────────────── ( 3 )
     mvp2poc                    Claude · unknown       costco             unknown ● working Fastly TLS subscription…
 ────────────────────────────────────────────────────────────────────────────────────────────────
 Task   n  Describe the outcome. Enter adds a line.
        Where  choose repository    Who  choose route    Goal  choose goal         ( Review launch )
 LIST >  j/k select  Enter go to session  s summary  n new task  m menu  h history  / scope  ? help
```

This is a `--print 140x40` snapshot against a copy of the live org with live Herdr data. The
powerline glyphs are drawn here as `>`, `<`, `(` and `)`.

## How to try it

The lane is not promoted, so run this worktree's own `org` (it uses the worktree's console).
The console only reads the org, except when you answer a question (`y` or `n`).

```sh
npm --prefix /Users/rewt/development/rewt/.worktrees/herdr-org/lane-brain-console-v1/console ci
herdr tab create --workspace wGH --cwd /Users/rewt/development/rewt/herdr-org --label console-0.0.2 --focus
# then, in that new tab:
node /Users/rewt/development/rewt/.worktrees/herdr-org/lane-brain-console-v1/bin/org.mjs console --project herdr-org
```

`wGH` is the herdr-org workspace today (`herdr workspace list` shows it). The configuration is
the existing `~/.config/herdr-org/console.json`. For the rounded look, set the terminal that
hosts Herdr to a Nerd Font. No Nerd Font is installed on this Mac yet, for example:
`brew install --cask font-maple-mono-nf`, then pick "Maple Mono NF" in the terminal's settings.
Until then, add `"glyphs": "plain"` to console.json, or the segment arrows show as boxes.
Quit with `q`.

Things to try: `j`/`k`, Enter or a click on a session (Herdr switches to that tab; come back to
the console tab), `s` on any row, a right click or `m`, `h`, `/`, `!`, `w`, the wheel, and a
narrow and a wide pane.

## Mouse: what was and was not checked

- **Checked for real, in a Herdr tab:** the console started, turned on mouse reporting and drew
  the live sessions. `herdr pane input --right-click pane` returned ok for its pane. The keys
  `s`, `h` and `m`, and an SGR right-click report written into the pane with
  `herdr pane send-text`, all worked. The menu opened at the reported row. `q` restored the
  shell prompt.
- **Not checked:** a click with a real mouse through Herdr's client. I have no way to press a
  mouse button in Herdr. The evidence that it works is Herdr's own config text: pane apps
  receive the mouse when they ask for it, and right clicks go to Herdr's pane menu unless the
  pane asks for them. The console asks for both. **Please try a left click, a right click and
  the wheel.** If Herdr still opens its own menu on a right click, `m` opens the console's menu.
- **Checked in a local pty with the real Ink app:** mouse reporting on at start, off at `q`, off
  and back on around an editor (`o` with `EDITOR=/usr/bin/true`), and off on SIGTERM. A crash
  (uncaught exception) goes through the same give-back code, but I did not trigger one.
- **Not done:** Enter or a click on a live session row in the test tab. That would have focused
  another agent, which the brief forbids. Go-to-session is tested with fakes: injected in the
  session tests, and a fake `herdr` on PATH for the exact argument arrays.

## Choices (where the spec was silent, or spec and mock differ)

1. **UP is 7 columns wide**, not the mock's 5, so `unknown` is never cut. At 140 columns WHERE
   is 18 wide, and at 100 SESSION is 22. STATE is 9 wide, so "● working" fits.
2. **`n` does two things**, as the mock's footer does: on a question it declines; anywhere else
   it is "new task", which in this round only says `task launching comes in the next round`.
   Tab says the same. In the history, `n` overrules an automatic answer, as before.
3. **Goal in the resting launch bar says `choose goal`.** The mock prefills a goal, but finding
   "the goal with the most open work" belongs to round 0.0.2b. Where is prefilled only when the
   scope is one repository.
4. **The menu has only the spec's items** (Go to session, Summary, Approve, Decline, plus
   Overrule in the history). The mock's "Open brief (o)" is left out; `o` still works.
5. **Right clicks:** the console asks Herdr for right clicks in its own pane while it runs, and
   gives them back when it quits, suspends or crashes (`herdr pane input --right-click`). It
   touches no other pane. Without this, a right click never reaches the console.
6. **A session without a Herdr name** is reached with `herdr tab focus <tab>`. The spec says
   `herdr pane focus`, but that command only moves to a neighbouring pane.
7. **An org alias model** (`opus`, as recorded by org start) gives way to the exact model in the
   session transcript (`claude-opus-5`), so WHO reads `Claude Opus 5 · high`. With no
   transcript it reads `Claude Opus · high`.
8. **SESSION for an agent with no name** is its Herdr tab label; a bare number becomes `tab 1`.
   An agent's name is shown as it is (for example `settle-r-4-1912`).
9. **DOING skips a terminal title that only repeats the agent's name**, or that is left with
   fewer than two words once codes are stripped. The brief's first sentence skips headings.
   A value cut at ten words ends in `…`.
10. **Codes in session text:** SESSION and DOING lose codes with the org's own prefixes and also
    with the default ones. Sessions from other organizations (for example ARCH-28 in bch-cloak)
    otherwise kept theirs. They are stripped without the `· no plain summary` mark, which does
    not fit a column.
11. **"Gone for an hour"** is timed from when this console last saw the agent in Herdr. For an
    agent it never saw, the time runs from the run's start. When Herdr is down, open runs show
    `unknown`, never `gone`, and none are hidden.
12. **Waiting on you scrolls with the list.** It is first, but it is not a pinned region, so a
    long question list cannot push the sessions off the screen for good.
13. **Groups are repositories as git sees them**, via `git rev-parse --git-common-dir`, cached
    per folder. A folder outside git is its own group, and an agent with no known folder goes
    under `unknown repository`.
14. **Scope popup has no search box**, and `0` (clear filters) is not added. `/` then
    "All repositories" does the same.
15. **Plain glyph mode** makes the screen's own symbols ASCII (`·`, `…`, box lines, dots) but
    leaves agents' letters alone (é stays é).
16. **The last terminal row** (Ink draws one row short) is painted black with a saved-cursor
    escape after each render.
17. **Transcripts are read for Claude agents only.** For a Codex session the Message tab says
    so, and WHO shows `Codex · unknown` unless org recorded the model.

## Evidence

- Rebase: `git rebase main`, 21 commits, no conflicts.
- Baseline before the work: npm test 67/67 and console 29/29. After: 100/100 and 62/62. These
  tests failed first and then passed: the core read-model test, names/mouse/repos/theme,
  sources, board, the right-click routing, the 0.0.2 version and the cross-org prefixes. The
  controller and frame tests were written before their code but first run after it. That first
  run failed (1 and 7 tests); I fixed the code or the expectation for each failure until they
  passed.
- `node console/app.mjs --config $TMPDIR/console-test.json --print 140x40` against
  `cp -R ~/development/rewt/.org $TMPDIR/org-copy` took 0.3 s with 25 live agents. That includes
  the first read of their transcripts.
- `NO_COLOR=1 … --print 100x20 --keys s` printed no character outside ASCII.
- Herdr commands I ran: `herdr agent list`, `herdr tab list`, `herdr workspace list`,
  `herdr tab create --workspace wGJ --label console-0.0.2a-test --no-focus` (my own tab `wGJ:tA`),
  `herdr pane run/read/send-keys/send-text` on that tab's pane only,
  `herdr pane input --right-click pane wGJ:pB`, and `herdr tab close wGJ:tA`.

## Not done in this round

- The launch chain, the pickers and routes (0.0.2b).
- The spec's acceptance 5 (launch smoke test) and the launch half of 7 are therefore still open.
- A human check of real mouse clicks in Herdr (see Mouse).
