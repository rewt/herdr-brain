# A modern shell for the live console

The operator clarified the target: enhance the console launched by `org console
--project bch-cloak`. Goals and tasks belong inside that application. This is a
visual and interaction design pass to discuss together before implementing the
new shell in Ink; the fixture cascade alone is not the product baseline.

## Visual direction

Use a quiet navigation rail, one main workspace and a persistent session table
below. Keep text on a monospace grid. Build hierarchy through spacing, alignment,
weight and two surface tones. Use blue for selection and amber for attention;
remove powerline segments, repeated boxed labels and permanent command strips.
Terminal fonts stay under the operator's control. No oversized web headings,
shadows or custom icon font are required by the Ink design.

The first wireframe opens Needs you: concise question rows and finished results.
Opening a question gives the explanation, viable options and recommendation a
dedicated reader. A split list/reader is an alternative to assess. Goals and
Tasks are stable navigation destinations; opening a goal retains its context
while showing related work and authority. After the operator's next review, the
session table stays open by default; expanding Sessions gives it the main
workspace. A collapsed dock still shows connection/health state.

```text
 herdr brain     Needs you                       Instruct   + New task
 bch-cloak
                 13 waiting
 > Needs you     ENG-89    Profile-binding review gaps       decision
   Goals         ENG-116   Stop proving-key work?            decision
   Tasks         REV-64    Backup verification bug           decision
   Sessions
                 Ready to read
   Next work     REV-66    Profile-binding review passed
   History
   Saved         ----------------------------------------------------
                 Sessions · current project             Expand
   : Commands    Session   Who   Where   Up   State   Doing
 --------------------------------------------------------------------
 Tab focus   j/k select   Enter open   : commands
```

The operator confirmed Needs you as the landing page: decisions and blocked work first.
At 140 columns use a roughly 22-column rail; at 100 use an 18-column rail. At 80,
collapse navigation behind a named selector and give readers the full workspace.
The initial inline mockup exposes compact navigation, row spacing, focused/split
reading and dock expansion for comparison. These are design alternatives, not
new permanent settings the operator must maintain.

## Live baseline and content provenance

Read-only capture on September 19 using Node v20.19.4:

```sh
/Users/rewt/.nvm/versions/node/v20.19.4/bin/node \
  /Users/rewt/development/rewt/herdr-brain/console/app.mjs \
  --project bch-cloak --print 140x45
```

The capture displayed 13 waiting items, 81 alerts, loop down and Herdr unavailable.
Those are observations from this session's console read, not an independent
diagnosis of service health. The wireframe preserves unavailable/last-known
labels instead of inventing live activity. Question text is shortened from this
capture; goals and selected tasks come from read-only `org status --json`.
The umbrella goal is G-1; stage goals have no directly linked active tasks in the
capture. The wireframe does not invent task assignments or executive receipts.

The live task composer is visibly present with repository, route, goal and
Review launch controls. Its controller still calls launching a future-round
feature. Preserve the composer in the visual design without claiming that the
current product already implements its launch path.

## Integration into the existing application

The intended product entry point remains `org console --project NAME`. Evolve
`console/lib/theme.mjs` and `frame.mjs` for the shell and its regions; extend the
controller's navigation state while retaining its existing row actions and
session effect handling. Keep instruction writes, loop control, replies,
numbered choices, history overrules, source documents, pane jumps, project
selection, refresh and the composer accessible through the new shell.

Preserve current live shortcuts where their context applies, especially `s` for
summary, `g` for pane, `i` instruction, `L` loop, `h` history, `r` reply and `n`
decline/overrule. Sidebar navigation must work with keys as well as clicks;
do not consume answer keys for global navigation. Editors own typed text,
confirmation owns its action, and Back restores selection and scope.

Use the durable org read model for goal/task relationships. Priority, authority
and recorded executive decisions extend that model as specified in the goals
study. Reading navigation or a receipt must not run a model. Rank does not grant
authority, session metadata does not schedule work, and changing the visual shell
must not replace the current effects with simulated ones in production.

## First discussion deliverable

The interactive discussion wireframe is in the task-owned
`.lane/design-preview/modern-console.html`; its optional standalone rendering is
beside it. It demonstrates navigation, question reading, goals/tasks, instruction
review, task composition and the session dock. All changes stay inside its local
preview state. The production console is unchanged by this design pass.

Script syntax and local navigation/action transitions were checked. All 185 root
tests passed before and after the pass. Browser discovery returned no available browser, so a
rendered screenshot and DOM geometry could not be independently inspected.

## Connected project and execution view — first operator revision

The operator wants the modern visual shell to preserve the current console's
scope switching and Session / Who / Where / Up / State / Doing table. The updated
discussion wireframe is `.lane/design-preview/modern-console-connected.html`.
It uses captured metadata for eight agents in seven Herdr spaces across
`bch-cloak` and `herdr-brain`. This is a selected snapshot, not a complete live
fleet dashboard. Uptime was unavailable in this capture and remains unknown.

The recommendation is one interface with two explicit relationships:

- Project → goal → task → run: purpose, priority and durable work.
- Herdr space → tab → pane → agent: physical location and current activity.

An org project can span several Herdr spaces and worktrees. Scope selects the
project across all those spaces, using repository identity and configured org
association rather than matching a workspace label. Project names, workspace
names and checkout basenames are not interchangeable identities.

The project selector sits at the top of the sidebar. `p` opens it; All projects
provides the cross-project view. Changing project updates questions, goals,
tasks, spaces and the session table together. Each project remembers its open
reader and cursor. A count for needs elsewhere remains visible in a project
scope. In All projects, row identifiers and goal links are qualified by project:
the two projects' G-2 records must never collide.

Selecting a question, task or goal highlights linked sessions below, while
keeping other sessions in the scoped project visible. Selecting a session shows
clickable goal/task links and a run reference, plus its full space, tab, pane and worktree. The
Sessions destination expands the table; Spaces & tabs expands the existing Herdr
topology, including tabs that have no recognized agent. Space browsing is a view,
not a hidden change to the project scope.

Task state, run state and terminal state stay distinct. An idle agent can have an
open run. An unlinked session stays visible and says Unlinked. A title resembling
a task ID is not a verified association. In this capture the proving-key session
has an exact recorded run-agent match; this design session has its explicit
R-25/ARCH-4 brief. Other captured agents retain their names, titles and locations
without invented task assignments. Session metadata remains display-only.

`g` targets the selected existing pane; Enter inspects and a separate Peek action
opens terminal output. Product integration must revalidate the target before
focusing it and report a missing/moved target rather than silently choosing a
similarly named tab. Returning to the console restores scope and selection.
The discussion wireframe simulates these actions and never moves Herdr focus.

Validation for this revision: 185 root tests passed before and after. The inline
script parses, and local interaction checks passed for project scope, remembered
readers, project-qualified goal IDs, selected-row session links, exact location
inspection, answer isolation, unlinked sessions and the space/tab browser. A live
browser rendering was not verified in this session. The later operator simulation below supersedes that rendering limitation for the current preview.

### Warp precedent

Inspected Warp's published Factory Activity screenshot and its
[August 18 factory walkthrough](https://www.warp.dev/blog/open-infrastructure-for-building-a-software-factory).
Its sidebar keeps factory resources stable while the main area groups work by
Triage, Planning, Building and Reviewing, with attention flags and links to work
artifacts. Warp also documents opening a live run to view or interact with the
agent. Those are useful precedents for connecting overview and execution.

The Herdr recommendation is our design inference: retain the operator's existing
spaces and terminal sessions, connect them to goals/tasks, and use the session
table as the persistent bridge. The Warp screenshot does not establish that Warp
uses this proposed split table, scope behavior or Herdr-style topology.

## Native Herdr navigation — two alternatives

The next operator revision is about the primary interaction, not only visual
style: selecting a space or agent should immediately show its terminal output.
Git state, worktrees, native tabs and concurrent agents must stay easy to observe.
Goals and tasks belong in the central workspace rather than displacing agents
from the left rail. This supersedes the earlier Enter-to-inspect recommendation:
output is primary; session metadata lives behind a secondary Details action.

The current discussion wireframe is
`.lane/design-preview/modern-console-directions.html`. Its A/B controls compare:

- **A · Native spaces (recommended).** The left rail retains the project scope
  picker and native spaces, expanding the selected space's actual tabs. A space
  restores its last selected tab; on a first visit it uses Herdr's active tab,
  including a shell tab. A session click selects that exact tab and immediately
  opens output. The workspace header shows branch, clean/changed state, and
  divergence from main. Output, Worktrees, Needs you, Goals and Tasks are central
  views. A compact footer keeps concurrency and the original session table one
  action away. Goal/task links above the output open the corresponding reader
  and preserve the terminal selection.
- **B · Project + agent.** The left rail switches projects; Needs you, Worktrees,
  Goals and Tasks occupy the main area. Actual native tabs and the selected
  terminal remain below it, with Git context. Clicking another agent changes
  output without closing the planning reader. Expand output temporarily hides
  planning within the same layout, and Restore split restores it. This keeps
  purpose and execution visible together, but reduces room for each.

A is the stronger fit for Herdr's speed and familiar navigation. It gives the
operator a direct path to work already happening, with planning available in
the same workspace. B remains useful for comparing how much persistent planning
context matters during agent supervision. Neither alternative requires a second
set of spaces or a separate session registry.

The comparison starts in a selected session so the operator can immediately
judge terminal access. This is a demonstration state, not a change to the prior
cold-open decision: a fresh product console opens Needs you; returning to an
existing workspace restores its context. Needs you remains a first-class global
shortcut (`!`) as well as a central tab. `p` changes scope, Tab and arrow keys
move among native controls, Enter opens, Esc returns, and `g` targets the selected
existing Herdr terminal. Editing text owns the keyboard. Review/confirm controls
remain local simulations in this wireframe.

### Evidence and read-model boundaries

The comparison uses the same selected snapshot of eight agents in seven spaces
across two projects. A refreshed read-only Herdr capture supplied actual tab and
agent identities. Read-only Git commands supplied branch, HEAD, dirty-file count,
and ahead/behind relative to each repository's main branch. The Worktrees view
shows the captured Herdr spaces; it is not a complete census of every Git
worktree. These Git values are observational, not a promotion verdict.

Two terminal excerpts came from `herdr agent read --source recent-unwrapped`:
`wH7:p5` (the parked proving-key session) and `wH8:p5` (the created-side review).
They are labeled Captured output. Other sessions explicitly say no excerpt was
captured; a shell tab stays a shell tab. The wireframe never invents a stream,
replays commands, sends terminal input or changes Herdr focus. Its idle/working
markers are terminal observations, not org task status. The earlier verified
and unlinked task/run associations remain unchanged.

The product's terminal view must use the selected existing pane, preserve output
and input behavior, and revalidate identity before focusing or replying. It must
not spawn a duplicate session. Moving between planning and output must retain
scope, selected tab, planning cursor and terminal position. A missing pane should
stay visibly unavailable instead of targeting a similarly named session. The
mockup's single-pane examples do not replace native split-pane behavior.

### Validation and preview

All 185 root tests passed before and after this revision. The inline script
parses, and local interaction checks cover both layouts, immediate output
selection, Git topology, all six original session columns, project restoration,
project-qualified goal links, preserved planning while selecting agents,
expand/restore within B, shell tabs and answer isolation. Browser discovery
returned no connected browser; rendered geometry and mouse behavior were not
independently inspected.

The running local preview is regenerated from the latest fragment at
`http://127.0.0.1:8765/modern-console-preview.html`. Refresh it and use the A/B
buttons. The standalone file is `.lane/design-preview/modern-console-preview.html`.
This pass updates the design preview and this note; it does not replace the
production Ink console or alter the already-ingested R-25 report.

## Accepted direction: native spaces with checkout hierarchy

The operator chose A. The current source is now
`.lane/design-preview/modern-console-native.html`, served at the same running
preview URL. The main checkout is explicitly labeled for conversation and its
linked worktrees are nested below it using captured repository identity. Goals
and Tasks remain central views. Goals now supports local creation and relative
priority; `+ Chat` / `n` previews conversation or development sessions with an
explicit checkout. Back tracks view, project, space and tab, with side-button
handling where the host delivers it.

The architecture, Herdr plugin option, observed CLI/server capabilities, native
terminal boundary and implementation follow-through are recorded in
[the integration design](console-herdr-integration-2026-09-19.md). In particular,
a socket text read is not full terminal embedding. Preserve Herdr's process and
terminal ownership when realizing this layout.

## Project overview above the native checkout view

The next operator revision adds a project-level landing screen. Selecting a
project scope now opens Overview, including when revisiting a scope. This
supersedes both the initial Needs-you landing choice and the later output-first
comparison state. Back still restores the exact prior view. The selected
checkout/tab can be remembered without making it the scope's landing screen.

Current source: `.lane/design-preview/modern-console-overview.html`, exported to
the same running `modern-console-preview.html` URL.

The overview puts all captured sessions for the selected scope first. Each row
connects the agent/session to its verified goal and task, checkout, and terminal
state. Working sessions sort first. Click the session or unused row space to
open that exact session's output; click its goal or task link to open the reader.
An Unlinked session stays visible and is not assigned a goal by interpreting its
name. The existing six-column session table remains available from Full table.
The overview condenses that table to the relationships needed on arrival.

Below the sessions, a compact Goals section shows priority, outcome and linked
task count. The adjacent Tasks section groups tasks under their recorded goal,
including tasks with no session. Needs you sits directly below it and retains
its own dedicated tab and `!` shortcut. Terminal state and task status remain
separate; an idle terminal is not proof its task finished. Counts and mappings
refer to the selected captured sample, not a newly refreshed live organization.

The sidebar contains Project overview and the native checkout hierarchy. Linked
worktrees descend directly from Main checkout; there is no intervening Worktrees
heading. Tabs never expand in the rail. Selecting either main or a worktree
opens the checkout, with native tabs only across the main panel. Repository
identity still supplies the hierarchy, independently of workspace names.

Goals and Tasks retain dedicated screens and contextual actions. New goal and
Earlier/Later remain in Goals; New task belongs to Tasks. New chat is available
from the overview and checkout views. In the overview it defaults to conversation
at the primary checkout; in a worktree it defaults to development there. Nothing
in this pass changes the production dispatch implementation.

Density is intentional: roughly one text row per session or task, with space
between major sections. The cool blue rail and session header separate
navigation/activity; a quiet indigo surface groups goals; amber groups decisions;
teal identifies working agents. State labels remain visible alongside color.
At narrower widths the purpose sections stack and the checkout column moves to
the detailed view, while session, goal/task and state stay visible. Touch targets
remain larger than desktop rows.

Validation: all 185 root tests passed before and after this pass. Local script and interaction
checks cover overview landing, project switching, all scoped sessions, exact
session drill-down/Back, goal/task links, creation and ranking, chat locations,
answer isolation and horizontal-only tabs. Browser discovery again returned no
connected browser, so rendered geometry and hardware mouse behavior are not
verified.

## Operator simulation and CLI browser validation

The current preview has now been exercised in both real headless Chromium and
a visible Chrome for Testing window through Playwright. Each passed the same
20 operator missions. A separate reviewer used visible controls and screenshots
without reading the implementation, then independently retested the repairs.
This supersedes the earlier browser-rendering limitation for this version.

The simulation exposed and repaired seven interaction gaps: deferred decisions
had no recovery route, blank instructions had no feedback, reviews lacked a
way to edit the draft, repeated view clicks accumulated history, Back lost the
originating focus/scroll, mouse Back could skip a view, and native browser Back
could skip the screen under a dialog. Needs you now includes Open and Later;
review dialogs support Edit and Back with drafts retained. Dialogs participate
in history, while canceled/completed confirmation steps cannot reopen through
subsequent navigation.

The [operator simulation report](../reviews/console-operator-simulation-2026-09-19.md)
contains the mission results, evidence, visible-replay command, and remaining
integration checks. The [independent review](../reviews/console-operator-simulation-independent-2026-09-19.md)
records its own observations. Live Herdr behavior, durable writes, terminal
input, and human comprehension still require separate validation.
