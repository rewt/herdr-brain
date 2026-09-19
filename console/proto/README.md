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
button to act. Wheel moves the region under the pointer. Right click stays with
Herdr. `--no-mouse` leaves native mouse selection available. `q` quits at root.

`--screen`: waiting, goal, task, session, peek, inbox, later, lanes, history,
decisions, decision, authority. `--goal` chooses the goal/authority reader;
`--task` chooses the task reader; `--scope`/`--goal` select a matching decision.
`--scope`: harbor, orchard, all. `--keys` is a comma-separated replay: Enter, Tab,
BackTab, Esc, Up, Down, Left, Right, Home, End, PageDown, PageUp, Space, or text.
Text replays are convenient for editors; live bracketed pastes only enter fields.

The architecture follows the current console: source-shaped fixture → pure read
model → pure key/mouse reducer → frame with spans and hit rectangles → Ink host.
The prototype only imports existing dependency-free text helpers from `console/lib`;
no existing file is modified. It uses the installed Ink 6.8 and React 19.3.

`render-mockups.mjs` is the original ARCH-3 generator; its snapshots and document
are retained as historical design evidence. `render-autonomy.mjs` generates the
new autonomy snapshots and crops in the ARCH-4 design from the frame used by Ink.
Interactive rendering
reserves the terminal's last line, like `app.mjs`; `--print` uses the requested
height exactly. Minimum is 80 columns and a 24-row terminal. ANSI colors are
optional (`NO_COLOR`), and focus also uses text markers; no Nerd Font is required.

Known prototype boundaries: no durable read receipts or saved drafts, no live
refresh, no external editor, no pane switching, and no right-click interception.
These are explicit limits of the design object, not completed product integrations.

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
