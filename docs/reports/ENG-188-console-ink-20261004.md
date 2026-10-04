---
run: R-242
outcome: done
summary: |
  Rebuilt the minimal console as bordered Ink Runs, Reports and Train panels,
  with an in-house table, narrow and wide layouts, consistent clocks, restrained
  stage/outcome colour and unchanged-output suppression. Rows with live agents
  open the existing native terminal grid and Herdr control stream; Esc and Back
  return without sending Esc, while the labelled Ctrl+backslash key interrupts.
  All four console follow-ups have regressions. The implementation is committed
  and 109 focused offline checks passed. The operator's console live tab still
  runs the canonical checkout, so its launch must be redirected to this lane.
headline: The minimal console has bordered panels and live session links with a safe Back key
blockers: []
proposals:
  - role: engineer
    title: Include minimal console regressions in promotion validation
    why: The explicit promotion list in test/helpers/tier.mjs omits console/test/minimal.test.mjs, feed.test.mjs, table.test.mjs and minimal-input.test.mjs. They currently default to the release tier; include them in the merge batch so rendering, session input and train regressions are checked before promotion.
learnings:
  - "The promotion batch directory retains its creation time while train.json is atomically replaced. Use explicit receipt timestamps first, then the directory birth time; receipt birth time resets on save."
  - "Minimal session Esc interception belongs in the raw input path: app.mjs skips ordinary Ink key callbacks while interactive. Extended keyboard CSI-u Esc encodings must also return without reaching the agent."
artifacts:
  - "commit 43272ac: Build minimal console from bordered Ink panels with session links"
  - "branch lane/console-ink"
  - "console/modern/table.mjs"
  - "console/modern/minimal-view.mjs"
  - "console/modern/minimal-session.mjs"
  - "console/modern/session-screen.mjs"
  - "console/modern/feed.mjs"
  - "console/test/table.test.mjs"
  - "console/test/minimal-input.test.mjs"
  - "console/test/minimal.test.mjs"
  - "console/test/feed.test.mjs"
  - "console/test/fixtures/minimal-40x24.txt"
  - "console/test/fixtures/minimal-100x24.txt"
  - "console/modern/README.md"
decisions: []
questions: []
challenges:
  - "The ask says the supervisor points console live at this worktree. Read-only inspection found tab wHJ:t7, pane wHJ:p8 still showing the old text renderer; its app process runs /Users/rewt/development/rewt/herdr-brain/console/app.mjs from the canonical checkout. This lane's live-data --print and temporary interactive console both show the new Ink layout."
---

The Runs table is built from Ink Boxes with cli-boxes characters already supplied
by Ink. Its header, rules, separators, alignment and truncation are shared by the
live view and `--print`, which renders the Ink tree to a string. At 90 columns
and above it uses six columns within a 116-cell reading width; narrower panes
keep run/work/stage on one line and provider/start/elapsed on the next. Joined
emoji, flags, combining accents and wide glyphs are measured as whole cells.
Reports and Train have their own borders, with one quiet Context line above.
Whole entries receive space across the panels, overflow counts remain in the
headings, and selection brings older rows into view.

Live row activation rechecks the exact observed agent occupant and canonical Git
identity before taking its control stream. Run, report and train entries link
when their matching agent is still present; historical rows explain when no live
session exists. Multi-lane batches expose separate member entries. The native
screen's colour, cell positions and cursor reuse the full console's extracted
session grid; the full console's behaviour and painter remain unchanged.

Esc, the top-left Back button and Ctrl+] release control and retain the selected
row. Esc is consumed in both the key API and raw byte path, including extended
keyboard encodings, and never interrupts the agent. The footer labels Ctrl+\ as
`interrupt (Esc)`; that explicit key sends Esc. Ordinary typing, Unicode and
arrows retain their bytes, mouse reports stay in the console, and replaced or
unavailable occupants release control. `--print`, including Enter/action keys,
never opens a control stream. No record mutation, scheduling, promotion or model
call was added.

The four console fixes are covered individually:

- Configured cwd without explicit org/ID selects the consistently derived catalog
  ID plus canonical repository identity, then discovers its record.
- Batch start uses an explicit receipt timestamp or stable batch-directory birth
  time and survives atomic receipt replacement.
- A final promoted/refused receipt wins over an older interrupted queue result
  while a resumed batch waits for delivery.
- Finished checks use recorded duration or finish time; delivery wait no longer
  extends their elapsed duration. Missing live check clocks remain unknown;
  writing in-flight telemetry remains the existing separate work item.

Validation: `node --test console/test/minimal.test.mjs console/test/feed.test.mjs
console/test/table.test.mjs console/test/minimal-input.test.mjs` passed 37 offline
checks. `node --test console/test/modern.test.mjs console/test/terminal.test.mjs
console/test/control.test.mjs console/test/paint.test.mjs` passed 72 more. The
actual print CLI matches both committed snapshots for the configured profile and
both minimal flags, and emits only read operations despite action keys. A real
Ink render writes no terminal bytes for unchanged facts, changes only the elapsed
row when the clock advances, and resizes between narrow and wide layouts.
`git diff --check` passed before the implementation commit.

Read-only live snapshots from this lane displayed the current engineering lanes,
supervisor/chats, blocked work, recent checked reports and train results. A
separate temporary PTY ran this lane's actual interactive Ink entry point with
live data, then quit successfully with balanced terminal modes. No agent input
was sent during live verification; session navigation and interruption were tested
offline. Mac screenshot capture was unavailable because the Computer Use native
pipe failed to start. The operator's console live launch is still canonical;
the supervisor can point it at this lane's `console/dev.mjs` to review the screen.

The requested final lane check runs after this report is checked and committed;
its exact-HEAD result is kept in `.lane/gate.json`. Promotion and release suites
remain with their owning stages.
