# Brief: design the herdr-brain console screens

Written 2026-09-18 by the operator's drop-in session. You are a designer and
architect on Codex (Astra). This is a design task with a runnable prototype,
not a feature build. Read this whole file before touching anything.

## The one paragraph

The operator runs several software projects with autonomous agents in Herdr, a
terminal multiplexer with visible agent panes. `herdr-brain` is their instrument
panel: an Ink console that shows what needs their decision, what is running, and
what finished. The current screen works but is overwhelming: every waiting item
shows a paragraph and its choices inline, and the operator cannot see how any of
it relates to their goals. Design the screens that fix this: keyboard-first,
mouse-aware, multiple screens, minimal at first sight, detail on demand. Bring
the best of what the field knows about terminal UIs. Deliver a design document
with mockups at three widths, a keyboard and mouse map, and a running Ink
prototype of the main screen on fixture data, so the operator can look at it
and say yes, no, or closer.

## What the operator said (their words, 2026-09-18 21:15, binding)

- Kubernetes and K9s are a *light* guidepost: the scope (a project) is like a
  namespace; goals, tasks, open items, agents, sessions and worktrees are like
  resources. Do not go heavy on it.
- "Waiting on you" is right but far too much text. Each row becomes one line:
  id, a brief description, project, and a tag (needs, decision, read…). Enter
  opens a detail screen with the full summary, the actions, and what it relates
  to (goal, task, project). Keep the list minimal; if the operator wants more,
  they press Enter.
- Remove the "Task" composer at the bottom of the current screen. It is too
  hidden and unproven. It returns later, in a different form.
- The organization of agent sessions on the screen is good. Keep it.
- The open question is how the screens guide the operator: per scope, a top
  pane that cascades goals → tasks → open items (two or three columns; picking
  a goal narrows the tasks, picking a task narrows the items) and a bottom pane
  with the sessions. This needs a couple of design iterations. Your document is
  the first serious one.

The drop-in's own first sketch (for reference, not a constraint) is the last
decision note on goal G-2 and in the section "First sketch" below.

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-brain`.
- Your worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-design`
  on branch `lane/console-design`. Work only there. Run `npm --prefix console ci`
  first; a fresh worktree has no `node_modules`.
- The console today: `console/app.mjs` (entry), `console/lib/frame.mjs` (renders a
  frame from a view), `console/lib/controller.mjs` (pure reducer for keys and mouse),
  `console/lib/model.mjs` (the read model: `buildBoard`, `visibleBoard`, `scopeItems`),
  `console/lib/mouse.mjs` (what mouse support exists), `console/lib/theme.mjs`,
  `console/README.md`. Ink 6.8, React 19. Read all of it before designing; the
  prototype must be able to become this code, not replace it wholesale.
- See the live screen as the operator sees it, read-only:
  `env -u NO_COLOR node console/app.mjs --print 140x45 --project bch-cloak` and the same
  at `100x40` and `80x30`, and `--project herdr-brain`. This reads live state; it
  writes nothing.
- The data sources, read-only: `ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs today --json`
  and `status --json`; `node brain/bin/brain.mjs queue --all --json`. The bch-cloak
  organization is `/Users/rewt/development/bastian/.org` — you may read its JSON
  through the same two commands with that `ORG_DIR` and nothing else under
  `/Users/rewt/development/bastian`. Never run any command that writes to either
  organization (`add`, `note`, `set`, `answer`, `close`, `start`, `ingest`, `sync`,
  and brain's `send`, `key`, `later`, `never`, `answer`, `start`).
- Do not write anything under `~/.config`, `~/Library`, or outside your worktree.

## The data the screens must show

Everything comes from three read-only JSON sources. Shapes as they are today:

- **Project (scope)**: `{ name, org, cwd, ledger_dir, session_cap }` from the console
  config; `org today --json` adds `project: { org, as_of, events, item_prefixes, day,
  open_stage, top_goal }`.
- **Items** (`org status --json` → `items[]`): `{ id, kind, title, role, capability,
  parent, priority, accept[], budget, meta, created, closed, outcome, runs[], notes[],
  status, blocked_by[], blocks[], children[] }`. `kind` is `goal` or `item`; goals are
  `G-n`; item ids carry the role prefix (`ENG-`, `REV-`, `RES-`, `ARCH-`, `HUM-`).
  `role: human` items are questions for the operator; they carry `meta.category` and
  `meta.recommend`. `meta.stage` (`1|2|3|4|keys|parked`) is bch-cloak's stage
  discipline; `project.open_stage` says which stage is open. `status` is
  `ready | blocked | active | done | dropped`. `priority` is a number, lower first.
  Goals have children; children have children (depth ≤ 3). Budgets are advisory.
- **Runs** (`org status --json` → `runs[]`, and `org today --json` → `running[]`):
  `{ run, item, title, role, started, agent, lane, harness, model, effort, workspace,
  round, brief_path, report_path }`. `agent` is the Herdr agent name; `lane` the
  worktree topic; `workspace` its path.
- **Today** (`org today --json`): `waiting[]` (questions, see below), `decided[]`
  `{ kind, id, seq, title, summary, text, at, by }`, `running[]`, `finished[]`
  `{ kind, item, seq, title, role, as, note, at, by }`, `approvals { policy, counts }`,
  `attention[] { id, kind, text }`.
- **Brain queue rows** (`brain queue --all --json`): one row per thing a session
  left when it stopped or got stuck: `{ at, type, id, session, agent, state, where,
  workspace, tab, pane, tab_label, title, screen, said, unsent, suggestion, dialog,
  project, headline, status, digest, answer }`. `digest` is the one-model reading:
  `{ kind, item, gist, explain, what_happened, needs_you, question, options[],
  recommend, why, next_step }`. `state` is done / blocked / waiting; `dialog` is the
  prompt a session is stuck at; `unsent` is a draft the operator has not sent.
  Today's Waiting on you is these rows plus `role: human` org items, merged.
- **Sessions**: Herdr agents (`herdr agent list`, JSON): name, kind (claude/codex),
  status (working / idle / blocked / done), cwd, workspace, tab, pane. A session
  serves a run when the run's `agent` names it.
- **Lanes / worktrees**: `lane status` text today; later JSON. Topic, branch,
  ahead/behind main, dirty, rebase state, worktree path.

Fixture data for the prototype: build it from these shapes with synthetic values,
sized like bch-cloak today (six goals, ~60 open items across stages, 13 waiting
rows, 8 sessions, 5 lanes). Do not copy real bch-cloak text into fixtures.

## What to design

1. **Information architecture.** Which screens exist, what question each answers
   for the operator, and how they connect. The operator's model: scope → goals →
   tasks → open items, with sessions always visible, and a detail screen for any
   row. Say what a "task" is in org terms and what an "open item" is; the drop-in's
   reading is that tasks are the engineer / review / research items that get runs,
   and open items are anything waiting on the operator plus finished-unread results.
   Correct it if a better split exists.
2. **The main screen** at 80, 100 and 140 columns, as exact text mockups. Show the
   cascade (goals → tasks → open items), the sessions pane, the header with global
   counts (things needing the operator must never be hidden by a filter), and the
   key line. Show what changes when a goal is picked, when a task is picked, and
   when nothing is picked.
3. **The detail screen** for a waiting row: summary, the numbered choices with the
   recommendation, the "why", what it relates to (goal › task › run › project), the
   draft reply if one exists, and the actions (pick 1-9, y recommended, r reply,
   l later, x drop, d start a session, g go to the pane, Enter/peek the live
   screen). Also the detail screen for a goal, a task, and a session.
4. **Navigation.** How screens stack and how the operator gets back. Esc is used
   for back today and may stay, but there must also be a non-Esc way (a key and a
   click target), because in Herdr, Esc also interrupts an agent and the operator's
   fingers know that. Focus must be visible at all times. Everything reachable by
   keyboard must be reachable by mouse (click to select, click to open, click on a
   column header to focus that column, scroll wheel) and nothing must require the
   mouse. Say what `mouse.mjs` supports today and what the design needs from it.
5. **Keyboard map and mouse map**, complete, with no chords that Herdr already
   owns (see the Herdr key notes in `console/README.md`; the console runs in a
   Herdr pane or as a Herdr popup over any pane).
6. **Two alternatives** to your recommended layout, each in one mockup at 100
   columns with two sentences on where it wins and loses. One should be the
   "never filter the needs-you list" variant: the list stays global above the
   columns and the columns only browse. Recommend one and say why.
7. **Bring the field in.** Before drawing, write one page on what the strongest
   keyboard-driven terminal tools do that applies here, and what they get wrong:
   K9s (resource views, `:` command line, breadcrumb, hotkeys), lazygit (panels
   with one focused, context-sensitive keybindings shown at the bottom), htop /
   btop, mutt and aerc (index → pager), Magit (transient menus), Miller columns
   in Finder / ranger / nnn (the cascade the operator described), and any Ink-based
   TUI you know that handles multiple screens and mouse well. Cite what each
   contributes to your design and what you rejected.
8. **The prototype.** `console/proto/main.mjs`: an Ink 6 program rendering your
   recommended main screen and the detail screen on fixture data, keyboard and
   mouse working, `--print WxH` for a static render like `app.mjs` has. It lives
   only under `console/proto/` and touches nothing in `console/lib/`. It must run
   with `node console/proto/main.mjs --print 140x45` and interactively. Keep it
   honest: it is a design object, not the product, but every visual decision in
   the document must be visible in it.

Design rules that hold: plain words on screen, no internal codes as the first
thing on a row (the id is fine, jargon is not); nothing needs a manual; a
newcomer can find the thing that needs them within three seconds of looking; the
80-column render still works; the current session pane's organization is kept.

## First sketch (the drop-in's, for reference only)

```
 GOALS                       TASKS  (G-2, stage 1)             OPEN ITEMS  (ENG-89)
 > G-2  close the theft hole > ENG-89  profile binding    ✓  > ENG-89  send back or accept   decision
   G-3  freeze, re-run         ENG-33  aggregator verify  …    REV-65  two gaps, two wrong nums decision
 ───────────────────────────────────────────────────────────────────────────────────────────
 SESSIONS
   lane-created-side-seed-profile-binding   codex   done      ENG-89   32m
```

Open questions it left: whether waiting items live in the third column (filtered)
or in a global list; whether the task / open-item split is right; and adding a
"serves" column to sessions naming the task each one works on.

## The report

Write `docs/design/console-screens-2026-09-18.md` (the design document) and
`docs/reports/console-design.md` (the report) in the worktree and commit them
on the branch with the prototype. Report front matter as earlier rounds
(`run`, `outcome`, `summary`, `headline`, `blockers`, `proposals: []`,
`learnings`, `artifacts`). In the report: what you read, what the field
contributed, the three widths rendered from the prototype (paste the 100-column
one), your recommendation in five sentences, and the questions only the operator
can answer, each with your recommended answer.

## Acceptance (what the reviewer will check)

- The design document has the information architecture, the main and detail
  screens at 80 / 100 / 140, the navigation model, complete keyboard and mouse
  maps, two alternatives, and the field survey with sources named.
- `node console/proto/main.mjs --print 140x45` renders the recommended main
  screen from fixture data; `--print 80x30` still reads; interactive keys and mouse
  work; nothing under `console/lib/` changed.
- The operator's binding points hold: one-line waiting rows, Enter for detail, no
  Task composer, sessions organization kept, cascade present, global needs-you
  count never hidden.
- `npm test` and `npm --prefix console test` still pass; no organization was
  written to; nothing outside the worktree was touched.
