# The console as a decision index

Design study, 18 September 2026 · ARCH-3 · R-19. This is an executable proposal for the operator to judge, not a product cutover.

## Field notes, before drawing

The useful precedent is a work index with a reader, not a dashboard full of telemetry. These observations were researched before the layouts below. The adoption/rejection judgments are this design's conclusions, not claims that the source tools are badly designed for their own users.

**K9s:** its resource commands, namespace selection, filtering and `?` mnemonics let an expert move directly to a known kind of object. Borrow project scope, a visible path, and an optional `:` screen chooser using plain names; keep all destinations clickable. Reject Kubernetes terminology, hidden scope changes in command syntax, and destructive control-key shortcuts: an operator should not need resource aliases to find an unanswered question. The breadcrumb here is a design adaptation of scoped resource navigation. [K9s commands](https://k9scli.io/topics/commands/)

**lazygit:** panels provide spatial memory, with keys interpreted in the active context; its documented list navigation, filtering and cancel behavior make a large operation set tractable. Borrow one explicit focus marker, context-sensitive footer keys, and detail without losing the list position. Reject assigning numbers to both tabs and decision choices, and importing its many Git-specific one-letter actions. Numbers in a decision reader must always mean the displayed answers. [lazygit keybindings](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md)

**htop and btop:** a stable process table under summary information allows fast scanning; htop supports mouse operation and btop advertises selectable panels and mouse support. Borrow fixed-width state columns, compact totals, independently scrollable regions and words alongside color. Reject CPU-style graphs, continuously moving urgency sorts and filling every spare cell: the scarce resource here is the operator's attention, not a machine metric. [htop](https://htop.dev/), [btop](https://github.com/aristocratos/btop)

**mutt and aerc:** Mutt explicitly separates line-based indexes from page-based readers; aerc offers account tabs, configurable index columns, per-context bindings and `?` help. Borrow the one-line subject, deliberate Enter into a reader, full text there, and exact return position. Reject assuming that opening means resolving or even acknowledging a result, and reject making an external pager a prerequisite for understanding a question. [Mutt core concepts](https://raw.githubusercontent.com/muttmua/mutt/master/doc/manual.xml.head), [aerc maintainer's FOSDEM presentation](https://aerc-mail.org/fosdem-2025/)

**Magit / Transient:** the transient menu makes a temporarily relevant command set visible near the moment of use. Borrow an Actions screen that shows names and shortcuts together, plus a concrete review step before sending, dropping or starting. Reject Emacs prefix sequences, modal chains without a visible exit, and a permanent action catalogue occupying the main screen. [Transient usage manual](https://magit.vc/manual/transient/Usage.html)

**Finder's Miller-column pattern, ranger and nnn:** ranger explicitly supplies multi-column navigation, previews and mouse support; nnn offers a compact file index, contexts and optional previews. Borrow the parent-to-child relationship and a path that survives when a narrow terminal hides an ancestor column. Reject the fiction that work is a strict filesystem tree: goals contain tasks, but a decision can block several tasks and a session can lack a recorded task. Finder is the familiar visual analogy; ranger is the documented terminal precedent, and nnn is the useful counterexample that keeps the index compact without insisting on three columns. [ranger features](https://github.com/ranger/ranger), [nnn](https://github.com/jarun/nnn)

**Ink in practice:** Gemini CLI is a documented Ink application with alternate-buffer rendering, sticky regions, scroll and mouse interactions. Its own rollback notice cites copying and scroll responsiveness problems: borrow deliberate mode cleanup and stable regions, not the assumption that a React renderer automatically makes a terminal interaction reliable. The strongest local precedent is this repository's existing pure frame + hit map + reducer architecture; retain it and test actual terminal input, including combined mouse reports. [Gemini UI settings](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/settings.md), [maintainer's alternate-buffer rollback](https://github.com/google-gemini/gemini-cli/discussions/13632), [Ink](https://github.com/vadimdemedes/ink)

The consequence is three distinct jobs: scan an index, browse relationships, and read/act on one thing. They share stable navigation, not a permanently expanded pile of summaries.

## Recommendation and the two iterations

Use a **scoped cascade with a global escape hatch**. Open items are the rightmost column, and they narrow with the chosen goal and task; the global needs-you count, the visible `!` button, and “showing X of Y” never narrow with them. Start with no goal or task selected and focus the first open item. The operator sees a decision immediately and can press Enter, or browse left to understand the goal it serves. Sessions keep a reserved region below, filtered only by project, so choosing a goal never makes its unrelated running neighbors disappear.

The first layout study divided the top into three equal columns. At 100 columns that left roughly ten useful characters for a waiting description after its id, project and tag; at 80 it made every row a code puzzle. The second study gives open items the largest share (74 columns at 140, 50 at 100) and uses a moving two-column window at 80: tasks + open items normally, goals + tasks when goals have focus. The ancestor path and the Goals / Tasks / Open items click targets remain visible in that smaller window. This is the intentional visual signature: work relationships occupy the top, living sessions occupy the bottom, with no expansion of a selected row between them.

The main risk is a locally empty open-items column looking like an empty organization. Counter it with an unfiltered, high-emphasis global needs-you button and the explicit “Showing 2 of 13 needing you; ! opens all” line. A filter may hide a row but cannot hide the fact that it exists or the route to it. If the operator still misses work in a short trial, choose alternative A below; this is the principal question for the next design round.

### Visual system

The palette is slate background `#101820`, paper text `#dce4e8`, secondary text `#98a9b4`, focus blue `#80c6df`, decision amber `#efbd76`, and selected-row slate `#293e4b`. The terminal owns the font: use its existing monospace face, with bold headings and key names for the display role, normal-weight prose for reading, and aligned cells for utility data. Do not impose another font or require private-use glyphs. Color reinforces meaning; `>` marks the focused region and active row, `*` retains a selection in another region, words identify states, and `…` means a clipped title whose full text is one Enter away.

Keep full id, project and tag cells before allocating description width; fixture projects use short names, while a product must provide unambiguous project aliases if configured names are too long. The ids are handles, not the prose: the main row leads with an id and a plain description; sessions retain plain names. No progress animation, bar chart, card border around every column, or silent selection jump is needed. The extra width buys readable titles and session columns; extra height buys visible rows, not a bigger text size. The prototype's one-line waiting rows are exactly one terminal line at every supported width.

## Information architecture

| Screen | Operator's question | Entry and exit |
|---|---|---|
| Overview | Which goal does this work serve, and what needs me here? | Launch; `:` → Overview; `b` restores its parent if entered from detail |
| Global inbox | What needs me anywhere, including results to read? | `!`, the needs-you button, or Screens; `b` restores scope, focus and filters |
| Saved for later | What did I deliberately defer? | The “later” count or Screens; open a row, `u` returns it to the inbox |
| Today | What finished or was decided? | Screens → Today; Enter reads a result or decision |
| Lanes and worktrees | Where is this work, and is its branch ready? | Lanes count or Screens; Enter reads branch, divergence, dirty and rebase information |
| Goal detail | What outcome, acceptance and direction define success? | Any goal's Enter or `G` from a related detail; `v` browses its work |
| Task detail | What must be done, what blocks it, and what runs served it? | Any task's Enter or related `T`; `v` browses related open items |
| Waiting/result detail | What happened, what is the choice, and what does it affect? | Enter or row disclosure; numbered choices, recommendation, why, relationships and drafts live here |
| Session detail | Who is working, where, on what, and what did they last say? | Enter on a session or related `S`; Enter again peeks, `g` goes to its pane |
| Peek | What is on the session's screen? | Enter in a waiting/session reader; `b` returns to that reader |
| Actions, project picker, screen chooser, find, help | What can I do or where can I go? | Visible key buttons or `m`, `p`, `:`, `/`, `?`; `b`/Cancel returns |
| Reply and action review | Exactly what would be sent, recorded or started, and where? | A detail action; review identifies the target and effect before confirmation |

**Scope** is a configured project, plus All projects. Project identity is the configured project + canonical org path, not an id prefix, display label, or working directory basename. A goal is an org item with `kind: goal`; do not invent another layer of stored goals.

**Task** is a non-human `kind: item`: engineering, review, research, architecture and other agent work, whether or not it has a run yet. Restricting it to items that already have runs would hide ready work. The task column flattens descendants of the selected goal (including depth-three subtasks); task detail shows the actual parent and children. Show an explicit “No goal” group for orphan tasks in the eventual read model; do not attach them to the selected goal by convenience. The fixture contains a nested task under each goal's first task so the traversal is exercised.

**Open item** is an operator-facing inbox entry, not another name for every unfinished org item. It is a human question, an actionable stopped-session queue entry, or an unacknowledged finished result tagged `read`. A blocked engineer task remains a task until it supplies an operator question. A done session remains a session; its unread result is an independent entry, since “done,” “read,” and “accepted” are different facts. Reading never closes a task or acknowledges a result automatically.

### Joins, identity, stages and counts

- Join queue `digest.item` to an item only inside its project/org. Resolve a run id through that org's runs; fall back to a session's named run where recorded. Follow `parent` upwards with a visited set. Never infer relationships from matching words in a title.
- Human questions can live directly under a goal, under a task, or block several tasks. Goal-wide questions stay under that goal; a task filter includes questions explicitly blocking that task, as well as entries directly attached to it. Detail must show all affected tasks. An unresolved queue relationship appears in an “Unlinked” entry in the global/project inbox with “No linked task,” not silently discarded. Shared questions are single entries in global counts.
- Queue identity is project + queue id; human question identity is org + item id; finished identity is org + item + sequence (or a recorded run id). Two queue entries about ENG-1 remain two rows. The visible fixture handles `Q-1`, `Q-2`, `HUM-1` demonstrate that distinction; the full source identity lives in the read model.
- Default tasks show all stages. `t` cycles all, 1, 2, 3, 4, keys, parked; the stage is always displayed. Stage selection narrows tasks only. Waiting items, including future-stage questions, never disappear just because the project has another stage open. A direct queue/blocked-session interruption takes precedence over a planning-stage label; detail explains the stage context.
- Global `needs you` counts actionable waiting entries across every configured project before scope, goal, task and search filters. `to read` counts unacknowledged finished entries separately. `later` counts explicitly deferred entries separately; saving for later is an action, not a filter. Global inbox contains waiting first and unread results after it. Filtered overview says both the local and global waiting counts even when local is zero.
- A real all-project count requires `today`/`status` for **all** configured organizations, plus the brain queue. The current console only has the selected org's human questions; its “other projects” queue summary cannot supply this guarantee. Poll/cache the orgs in the console read layer; do not change the core. If one read fails, say “at least N / project unavailable,” keep last-known rows and disable stale actions until refreshed rather than displaying zero.
- The product read model should retain stable row identity/order on refresh, show newly arrived attention in the global count, and avoid relocating the operator's cursor. Reuse `orderBoard` and `keepSelection`; no new priority sorter should move rows while the operator is selecting.
- Unread is currently **missing durable data**, not an existing org status. The prototype deliberately seeds three unread results and keeps acknowledgement in memory. A product needs an explicit console/brain read receipt keyed by source identity, outside `events.jsonl` unless a separately designed event is warranted. Opening a detail is not that receipt. No new stored task status is proposed.

The fixture is six goals, sixty non-human tasks, three human questions, ten waiting brain rows, three unread results, eight sessions and five lanes. Harbor owns five goals, fifty tasks, ten waiting entries and six sessions; Orchard owns the remaining goal, ten tasks, three waiting entries and two sessions. `--scope all` shows all six goals. Text and paths are invented; no real bch-cloak descriptions are in the fixture.

### Sessions remain recognizable

Keep repository groups, human-readable session names, WHO (tool/model), WHERE, UP, STATE and DOING. Add SERVES as the task id; session detail supplies its full title, goal, run, effort, brief and pane. At 140 columns show all columns; at 100 omit WHERE (available in detail); at 80 use the current two-line session pattern, with task/age/doing on the continuation. Project scope filters sessions; goal, task, stage and inbox search do not. Preserve every listed agent, even without an org run; keep the existing gone/unknown distinction and the existing short grace window for a vanished run. The fixture has a fixed population and no live refresh; it exercises repository grouping and compact continuation rows, not disappearance timing.

## Navigation and interaction contract

The screen stack records the parent view, scope, chosen goal/task, text filter, row identity, focus and scroll position. Enter always opens a detail for a real row; `>` at the row's right edge is the click equivalent. A click on the row body selects it; another body click still only selects, so there is no double-click timing trap. Moving or clicking a goal immediately narrows tasks and clears the previous task; choosing a task immediately narrows open items. “All goals” and “All tasks” are real selectable reset rows. Enter on those reset rows simply leaves the list in place.

`b` is the primary Back key, backed by a persistent `[b Back]` click target. Esc is an optional alias, never a required gesture. At the overview root, Back clears browsing filters but does not quit; `q` is the explicit close/quit action. In a reader `q` also backs out. Unlike today's popup behavior, this proposal does not make Esc at root close the console; avoiding the agent-interrupt reflex is more valuable than preserving that shortcut. A product's `g` focuses the named live pane, closing a console popup after success; use Herdr's configured last-pane/summon command to return, not an Esc sent to the agent. The prototype only shows a receipt for `g`.

There is one focused region at a time. Tab/Shift-Tab and Left/Right cycle goals → tasks → open items → sessions at 100/140. At 80 the same logical cycle shifts the two-column window so the focused column is visible. Readers cycle body ↔ sessions. Detail actions are context commands regardless of whether their text is scrolled into view, but while sessions have focus Enter opens the selected session, not the reader behind it. Actions/scope/review/editor screens temporarily own input; the session pane remains visible and cannot be accidentally activated beneath them.

Reply/search/screen-name fields own printable characters, including `b`, `q`, numbers and punctuation. Tab cycles field → Review/Apply → Cancel, Shift-Tab reverses, and Enter activates the focused button (or reviews from the field). Thus a keyboard-only user can cancel without Esc and without losing typed text to a global shortcut. Reply drafts persist in memory while browsing back and forth. A full product should retain drafts across restart; that durability is not implemented here.

A numbered answer or `y` opens a concrete review screen; Enter confirms. `y` always means the recommendation, even when an operator or agent draft exists: this intentionally removes today's draft-first ambiguity. `r` opens the existing unsent draft, else the agent suggestion, else an empty field, and the reader clearly distinguishes who wrote it. Only the reply review sends draft text. `l` defers immediately with a receipt and a route back; `x` reviews removal of the inbox entry, never “kill agent” or “drop task.” `d` reviews starting a question-research session; it is not the removed task composer. Disabled actions should say why in product detail (missing pane, absent recommendation, stale source), not pretend to succeed.

### Complete keyboard map for this prototype

| Context | Keys | Meaning / mouse equivalent |
|---|---|---|
| Browsing and readers | `b`, Esc; `q` when stacked | Back / `[b Back]`; at root `q` quits / `[q Quit]` |
| Browsing and readers | `!` | Push global inbox with filters cleared / needs-you button |
| Browsing and readers | `p` | Project picker / project button; Up/Down or j/k, Enter select |
| Browsing and readers | `:` | Screen chooser / Screens button; type a plain name, arrows choose, Enter applies; an empty name lists all screens |
| Browsing and readers | `?` | Scrollable help / Help button; `b` returns |
| Browsing and readers | `R` | Refresh in product; prototype reports that fixtures are fixed |
| Overview | Tab, Shift-Tab, Left, Right | Cycle focused columns and sessions / click column header or bottom named focus target |
| Other browse screens | Tab, Shift-Tab, Left, Right | Cycle list ↔ sessions / click either header |
| Reader/peek/help | Tab, Shift-Tab, Left, Right | Cycle body ↔ sessions / click body region or sessions header |
| All lists | Up/Down, j/k | Select previous/next row / click a row or wheel over that list |
| All lists/readers | PageUp/PageDown, Home/End | Move eight rows or first/last; readers scroll lines / wheel reaches the same content |
| Real list row | Enter | Detail / trailing `>` disclosure |
| Overview goals/tasks | Space | Clear the focused goal/task choice / select All goals or All tasks |
| Browse screens | `0` | Clear goal, task, search and task-stage filters / Clear filters button |
| Browse screens | `/` | Find in focused list by id, description and project; Enter applies / Find button; `0` clears |
| Browse screens | `t` | Cycle task stages all → 1 → 2 → 3 → 4 → keys → parked / Stage button |
| Browse screens/readers | `s` | Focus sessions / Sessions header or button |
| Waiting detail | `1`–`9` | Review that displayed option; absent numbers do nothing / click the option; no numbered tabs |
| Waiting detail | `y` | Review recommended option / Recommended button |
| Waiting/session detail | `r` | Edit reply, preserving an unsent draft / Reply button |
| Waiting detail | `l`, `x`, `d` | Save later, review drop, review starting a session / named buttons |
| Deferred waiting detail | `u` | Return to inbox / Return to inbox button |
| Unread-result detail | `a` | Review explicit mark-read / Mark read button |
| Goal/task detail | `v` | Browse related work / Browse button |
| Any applicable detail | `G`, `T`, `S` | Open linked goal, task, session / labeled relationship rows (also in Actions) |
| Waiting/session detail | Enter, `g` | Peek screen, go to pane / Peek and Go buttons; only when a fixture session exists |
| Detail/peek | `m` | Actions index / Actions button; Up/Down or j/k, Enter choose; direct displayed shortcuts also work |
| Reply/search/screen chooser | Printable text, Backspace/Delete | Append / remove last character; editors are deliberately simple; click field to focus |
| Reply/search/screen chooser | Tab, Shift-Tab, Enter | Field → Review/Apply → Cancel; Enter activates / click those buttons; `b` cancels when a button has focus |
| Reply/search/screen chooser | Esc | Cancel; optional alias for Tab → Cancel → Enter |
| Review screen | Enter; `b` or Esc | Confirm demo action; cancel / explicit Confirm and Cancel targets |
| App | Ctrl-C | Terminal emergency exit, with mouse/alternate-screen cleanup |

No Ctrl/Alt chord is assigned by the design; the application ignores modified key input except the conventional Ctrl-C exit. In this checkout the advertised `console/README.md` is absent: the relevant notes are in root `README.md`, “Getting in and out of sessions” (around lines 402–429). They reserve `prefix+backtick` and the optional Ctrl+Alt+B for last pane, plus Ctrl+Alt+C for summoning the popup; the existing frame help names Ctrl+B as the prefix. None is rebound, and this study makes no Herdr configuration changes. Custom host bindings beyond those documented remain a deployment-time check.

### Mouse map and what exists today

| Target / gesture | Behavior |
|---|---|
| Row body | Select, with cascade update for a goal/task; never send or switch panes |
| Trailing `>` | Select and open detail in one click |
| Column/header or named focus button | Focus that region; at 80 bring its column into the window |
| Needs-you/read/later/lanes count | Open the corresponding index; global inbox returns to the prior scope with Back |
| Project / Screens / Help / Back / Quit | Same destination/action as the displayed key |
| Numbered option, recommendation, reply/later/drop/start/read action | Same action as its key; review where specified |
| Relationship row | Open that goal, task or session; Back returns to the original reader |
| Review and Cancel | Confirm or return, without requiring a keyboard |
| Wheel over list | Move selection one row per report in that list, keeping the active row visible; does not scroll another pane |
| Wheel over reader/help/actions | Scroll text or menu entries in that region; session region is inert during modal decisions |
| Click editor / Review / Cancel | Focus the field / review or apply / cancel; no click is interpreted as reply text |
| Right click / middle / drag | No application action in prototype; Herdr/native behavior remains available; every application action has a left-click route |

Today's `console/lib/mouse.mjs` enables 1000 + SGR 1006 reporting and parses a **single** complete report (optional leading ESC), returning zero-based coordinates, press/release, left/middle/right, wheel and motion. It does not own hit testing: `frame.mjs` produces hit ranges and `controller.mjs` chooses the effect. Today's controller opens on left-click, opens a menu on right-click, and scrolls the shared list or popup. The current app optionally asks Herdr to route right clicks into the pane; it restores ownership and terminal modes on exit.

The design needs separate selection/disclosure targets, focusable headers, clickable footers/Back/confirm controls, region-aware wheel behavior, and deterministic input ownership. The prototype implements those under `console/proto/`; it also buffers fragmented/coalesced SGR packets and bracketed pastes before dispatching keys. It intentionally does not request Herdr's right-click ownership. No hover or drag tracking is required. `--no-mouse` permits native selection; there is no design reliance on terminal-specific right-click or double-click behavior.

## Architecture that can become the existing console

| Existing seam | Product change represented by prototype |
|---|---|
| `app.mjs` / terminal ownership | Keep Ink host, alternate screen, resize and cleanup; route decoded input once |
| `model.mjs` / `buildBoard` | Add `status` items, ancestor traversal, project-qualified open-item identities and all-project counts; retain session-name/WHO logic and stable ordering |
| `visibleBoard` / `scopeItems` | Separate project scope from goal/task/stage browsing and global inbox; apply filters after global counts |
| `controller.mjs` | Add screen stack and per-region cursor/focus; Enter → detail; plain Back, distinct click-to-select and disclosure; retain effect dispatch boundary |
| `frame.mjs` | Three-column/two-column layout, reserved sessions area, detail reader, complete hit map; remove `launchLines` from product layout |
| `session.mjs` | Coordinate read-only polling and perform authorized actions through existing org/brain CLI argument arrays; do not let frame/reducer write |
| `mouse.mjs` | Preserve SGR support, buffer stream boundaries in the host, route wheel by hit region; right-click capture optional |

The prototype's source files mirror those seams without changing any of them. `fixtures.mjs` creates source-shaped JSON; `model.mjs` derives relationships; `controller.mjs` returns new in-memory UI state; `frame.mjs` returns spans and hit rectangles; `main.mjs` renders those spans in Ink. It shares only the existing pure text helpers. No new dependency, core model call, event type, stored task status, daemon or background service is introduced.

The minimum product follow-up is a reviewed implementation of these seams after the operator chooses the layout, plus explicit read-receipt/draft persistence semantics. Do not implement model calls for better headlines here; use digest gist, then recorded summary/title, with honest missing-data text. The current prototype starts sessions and goes to panes only as labeled simulations; its confirmation receipt is not evidence that a real command succeeded.

## Two alternatives at 100 columns

These are rejected layout studies, not additional implemented modes. Their text mockups use the same synthetic content; the executable recommendation follows in the generated section.

### A. Never filter the needs-you list

```text
 herdr-brain / harbor        [! Needs you 13 / all projects]                     [b Back] [? Help]
 > WAITING ON YOU / always global / 1-5 of 13
 > Q-1     Choose a retry policy                                   harbor     reply              >
   Q-2     Keep the existing file format                           harbor     decision           >
   Q-3     Accept the message review                               harbor     decision           >
   Q-9     Resolve the export question                             orchard    decision           >
   HUM-3   Choose a note export format                             orchard    decision           >
 ---------------------------------------------------------------------------------------------------
   GOALS                         TASKS / G-1                      RELATED RESULTS / ENG-1
 * G-1 Reliable imports        * ENG-1 Validate imports           No unread result yet
   G-2 Clear account recovery    ENG-2 Retry interrupted batches
   G-3 Fast search               REV-3 Review error messages
 ---------------------------------------------------------------------------------------------------
   SESSIONS / harbor
   SESSION                 WHO                 UP     STATE       SERVES   DOING
   import-recovery         Codex Astra         32m    blocked     ENG-1    Waiting for a retry polic
   batch-retry             Claude Opus         18m    working     ENG-2    Testing interrupted batch
 ---------------------------------------------------------------------------------------------------
 [Tab focus] [Enter detail] [b Back] [p Project] [: Screens] [? Help]
```

It wins when cross-project interruption triage dominates: browsing a goal cannot hide any waiting row, and a newcomer can read the actual global questions immediately. It loses vertical room to a fourth navigation region and shows questions detached from the goal/task being explored; at 80 columns the cascade and sessions would each show fewer rows.

### B. Goal tree with a decision index

```text
 herdr-brain / harbor        [! Needs you 13 / all projects]                     [b Back] [? Help]
   GOALS AND TASKS                                           > OPEN ITEMS / ENG-1
 - G-1 Reliable imports                                     > Q-1 Choose a retry policy harbor reply
   * ENG-1 Validate imports                                  Q-2 Keep the file format  harbor decisi
     ENG-2 Retry interrupted batches
     REV-3 Review error messages
 + G-2 Clear account recovery
 + G-3 Fast search
 + G-4 Calm releases
 + G-5 Useful audit trail
 ---------------------------------------------------------------------------------------------------
   SESSIONS / harbor
   SESSION                 WHO                 UP     STATE       SERVES   DOING
   import-recovery         Codex Astra         32m    blocked     ENG-1    Waiting for a retry polic
   batch-retry             Claude Opus         18m    working     ENG-2    Testing interrupted batch
 ---------------------------------------------------------------------------------------------------
 [Tab focus] [Space expand] [Enter detail] [b Back] [! All needs you] [? Help]
```

It wins for deep parentage and low width: a single tree uses fewer columns and directly shows nested tasks. It loses the stable goal/task columns the operator requested and adds expansion state that can bury a goal underneath dozens of tasks.

Both studies lead back to the recommendation: use the asymmetric cascade first, preserve the global route visibly, and test whether “showing X of Y” is sufficient reassurance. A needs-first operator can enter `!` and stay in the global inbox without changing the recommended overview.

## Review walkthrough

1. Launch at 100×40: identify the first question and its project within three seconds, then Enter. No paragraph should be required to find it.
2. Back, focus Goals, select G-1: tasks narrow from fifty to ten; open items narrow from twelve to five; global needs remains thirteen. Select ENG-1: two open items remain; all six Harbor sessions remain.
3. Press `!`: all thirteen questions plus three unread results appear across Harbor and Orchard; Back restores G-1 / ENG-1. Switch projects in `p`: global attention remains thirteen.
4. At 80×30, repeat with the two-column window; open a waiting item and find its recommendation, why, unsent draft and relationship before scrolling.
5. Click a row and then its disclosure, choose a numbered option, cancel using `[b Back]`, then edit a draft and cancel with Tab → Cancel → Enter. No terminal command should have been sent.
6. Read a session; Enter peeks at a clearly marked fixture capture; Back restores the reader and then the original row. Try the wheel over each region and quit with `q` at root.

The prototype validates layout and local interaction. It cannot validate the operator's three-second comprehension, real Herdr popup click forwarding, production refresh races, actual CLI dispatch or durable unread receipts; those need the next operator/reviewer trial. No cutover is requested.

<!-- GENERATED MOCKUPS: node console/proto/render-mockups.mjs -->

## Exact prototype renders

These are generated text frames, not hand-aligned approximations. Blank lines and clipped titles are intentional. Each source snapshot has exactly the requested number of rows; trailing spaces are omitted in Markdown. Interactive Ink uses the same frame and reserves one physical terminal line, as the current app does.

### Overview: no goal or task picked

**80×30** — `node console/proto/main.mjs --print 80x30`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > All goals > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────
  Tasks 50                │> Open items 12
* All tasks              >│> Q-1     Choose a retry policy   harbor   reply    >
  ENG-1  Validate imp… * >│  Q-2     Keep the existing file… harbor   decision >
  ENG-2  Retry interr… . >│  Q-3     Accept the message rev… harbor   decision >
  REV-3  Review error… ! >│  Q-4     Pick a recovery timeout harbor   decision >
  RES-4  Measure slow… . >│  Q-5     Review the search samp… harbor   decision >
  ENG-5  Explain reco… * >│  Q-6     Schedule the release c… harbor   decision >
  ENG-6  Check saved… .  >│  Q-7     Approve the audit word… harbor   decision >
  ENG-7  Test keyboar… ! >│  Q-8     Choose a fallback path  harbor   decision >
  REV-8  Simplify pro… . >│  HUM-1   Choose the recovery wo… harbor   decision >
  RES-9  Document fal… * >│  HUM-2   Set the review window   harbor   decision >
 1-10 / 51                │ 1-10 / 12
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  batch-retry                   Claude Opus        working                     >
    ENG-2 / 18m / Testing interrupted batches                                  >
  import-review                 Codex Astra        done                        >
    REV-3 / 45m / Finished the error review                                    >
  Sessions 1-7 / 13 lines; scroll here for more
 Showing 10 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > All goals > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5            │  Tasks 50                 │> Open items 12
* All goals         >│* All tasks               >│> Q-1     Choose a retry poli… harbor   reply    >
  G-1 Reliable imp… >│  ENG-1  Validate impo… * >│  Q-2     Keep the existing f… harbor   decision >
  G-2 Clear accoun… >│  ENG-2  Retry interru… . >│  Q-3     Accept the message…  harbor   decision >
  G-3 Fast search   >│  REV-3  Review error… !  >│  Q-4     Pick a recovery tim… harbor   decision >
  G-4 Calm releases >│  RES-4  Measure slow… .  >│  Q-5     Review the search s… harbor   decision >
  G-5 Useful audit… >│  ENG-5  Explain recov… * >│  Q-6     Schedule the releas… harbor   decision >
                     │  ENG-6  Check saved f… . >│  Q-7     Approve the audit w… harbor   decision >
                     │  ENG-7  Test keyboard… ! >│  Q-8     Choose a fallback p… harbor   decision >
                     │  REV-8  Simplify prog… . >│  HUM-1   Choose the recovery… harbor   decision >
                     │  RES-9  Document fall… * >│  HUM-2   Set the review wind… harbor   decision >
                     │  ENG-10 Verify releas… . >│  REV-3   Error review is rea… harbor   read     >
                     │  ENG-11 Validate impo… * >│  ENG-31  Release rehearsal f… harbor   read     >
                     │  ENG-12 Retry interru… . >│
                     │  REV-13 Review error… !  >│
                     │  RES-14 Measure slow… .  >│
                     │  ENG-15 Explain recov… * >│
                     │  ENG-16 Check saved f… . >│
 1-6 / 6             │ 1-17 / 51                 │ 1-12 / 12
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  search-timing         Codex Astra        12m   idle     ENG-21  Ready for the next sample        >
  release-checks        Claude Opus        9m    working  ENG-31  Checking the release steps       >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 10 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > All goals > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5                   │  Tasks 50                          │> Open items 12
* All goals                >│* All tasks                        >│> Q-1     Choose a retry policy                        harbor   reply    >
  G-1 Reliable imports     >│  ENG-1  Validate imports *        >│  Q-2     Keep the existing file format                harbor   decision >
  G-2 Clear account recov… >│  ENG-2  Retry interrupted batc… . >│  Q-3     Accept the message review                    harbor   decision >
  G-3 Fast search          >│  REV-3  Review error messages !   >│  Q-4     Pick a recovery timeout                      harbor   decision >
  G-4 Calm releases        >│  RES-4  Measure slow requests .   >│  Q-5     Review the search sample                     harbor   decision >
  G-5 Useful audit trail   >│  ENG-5  Explain recovery steps *  >│  Q-6     Schedule the release check                   harbor   decision >
                            │  ENG-6  Check saved filters .     >│  Q-7     Approve the audit wording                    harbor   decision >
                            │  ENG-7  Test keyboard paths !     >│  Q-8     Choose a fallback path                       harbor   decision >
                            │  REV-8  Simplify progress repo… . >│  HUM-1   Choose the recovery wording                  harbor   decision >
                            │  RES-9  Document fallback steps * >│  HUM-2   Set the review window                        harbor   decision >
                            │  ENG-10 Verify release checkli… . >│  REV-3   Error review is ready                        harbor   read     >
                            │  ENG-11 Validate imports for a… * >│  ENG-31  Release rehearsal finished                   harbor   read     >
                            │  ENG-12 Retry interrupted batc… . >│
                            │  REV-13 Review error messages… !  >│
                            │  RES-14 Measure slow requests… .  >│
                            │  ENG-15 Explain recovery steps… * >│
                            │  ENG-16 Check saved filters fo… . >│
                            │  ENG-17 Test keyboard paths fo… ! >│
                            │  REV-18 Simplify progress repo… . >│
                            │  RES-19 Document fallback step… * >│
                            │  ENG-20 Verify release checkli… . >│
                            │  ENG-21 Validate imports for s… * >│
 1-6 / 6                    │ 1-22 / 51                          │ 1-12 / 12
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  search-timing            Codex Astra          lane-5          12m   idle     ENG-21  Ready for the next sample                           >
  release-checks           Claude Opus          lane-1          9m    working  ENG-31  Checking the release steps                          >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 10 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Overview: G-1 picked; tasks and open items narrow

**80×30** — `node console/proto/main.mjs --print 80x30 --goal G-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────
  Tasks 10                │> Open items 5
* All tasks              >│> Q-1     Choose a retry policy   harbor   reply    >
  ENG-1  Validate imp… * >│  Q-2     Keep the existing file… harbor   decision >
  ENG-2  Retry interr… . >│  Q-3     Accept the message rev… harbor   decision >
  REV-3  Review error… ! >│  HUM-1   Choose the recovery wo… harbor   decision >
  RES-4  Measure slow… . >│  REV-3   Error review is ready   harbor   read     >
  ENG-5  Explain reco… * >│
  ENG-6  Check saved… .  >│
  ENG-7  Test keyboar… ! >│
  REV-8  Simplify pro… . >│
  RES-9  Document fal… * >│
 1-10 / 11                │ 1-5 / 5
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  batch-retry                   Claude Opus        working                     >
    ENG-2 / 18m / Testing interrupted batches                                  >
  import-review                 Codex Astra        done                        >
    REV-3 / 45m / Finished the error review                                    >
  Sessions 1-7 / 13 lines; scroll here for more
 Showing 4 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --goal G-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5            │  Tasks 10                 │> Open items 5
  All goals         >│* All tasks               >│> Q-1     Choose a retry poli… harbor   reply    >
* G-1 Reliable imp… >│  ENG-1  Validate impo… * >│  Q-2     Keep the existing f… harbor   decision >
  G-2 Clear accoun… >│  ENG-2  Retry interru… . >│  Q-3     Accept the message…  harbor   decision >
  G-3 Fast search   >│  REV-3  Review error… !  >│  HUM-1   Choose the recovery… harbor   decision >
  G-4 Calm releases >│  RES-4  Measure slow… .  >│  REV-3   Error review is rea… harbor   read     >
  G-5 Useful audit… >│  ENG-5  Explain recov… * >│
                     │  ENG-6  Check saved f… . >│
                     │  ENG-7  Test keyboard… ! >│
                     │  REV-8  Simplify prog… . >│
                     │  RES-9  Document fall… * >│
                     │  ENG-10 Verify releas… . >│
                     │                           │
                     │                           │
                     │                           │
                     │                           │
                     │                           │
                     │                           │
 1-6 / 6             │ 1-11 / 11                 │ 1-5 / 5
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  search-timing         Codex Astra        12m   idle     ENG-21  Ready for the next sample        >
  release-checks        Claude Opus        9m    working  ENG-31  Checking the release steps       >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 4 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --goal G-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > All tasks > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5                   │  Tasks 10                          │> Open items 5
  All goals                >│* All tasks                        >│> Q-1     Choose a retry policy                        harbor   reply    >
* G-1 Reliable imports     >│  ENG-1  Validate imports *        >│  Q-2     Keep the existing file format                harbor   decision >
  G-2 Clear account recov… >│  ENG-2  Retry interrupted batc… . >│  Q-3     Accept the message review                    harbor   decision >
  G-3 Fast search          >│  REV-3  Review error messages !   >│  HUM-1   Choose the recovery wording                  harbor   decision >
  G-4 Calm releases        >│  RES-4  Measure slow requests .   >│  REV-3   Error review is ready                        harbor   read     >
  G-5 Useful audit trail   >│  ENG-5  Explain recovery steps *  >│
                            │  ENG-6  Check saved filters .     >│
                            │  ENG-7  Test keyboard paths !     >│
                            │  REV-8  Simplify progress repo… . >│
                            │  RES-9  Document fallback steps * >│
                            │  ENG-10 Verify release checkli… . >│
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
 1-6 / 6                    │ 1-11 / 11                          │ 1-5 / 5
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  search-timing            Codex Astra          lane-5          12m   idle     ENG-21  Ready for the next sample                           >
  release-checks           Claude Opus          lane-1          9m    working  ENG-31  Checking the release steps                          >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 4 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Overview: G-1 and ENG-1 picked; two related questions

**80×30** — `node console/proto/main.mjs --print 80x30 --goal G-1 --task ENG-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > ENG-1 > Open items
────────────────────────────────────────────────────────────────────────────────
  Tasks 10                │> Open items 2
  All tasks              >│> Q-1     Choose a retry policy   harbor   reply    >
* ENG-1  Validate imp… * >│  Q-2     Keep the existing file… harbor   decision >
  ENG-2  Retry interr… . >│
  REV-3  Review error… ! >│
  RES-4  Measure slow… . >│
  ENG-5  Explain reco… * >│
  ENG-6  Check saved… .  >│
  ENG-7  Test keyboar… ! >│
  REV-8  Simplify pro… . >│
  RES-9  Document fal… * >│
 1-10 / 11                │ 1-2 / 2
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  batch-retry                   Claude Opus        working                     >
    ENG-2 / 18m / Testing interrupted batches                                  >
  import-review                 Codex Astra        done                        >
    REV-3 / 45m / Finished the error review                                    >
  Sessions 1-7 / 13 lines; scroll here for more
 Showing 2 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --goal G-1 --task ENG-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > ENG-1 > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5            │  Tasks 10                 │> Open items 2
  All goals         >│  All tasks               >│> Q-1     Choose a retry poli… harbor   reply    >
* G-1 Reliable imp… >│* ENG-1  Validate impo… * >│  Q-2     Keep the existing f… harbor   decision >
  G-2 Clear accoun… >│  ENG-2  Retry interru… . >│
  G-3 Fast search   >│  REV-3  Review error… !  >│
  G-4 Calm releases >│  RES-4  Measure slow… .  >│
  G-5 Useful audit… >│  ENG-5  Explain recov… * >│
                     │  ENG-6  Check saved f… . >│
                     │  ENG-7  Test keyboard… ! >│
                     │  REV-8  Simplify prog… . >│
                     │  RES-9  Document fall… * >│
                     │  ENG-10 Verify releas… . >│
                     │                           │
                     │                           │
                     │                           │
                     │                           │
                     │                           │
                     │                           │
 1-6 / 6             │ 1-11 / 11                 │ 1-2 / 2
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  search-timing         Codex Astra        12m   idle     ENG-21  Ready for the next sample        >
  release-checks        Claude Opus        9m    working  ENG-31  Checking the release steps       >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 2 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --goal G-1 --task ENG-1`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 harbor > G-1 > ENG-1 > Open items
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Goals 5                   │  Tasks 10                          │> Open items 2
  All goals                >│  All tasks                        >│> Q-1     Choose a retry policy                        harbor   reply    >
* G-1 Reliable imports     >│* ENG-1  Validate imports *        >│  Q-2     Keep the existing file format                harbor   decision >
  G-2 Clear account recov… >│  ENG-2  Retry interrupted batc… . >│
  G-3 Fast search          >│  REV-3  Review error messages !   >│
  G-4 Calm releases        >│  RES-4  Measure slow requests .   >│
  G-5 Useful audit trail   >│  ENG-5  Explain recovery steps *  >│
                            │  ENG-6  Check saved filters .     >│
                            │  ENG-7  Test keyboard paths !     >│
                            │  REV-8  Simplify progress repo… . >│
                            │  RES-9  Document fallback steps * >│
                            │  ENG-10 Verify release checkli… . >│
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
                            │                                    │
 1-6 / 6                    │ 1-11 / 11                          │ 1-2 / 2
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  search-timing            Codex Astra          lane-5          12m   idle     ENG-21  Ready for the next sample                           >
  release-checks           Claude Opus          lane-1          9m    working  ENG-31  Checking the release steps                          >



  Sessions 1-7 / 7 lines; scroll here for more
 Showing 2 of 13 needing you; ! opens all. Task stages: all.
 [Tab focus] [j/k select] [Enter detail] [/ Find] [t Stage]
 [Goals] [Tasks] [Open items] [0 Clear filters] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Waiting detail

**80×30** — `node console/proto/main.mjs --print 80x30 --screen waiting`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────
  > Q-1 Choose a retry policy
  Summary
  An interrupted import leaves completed rows safe. Choose how the next
  attempt handles the unfinished rows.
  Choices
  [1] Retry only failed rows <- recommended
  [2] Retry the full batch
  [3] Ask for more evidence
  Why: Completed rows stay untouched; the retry is smaller and easier to
  inspect.
  Related: G-1 > ENG-1 > R-1 > harbor
  Your draft / never sent
  Retry only the failed rows; keep the completed rows.
  Next: The session continues after your answer.
  1-9 picks a choice; y always reviews the recommended choice.
  1-15 / 18  j/k or wheel for more
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  Sessions 1-3 / 13 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [y Recommended] [r Reply] [l Later] [x Drop] [d Start session]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen waiting`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────
  > Q-1 Choose a retry policy
  Summary
  An interrupted import leaves completed rows safe. Choose how the next attempt handles the
  unfinished rows.
  Choices
  [1] Retry only failed rows <- recommended
  [2] Retry the full batch
  [3] Ask for more evidence
  Why: Completed rows stay untouched; the retry is smaller and easier to inspect.
  Related: G-1 > ENG-1 > R-1 > harbor
  Your draft / never sent
  Retry only the failed rows; keep the completed rows.
  Next: The session continues after your answer.
  1-9 picks a choice; y always reviews the recommended choice.
  [G] Related goal: Reliable imports
  [T] Related task: Validate imports
  [S] Related session: import-recovery






  1-17 / 17
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [y Recommended] [r Reply] [l Later] [x Drop] [d Start session]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen waiting`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  > Q-1 Choose a retry policy
  Summary
  An interrupted import leaves completed rows safe. Choose how the next attempt handles the unfinished rows.
  Choices
  [1] Retry only failed rows <- recommended
  [2] Retry the full batch
  [3] Ask for more evidence
  Why: Completed rows stay untouched; the retry is smaller and easier to inspect.
  Related: G-1 > ENG-1 > R-1 > harbor
  Your draft / never sent
  Retry only the failed rows; keep the completed rows.
  Next: The session continues after your answer.
  1-9 picks a choice; y always reviews the recommended choice.
  [G] Related goal: Reliable imports
  [T] Related task: Validate imports
  [S] Related session: import-recovery












  1-16 / 16
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [y Recommended] [r Reply] [l Later] [x Drop] [d Start session]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Goal detail

**80×30** — `node console/proto/main.mjs --print 80x30 --screen goal`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────
  > G-1 Reliable imports
  Outcome
  Reliable imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - The user can complete the work without guessing what happened.
  Budget: 120000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-1, ENG-2, REV-3, RES-4, ENG-5, ENG-6, ENG-7, REV-8, RES-9,
  HUM-1
  Runs: none yet
  Latest direction
  Keep the existing format readable while improving recovery.
  v browses related work without starting anything.
  1-15 / 15
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  Sessions 1-3 / 13 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen goal`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────
  > G-1 Reliable imports
  Outcome
  Reliable imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - The user can complete the work without guessing what happened.
  Budget: 120000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-1, ENG-2, REV-3, RES-4, ENG-5, ENG-6, ENG-7, REV-8, RES-9, HUM-1
  Runs: none yet
  Latest direction
  Keep the existing format readable while improving recovery.
  v browses related work without starting anything.









  1-14 / 14
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen goal`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  > G-1 Reliable imports
  Outcome
  Reliable imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - The user can complete the work without guessing what happened.
  Budget: 120000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-1, ENG-2, REV-3, RES-4, ENG-5, ENG-6, ENG-7, REV-8, RES-9, HUM-1
  Runs: none yet
  Latest direction
  Keep the existing format readable while improving recovery.
  v browses related work without starting anything.














  1-14 / 14
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Task detail

**80×30** — `node console/proto/main.mjs --print 80x30 --screen task`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────
  > ENG-1 Validate imports
  Work
  Validate imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - Existing saved work stays readable.
  - The failure case has a reproducible check.
  Budget: 24000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-10
  Runs: R-1
  Latest direction
  Prefer a small change with clear evidence.
  v browses related work without starting anything.
  1-15 / 17  j/k or wheel for more
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  Sessions 1-3 / 13 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen task`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────
  > ENG-1 Validate imports
  Work
  Validate imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - Existing saved work stays readable.
  - The failure case has a reproducible check.
  Budget: 24000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-10
  Runs: R-1
  Latest direction
  Prefer a small change with clear evidence.
  v browses related work without starting anything.
  [G] Related goal: Reliable imports
  [S] Related session: import-recovery






  1-17 / 17
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen task`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  > ENG-1 Validate imports
  Work
  Validate imports
  State: active Priority: 1 Project: harbor
  Stage: 1 Open stage: 1 (advisory in this view)
  Acceptance
  - Existing saved work stays readable.
  - The failure case has a reproducible check.
  Budget: 24000 tokens, advisory; never a stop rule.
  Blocked by: nothing recorded
  Children: ENG-10
  Runs: R-1
  Latest direction
  Prefer a small change with clear evidence.
  v browses related work without starting anything.
  [G] Related goal: Reliable imports
  [S] Related session: import-recovery











  1-17 / 17
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [v Browse]
 [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

### Session detail

**80×30** — `node console/proto/main.mjs --print 80x30 --screen session`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────
  > import-recovery Waiting for a retry policy
  codex / blocked / up 32m
  Doing: Waiting for a retry policy
  Serves: ENG-1 Validate imports
  Goal: G-1 Reliable imports
  Run: R-1 / Astra / high
  Where: /fixture/harbor/lane-1
  Herdr: fixture-harbor > t1 > p1
  Last message
  The fixture session checked the failure path and recorded the remaining
  choice.
  Brief: /fixture/briefs/ENG-1.md
  Enter peeks here. g goes to the pane (simulated).
  [G] Related goal: Reliable imports
  [T] Related task: Validate imports
  1-15 / 15
  Sessions / harbor / 6 shown───────────────────────────────────────────────────
  SESSION                       WHO                STATE
  harbor / 6 sessions
  import-recovery               Codex Astra        blocked                     >
    ENG-1 / 32m / Waiting for a retry policy                                   >
  Sessions 1-3 / 13 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [r Reply]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**100×40** — `node console/proto/main.mjs --print 100x40 --screen session`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────
  > import-recovery Waiting for a retry policy
  codex / blocked / up 32m
  Doing: Waiting for a retry policy
  Serves: ENG-1 Validate imports
  Goal: G-1 Reliable imports
  Run: R-1 / Astra / high
  Where: /fixture/harbor/lane-1
  Herdr: fixture-harbor > t1 > p1
  Last message
  The fixture session checked the failure path and recorded the remaining choice.
  Brief: /fixture/briefs/ENG-1.md
  Enter peeks here. g goes to the pane (simulated).
  [G] Related goal: Reliable imports
  [T] Related task: Validate imports









  1-14 / 14
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────
  SESSION               WHO                UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery       Codex Astra        32m   blocked  ENG-1   Waiting for a retry policy       >
  batch-retry           Claude Opus        18m   working  ENG-2   Testing interrupted batches      >
  import-review         Codex Astra        45m   done     REV-3   Finished the error review        >
  account-recovery      Claude Opus        24m   working  ENG-11  Tracing a recovery edge case     >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [r Reply]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```

**140×45** — `node console/proto/main.mjs --print 140x45 --screen session`

```text
 herdr-brain / demo [p harbor] [: Screens] [b Back] [q Quit] [R Refresh]
 [! Needs you 13] 3 to read 0 later [s Sessions 8] all projects [5 Lanes]
 Read one thing / return to the same row
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  > import-recovery Waiting for a retry policy
  codex / blocked / up 32m
  Doing: Waiting for a retry policy
  Serves: ENG-1 Validate imports
  Goal: G-1 Reliable imports
  Run: R-1 / Astra / high
  Where: /fixture/harbor/lane-1
  Herdr: fixture-harbor > t1 > p1
  Last message
  The fixture session checked the failure path and recorded the remaining choice.
  Brief: /fixture/briefs/ENG-1.md
  Enter peeks here. g goes to the pane (simulated).
  [G] Related goal: Reliable imports
  [T] Related task: Validate imports














  1-14 / 14
  Sessions / harbor / 6 shown───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SESSION                  WHO                  WHERE           UP    STATE    SERVES  DOING
  harbor / 6 sessions
  import-recovery          Codex Astra          lane-1          32m   blocked  ENG-1   Waiting for a retry policy                          >
  batch-retry              Claude Opus          lane-2          18m   working  ENG-2   Testing interrupted batches                         >
  import-review            Codex Astra          lane-3          45m   done     REV-3   Finished the error review                           >
  account-recovery         Claude Opus          lane-4          24m   working  ENG-11  Tracing a recovery edge case                        >
  Sessions 1-5 / 7 lines; scroll here for more
 Demo: actions stay in memory. Session list remains available below.
 [r Reply]
 [g Go to pane] [Enter Peek] [m Actions] [? Help]
 [b Back] [! All needs you] [s Sessions] [: Screens]
```
