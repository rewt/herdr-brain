# Console design object

```sh
npm --prefix console ci
node console/proto/main.mjs
node console/proto/main.mjs --print 140x45
node console/proto/main.mjs --print 100x40 --goal G-1
node console/proto/main.mjs --print 80x30 --goal G-1 --task ENG-1
node console/proto/main.mjs --print 80x30 --screen waiting
node console/proto/main.mjs --print 100x40 --screen session
node console/proto/main.mjs --print 100x40 --keys Tab,Tab,j,Tab,j,Tab,Enter
node --test console/proto/*.test.mjs
```

Synthetic `harbor` and `orchard` data only: six goals, sixty tasks, three human
questions, ten queue questions (thirteen waiting total), three unread results,
eight sessions, five lanes. No subprocess, model, network, config or organization
access. A choice, reply, later, drop or acknowledgement changes memory only;
starting a session and going to a pane show a simulation receipt. Restart resets.

Main: Tab / arrows focus, j/k select, Enter opens. `!` opens the global inbox;
`p` chooses project; `:` shows the screen chooser. `b` always backs out except
while typing in a field; Tab to Cancel and Enter is the non-Esc editor exit.
`>` identifies the focused region and active row; `*` retains a selection in
another region, and task states are written as words.
Click a row to select, its trailing `>` to open, a header to focus, or a visible
button to act. Wheel moves the region under the pointer. A right click opens the
row menu if Herdr forwards it; `m` always opens the same menu. The prototype does
not claim Herdr's context-menu shortcut. `--no-mouse` leaves native mouse
selection available. `q` quits at root.

`--screen`: waiting, goal, task, session, peek, inbox, later, lanes, history, operations,
decisions, decision, authority. `--goal` chooses the goal/authority reader;
`--task` chooses the task reader; `--scope`/`--goal` select a matching decision.
`--scope`: harbor, orchard, all. `--keys` is a comma-separated replay: Enter, Tab,
BackTab, Esc, Up, Down, Left, Right, Home, End, PageDown, PageUp, Space, or text.
Text replays are convenient for editors; live bracketed pastes only enter fields.

The architecture follows the current console: source-shaped fixture → pure read
model → pure key/mouse reducer → frame with spans and hit rectangles → Ink host.
The prototype only imports existing dependency-free text helpers from `console/lib`;
no production console file is modified. It uses the installed Ink 6.8 and React 19.3.

`render-mockups.mjs` is the original ARCH-3 generator; its snapshots and document
are retained as historical design evidence. `render-autonomy.mjs` generates the
new autonomy snapshots and crops in the ARCH-4 design from the frame used by Ink.
Interactive rendering
reserves the terminal's last line, like `app.mjs`; `--print` uses the requested
height exactly. Minimum is 80 columns and a 24-row terminal. ANSI colors are
optional (`NO_COLOR`), and focus also uses text markers; no Nerd Font is required.

Known prototype boundaries: no durable read receipts or saved drafts, no live
refresh, no external editor or file opening, no pane switching, and no live loop
or instruction writes.
These are explicit limits of the design object, not completed product integrations.

## Live-console workflows

The live console is the baseline for retained functionality. The goals study's
first pass preserved the earlier cascade prototype but missed live controls;
those flows are now represented here on fixture data. See the
[workflow comparison](../../docs/design/console-live-workflows-2026-09-19.md).

- `i` records project direction after review; `h` shows it in history.
- `L` reviews a capture-loop change. It never changes goal authority or STOP.
- `O` opens project status: daily sessions, STOP, stale state, Herdr health,
  alerts and the latest project direction. The header exposes the status at a glance.
- `r`, `y`, `n`, `Y`, numbers, `l`, `x`, `d` and `g` act on the selected row
  where applicable; `m` shows its available actions. `y` reviews the recommended
  choice; `Y` reviews the agent's text draft. `n` only chooses an explicit No
  option, or opens the reason editor for an automated answer in history.
- `V` / `D` / `C` switch Summary / Document / Context in a reader. Documents
  include captured screens, decision memos, briefs and reports; `o` simulates
  opening the source file. Number keys remain answer choices.
- `w` in a list filters sessions to working; the sessions header has the same
  mouse toggle. In a task/session reader, `w` still opens Why this work.

```sh
node console/proto/main.mjs --print 80x30 --screen operations --scope orchard
node console/proto/main.mjs --print 100x40 --screen session --keys D
node console/proto/main.mjs --print 100x40 --keys h,n
node console/proto/main.mjs --print 100x40 --keys i,Keep saved work readable.,Enter
```

## Goals and autonomous pickup study

```sh
node console/proto/main.mjs --print 80x30 --screen authority
node console/proto/main.mjs --print 100x40 --screen decisions
node console/proto/main.mjs --print 140x45 --screen decision
node console/proto/main.mjs --print 80x30 --screen authority --goal G-5
node console/proto/main.mjs --print 100x40 --screen decision --goal G-2 --keys o
node console/proto/main.mjs --print 100x40 --screen goal --keys ],a,2,Enter
node console/proto/render-autonomy.mjs
python3 console/proto/smoke-pty.py
```

`e` opens Next work: timestamped, lasting executive choices. Enter reads why a
task was chosen, what authority applied, alternatives and observed outcome.
`w` in a task/session reader finds the same receipt; absent receipts say so.
`n` in Next work reviews a project-wide executive request. The demo records only
the request and rejects duplicates; it does not synthesize a successful launch.

Focus Goals, select a goal, then `[` Earlier / `]` Later. Goal detail offers the
same actions plus `a` Authority. In Authority, `r` edits allowed work; `1` allows
pickup inside the envelope and `2` pauses future pickup, each with review before
the in-memory change. Missing authority cannot be enabled by a rank or toggle.
All these controls have named mouse targets. They never change existing sessions
or historical pickup evidence. Edits persist through Back, but restarting resets.

The fixtures add four executive decisions across two projects, with a start,
authority deferral, capacity deferral and no pick. Goal rank is project-local,
derived from descending numeric priority; task preference is local to its goal.
The authority question uses an existing waiting row, so global needs remains 13.
No live pickup, policy enforcement, durable write, new dependency, model call,
or change under `console/lib/` is implemented.
