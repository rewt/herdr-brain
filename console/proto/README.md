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
node --test console/proto/prototype.test.mjs
```

Synthetic `harbor` and `orchard` data only: six goals, sixty tasks, three human
questions, ten queue questions (thirteen waiting total), three unread results,
eight sessions, five lanes. No subprocess, model, network, config or organization
access. A choice, reply, later, drop or acknowledgement changes memory only;
starting a session and going to a pane show a simulation receipt. Restart resets.

Main: Tab / arrows focus, j/k select, Enter opens. `!` opens the global inbox;
`p` chooses project; `:` shows the screen chooser. `b` always backs out except
while typing in a field; Tab to Cancel and Enter is the non-Esc editor exit.
Click a row to select, its trailing `>` to open, a header to focus, or a visible
button to act. Wheel moves the region under the pointer. Right click stays with
Herdr. `--no-mouse` leaves native mouse selection available. `q` quits at root.

`--screen`: waiting, goal, task, session, peek, inbox, later, lanes, history.
`--scope`: harbor, orchard, all. `--keys` is a comma-separated replay: Enter, Tab,
BackTab, Esc, Up, Down, Left, Right, Home, End, PageDown, PageUp, Space, or text.
Text replays are convenient for editors; live bracketed pastes only enter fields.

The architecture follows the current console: source-shaped fixture → pure read
model → pure key/mouse reducer → frame with spans and hit rectangles → Ink host.
The prototype only imports existing dependency-free text helpers from `console/lib`;
no existing file is modified. It uses the installed Ink 6.8 and React 19.3.

`render-mockups.mjs` regenerates the snapshot files and the generated section of
the design document from the exact same frame used by Ink. Interactive rendering
reserves the terminal's last line, like `app.mjs`; `--print` uses the requested
height exactly. Minimum is 80 columns and a 24-row terminal. ANSI colors are
optional (`NO_COLOR`), and focus also uses text markers; no Nerd Font is required.

Known prototype boundaries: no durable read receipts or saved drafts, no live
refresh, no external editor, no pane switching, and no right-click interception.
These are explicit limits of the design object, not completed product integrations.
