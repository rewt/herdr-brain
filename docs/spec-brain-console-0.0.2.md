# Herdr Brain console 0.0.2: spec

Date: 2026-09-16, America/Chicago. Status: **approved by the operator on 2026-09-16**, with
Enter and left click going straight to the session. It replaces the screen described in
`spec-brain-console-v1.md`. That build was tried by the operator and is not
usable. The next version is 0.0.2, not v1.

The target design is the Lane Console wireframe
(https://claude.ai/code/artifact/fc46acf7-31b3-4466-8fb4-e1778aaaaa91; its
write-up is `docs/reference/herdr-lanes/CONSOLE-UX.md`), plus the operator's
additions below. The mock of this spec is linked at the end. **Where this text
and the mock disagree, ask; do not pick one.**

## Why

The console is the operator's cockpit. It runs in a Herdr tab, with Herdr's own
workspace and agent sidebar to its left. From it the operator must be able to:

1. see every agent session at a glance: what it is, which tool and model runs
   it, where, for how long, and what it is doing;
2. answer the questions agents are waiting on;
3. start new work by typing a task, choosing who does it and where.

## What carries over from the current lane

The lane `brain-console-v1` stays open, and 0.0.2 is built on it. The name of
the lane does not change. Keep, and change only where this spec says so:

- the org core: `org ask`, `org answer`, approval categories, note `--summary`,
  report `headline`, `org today --json`;
- `console/` packaging, `org console`, `console.json`, `contrib/console-pane.sh`;
- data readers (org, Herdr, ledger, transcripts), code stripping, the approve
  and decline flow with confirmation, selection by identity, `NO_COLOR`,
  suspend-and-restore for `o`.

Rework: the screen layout, the rows, the theme and the detail view. Add: the
launch bar. Set `console/package.json` `version` to `0.0.2` and show it in help.

## Look

- **Black background.** Paint the whole screen (`#000000`) with Ink
  `backgroundColor`, including empty lines, so the terminal's own background
  never shows.
- **Powerlevel10k style.** The header and the footer are rows of coloured
  segments joined by powerline arrows (``, ``), with Nerd Font icons.
  Group headers use a thin rounded cap (``…``). Rows stay plain text on
  black; the selected row gets a dark-blue band.
- **Font.** The terminal owns the font. The README tells the operator to set
  Herdr to a Nerd Font (Maple Mono NF recommended for a rounded look;
  JetBrains Mono Nerd Font works). `console.json` gains `"glyphs": "nerd"`
  (default) or `"plain"`; `plain` swaps every powerline and icon glyph for
  ASCII (`>`, `|`, `*`). `NO_COLOR` implies `plain` segments without colour.
- **Palette** (true colour; fall back to the nearest 256 colour):

  | Token | Hex | Use |
  |---|---|---|
  | bg | `#000000` | screen |
  | panel | `#121212` | group headers, input fields |
  | selected | `#1c2b3a` | selected row band |
  | fg | `#e4e4e4` | text |
  | muted | `#8a8a8a` | secondary text, column heads |
  | seg-project | `#0087af` bg, `#ffffff` fg | project segment |
  | seg-time | `#303030` bg | clock, counts |
  | seg-alert | `#d75f00` bg | alerts, questions waiting |
  | working | `#5fd7ff` | state: working |
  | idle | `#8a8a8a` | state: idle |
  | blocked | `#ff5f5f` | state: blocked, needs you |
  | done | `#87d787` | state: done |
  | claude | `#d7875f` | Claude tool name |
  | codex | `#afafff` | Codex tool name |

  Colour is never the only signal: every state is also a word.

## The screen (140 × 40)

```text
 herdr-org   20:50   4/30 sessions   2 waiting   0.0.2                                           ? help
╭ WAITING ON YOU ──────────────────────────────────────────────────────────────────────────────────────────── 1 ╮
 > ! Promote the Herdr Brain console into main?                           tooling · recommend yes · asked 19:19
╭ herdr-org  ~/development/rewt/herdr-org ────────────────────────────────────────────────────────────────── 3 ╮
     SESSION                        WHO                  WHERE                         UP     STATE    DOING
     settle R-4                     Claude Opus 5 · high  herdr-org                     12m    working  Verifying correction round three
     lane brain-console-v1 r3       Claude Opus 5 · high  lane-brain-console-v1         44m    done     Fixing review round two findings
╭ coach  ~/development/rewt/coach ──────────────────────────────────────────────────────────────────────── 1 ╮
     coach                          Claude · unknown      coach                         2h     idle     Coach.me connector with Claude chat
╭ herdr-lanes  ~/development/rewt/herdr-lanes ───────────────────────────────────────────────────────────── 2 ╮
     board-messages /eng+           Codex Astra · xhigh   lane-board-messages           9m     working  Building the rule table first
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Task  ▏Describe the outcome. Enter adds a line.
 Where [herdr-org]   Who [Claude Opus 5 · high]   Goal [Herdr Brain console]                       [Review launch]
  j/k select  Enter go to session  s summary  y/n answer  n task  h history  / scope  q quit
```

Top to bottom:

1. **Header**, one row of segments: project, clock, sessions today against the
   cap, waiting count (alert colour when above zero), alerts, `STOP` when the
   file exists, the version. `? help` on the right. Herdr unavailable or stale
   org data become their own alert segment.
2. **Waiting on you**, pinned first, only when a question is open. One row per
   question: `!`, the plain question, then category, recommendation and when it
   was asked. Ranked as in v1.
3. **Sessions**, one group per repository, with the repository name and its
   path (`~` for home) in the group header and the session count on the right.
   Worktrees belong to their main repository's group. Groups are ordered by
   the most urgent session inside (blocked, then working, then idle, then
   done), then by name.
4. **Launch bar**, pinned above the footer (see below).
5. **Footer**, one segment row with the keys that work right now.

There is **no always-visible detail pane** and **no Decided or Finished list
on the main screen**. Those move to the summary popup and the history view.

At 100 columns drop WHERE; at 80 columns drop WHERE and UP and show DOING on a
second line under the session (as the wireframe's narrow mode). Below 80 × 20,
show only the resize hint. Scroll the session list; the header, launch bar and
footer never scroll.

### Session columns

| Column | Content | Source, in order |
|---|---|---|
| SESSION | A short name: the lane topic and round (`lane brain-console-v1 r3`), the settle or executive session name, else the Herdr tab or pane label | org run meta (`lane`), `herdr agent list`, Herdr tab label |
| WHO | Tool and model in words, plus effort when known: `Claude Opus 5 · high`, `Claude Fable 5.1`, `Codex Astra · xhigh`, `Codex Sol` | org run `harness`/`model`/`effort`; else the tool from Herdr (`agent`) and the model from the session transcript (the last assistant entry's `model`); unknown model → `Claude · unknown` |
| WHERE | The checkout folder name (worktree name for lanes) | Herdr `cwd` |
| UP | How long the session has run: `9m`, `2h`, `3d` | org run `started`; else the transcript's first entry time; else `unknown` |
| STATE | `working`, `idle`, `blocked`, `done`, `gone` | Herdr `agent_status`; an org run whose agent is missing is `gone` |
| DOING | What it is doing, at most ten words, cut at a word boundary | Herdr `terminal_title_stripped` (Claude keeps it current); else the first sentence of the run's brief; else the org item title; else `no description` |

A table maps model IDs to words (`claude-opus-5` → `Claude Opus 5`,
`claude-fable-5-1` → `Claude Fable 5.1`, `gpt-6-astra` → `Codex Astra`, and so
on); an unmapped ID is shown as it is. Codes are stripped from SESSION and
DOING as in v1.

Rows come from **every Herdr agent**, not only org runs. The rail scope
(below) limits them. Org runs whose agent is gone stay for one hour as `gone`.

### Scope rail (180 columns and wider only)

Herdr's own sidebar already sits to the left of the tab, and at 140 columns the
six columns need the full width, so the rail appears only at 180 columns and
wider. It is a 22-column left rail as in the wireframe: `All repositories`, each repository
with its session count, then view toggles `! needs you`, `w working`,
`h history`. `/` opens the same list as a popup at every width. Scope never
changes the launch bar's Where.

### Going to a session, and the summary popup

**Going to the session is the default.** On a session row, `Enter` or a
left click focuses that agent's Herdr tab (`herdr agent focus <name>`, or
`herdr pane focus` when the row has only a pane). The console stays open in
its own tab. If the agent is gone, say so in the footer and do nothing else.
`f` is kept as an alias.

**`s` opens the summary popup** for the selected row: a centred popup with
the v1 tabs, renamed for sessions as in the wireframe:

- questions: **Summary**, **Memo**, **Context** (the v1 approval view);
- sessions: **Message** (last assistant message, rendered markdown),
  **Brief** (the run's brief, or `no brief recorded`), **Context** (IDs, paths,
  agent, pane, run, report, gate).

Keys inside: `1/2/3`, scroll keys, `o` open the file, `Enter` or `f` go to the
session, `y/n` on questions, `Esc` close.

On a question row there is no session to go to, so `Enter` or a left click
opens the summary popup.

**Right click** on a row opens a small menu at the row: `Go to session`,
`Summary`, and on questions `Approve` and `Decline`. Arrows and Enter pick,
Esc closes. `m` opens the same menu from the keyboard.

**Mouse.** Turn on the terminal's mouse reporting (SGR mode, `\x1b[?1000h`
and `\x1b[?1006h`) while the console runs, and turn it off on exit, on
suspend for `o`, and on a crash. Map a click to a row by its screen line. A
wheel scrolls the list. The keyboard always does everything the mouse does.
Check early, in a real Herdr tab, that Herdr passes clicks and right clicks
to the pane; if it keeps right click for itself, say so in the report and
keep `m`.

### History view

`h` swaps the session list for today's history, newest first: answers,
decisions and finished work, one line each, in the v1 plain wording. `Enter`
or `s` opens the summary popup. `h` or `Esc` returns.

## Launch bar

The operator types a task, chooses who and where, reviews, and launches.
Follow the wireframe's launch-bar rules (CONSOLE-UX.md "Launch bar" and
"Popups"): `n` or Tab focuses it, Enter adds a line, Esc keeps the draft, only
`[Review launch]` opens the review, the review's default button is Back.

Fields:

- **Task**, multi-line. Its first line becomes the item title.
- **Where**, a repository picker: the repositories in `console.json` and the
  ones Herdr sessions run in, plus `Enter path`. Prefilled with the scoped
  repository only when the scope is one repository.
- **Who**, a picker of routes: tool, model and effort, with a use note, from
  `console.json` `routes` (below). No guessing a model from a name.
- **Goal**, a picker of the project's open org goals, plus `No goal`. Prefilled
  with the goal that has the most open work.
- **Topic**, editable, suggested from the task (kebab case), shown in review.

```json
"routes": [
  { "name": "engineer", "harness": "claude-code", "model": "opus", "effort": "high", "use": "Default engineering" },
  { "name": "engineer-codex", "harness": "codex", "model": "gpt-6-astra", "effort": "xhigh", "use": "Hard cross-cutting problems" },
  { "name": "review", "harness": "claude-code", "model": "opus", "effort": "high", "use": "Independent review" }
]
```

**Where a launched session gets its context, state and goals.** The org record
is the answer. Launch does, in one foreground command:

1. `org add "<first line>" --parent <goal> --role engineer` — the task is now
   state, under a goal;
2. `lane open <topic>` in the chosen repository — its own worktree;
3. writes `<worktree>/.lane/BRIEF-<topic>.md`: one plain sentence, the full
   task text, and the goal's title and notes;
4. `org start <ID> --harness … --model … --effort … --workspace <worktree>
   --report <worktree>/docs/reports/<topic>.md`, then
   `org note <ID> "Task brief: <path> — follow it"`;
5. `lane dispatch <topic> --kind … --model … @<org run brief>`;
6. `org set <run> agent=<name> lane=<topic>`, then arms the settle watcher.

The agent therefore starts from the org brief (goal, notes, acceptance), the
task brief, and the repository's own `AGENTS.md` or `CLAUDE.md`. When it
stops, the settle watcher records its report as today.

This chain lives in `contrib/launch-task.mjs` (dependency-free), which takes
`--repo --route --goal --topic --task-file` and prints one JSON result. The
console calls it with an argument array and never runs the steps itself. The
console still never stops or messages agents. The core `bin/org.mjs` does not
talk to Herdr.

Results follow the wireframe's list: refused before any change (draft kept),
lane opened but not dispatched, delivery unknown, dispatched but not recorded,
success. Each names what exists and the next safe step. No automatic retry.
On success the new row is selected once it appears, and focus stays in the
console.

A repository not configured for org (no `ORG_DIR`) still launches through
`lane` alone, with Goal disabled and `no org record` shown in review.

## Build order

Two rounds on the same lane, one after the other, each with its own review:

1. **0.0.2a — screen:** look, header and footer segments, Waiting group,
   session groups and columns, rail (180+ columns), go-to-session on Enter
   and click, summary popup, right-click menu, history view, widths.
2. **0.0.2b — launch:** launch bar, pickers, review, `contrib/launch-task.mjs`,
   `routes` in `console.json`.

## Tests

As in v1 (offline, `node --test`, root `npm test` without console
dependencies, a failing test first for every behaviour change), plus:

- frame tests at 80 × 24, 100 × 30 and 140 × 40 that assert the columns shown,
  the pinned header, launch bar and footer, and the black background on every
  row;
- `plain` glyph mode has no character outside ASCII;
- WHO from each source, the model-name table, an unknown model;
- UP and DOING fallbacks, the ten-word cut;
- grouping of worktrees under their repository, group order;
- the launch chain against fake `org`, `lane` and `herdr` binaries on `PATH`,
  one test per result kind; the console never runs a step itself.

## Acceptance

1. At 140 × 40 the screen matches the mock: black background, segment header
   and footer, Waiting group, grouped sessions with all six columns, and the
   launch bar; the rail appears at 180 columns. 100 and 80 columns drop columns as specified.
2. Every live Herdr session appears in its repository group with WHO, WHERE,
   UP, STATE and DOING filled from the listed sources, or an honest `unknown`.
3. Enter and a left click on a session row go straight to its Herdr tab;
   `s` and the right-click menu open the summary popup. The popup and the
   history view replace the old reader and Decided and Finished lists; approve
   and decline still work with confirmation.
4. `glyphs: plain` and `NO_COLOR` produce a readable screen with no powerline
   glyphs.
5. A task launched from the bar appears in org under the chosen goal, gets its
   own lane and brief, and shows up as a working row, in a smoke test against
   a temporary org copy and a scratch repository.
6. The core stays dependency-free and all tests pass.
7. The README covers the font, `glyphs`, `routes`, the keys and the launch
   chain.

## Out of scope for 0.0.2

- Stopping, messaging or closing agents from the console.
- Web and phone views.
- The 24/7 loop and Beads.

## Mock

https://claude.ai/artifact/9iRpzGHg5qXiYtW4JGFD7m (source copies in `docs/reference/console-0.0.2-mock/`) — main screen at 140 × 40,
the summary popup, the launch review, and 80 columns. Sample data. In the mock
the powerline arrows are drawn shapes and JetBrains Mono stands in for the
terminal's Nerd Font.
