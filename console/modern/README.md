# Live Projects trial

## Minimal profile

For one compact screen of the project's live sessions, including the
canonical checkout and its lanes:

```sh
node console/dev.mjs --project herdr-brain --minimal
node console/app.mjs --minimal --project herdr-brain --print 100x24
```

Set `"profile": "minimal"` at the top level of the console config to make it
the default. `--profile full --modern` opens the full project console again;
`--profile full` opens the existing classic console. The profile preference is
never written by the console. `--minimal` and `--profile minimal` also work
without `--modern`, including with `--folder`.

Press **C** in the full or minimal console to open or focus the selected fleet
project's supervisor chat. Chats share one **Herdr Brain** control workspace,
run supervisor entry in their own canonical checkout, and retain one tab per
project. Their `chat-` agent names are separate from the project's ops notice
recipient. Refresh and project selection never open a tab; `--print --keys C`
refuses the action. See [monitor chat](../../discovery/README.md#fleet) for
workspace, harness and ops-recipient overrides.

The minimal screen has three bordered Ink panels. **Runs** is an in-house table
with a header, column separators and aligned cells: run, work, stage, provider,
start and elapsed time. Landed runs retain their final duration and are dimmed.
Reviews show the latest run in their recorded lane as their subject without
inheriting that worker's lifecycle. Supervisors and operator chats occupy one
quiet Context line. Immutable session IDs take precedence over names; a pane
alone cannot associate an occupant with a run. Project selection uses the stable
project ID and canonical Git common-directory identity.

**Reports** shows the eight newest ingested reports plus unresolved exceptions,
newest first, with local time, run/item, outcome, watch check and record headline.
Checks come from explicit `[org-report]` notices, never from the outcome; missing
checks say `unknown`. The console folds the transport journal at
`ORG/supervisor/inbox.log` (or `GIT_COMMON_DIR/supervisor/inbox.log` for projects
without a record). Blocked, invalid, missing, unavailable and long-running watch
notices remain visible after delivery until a newer notice/report supersedes
them. Superseded or closed items do not count as current exceptions. A completed
journal line must parse; a concurrent partial tail waits until the next refresh.
`modern/feed.mjs` exposes pure projections for a future web renderer or autopilot
feed extension; this version does not consume an unfinished autopilot schema.

**Train** reads `GIT_COMMON_DIR/promote/queue.json` and `promote/batches/*/train.json`,
showing waiting lanes, current batch members/phase, batch start and elapsed time,
CI command, interrupted batches and recent results. Refusals include their reason;
Enter opens the receipt and log. ENG-181 receipts expose the running gate command
and start time before CI finishes. Older receipts still work without that clock. Batch
creation time comes from the stable batch directory's birth time when no explicit
start exists; atomic receipt saves do not reset it. The current CI command prefers
the gate receipt, then its `train.log` validating line. A missing check start stays `unknown`;
finished checks use their recorded duration or finish time while delivery waits.
Final promoted/refused receipts supersede old interrupted queue rows after resume.
Reading this view issues no promotion, validation, scheduling or model calls.
The operator's C key explicitly launches or focuses the supervisor chat.

At 90 columns and above, rows fit within a 116-cell reading width; wider panes
do not stretch the spacing. Narrow panes use two lines per work/report entry.
Each panel receives space for whole entries; omitted entries are counted
in its heading. Selection scrolls older entries into view. Times are HH:MM today
and MM/DD HH:MM earlier, consistently across sections. Colour marks only stage
and outcome: cyan engineering, magenta review, amber
fixes/exceptions, green completed results; the rest is neutral. Refresh follows
`refresh_seconds`; Ink's incremental renderer writes no bytes for unchanged
output, and duration text advances once per minute. `--print` renders the same
Ink tree to a string and never takes control of a session. The full profile
continues to use its existing painter.

Idle chats and supervisors remain visible while Herdr lists them. Reported or
abandoned workers drop off once they stop working or blocking. Source failures
retain the last good data with a source notice; changing repository clears old
source data. Optional missing journals/queues are normal and create no files.
Use Tab/Shift+Tab to move between panels, remembering each selected row. ↑/↓
(or j/k) select within a panel; the `›` marker remains visible without colour.
Enter or a click opens the row. Active runs open their live agent; landed,
blocked or finished runs open durable details: the report, its check, review
verdict and findings, promotion and commit, decisions and recorded stage timings.
Reports always open their report with its review. The Context line opens its
supervisor and chat sessions. The running batch opens a live status and log tail;
recent results open their receipt and log. A view stays on its batch when another
batch starts. Missing timing data is labelled, never inferred from file updates.
Detail views support arrows, PageUp/PageDown and the wheel for scrolling; Tab
jumps sections. Item, report and promotion links retain a nested Back history.
Run details begin with a lifecycle chain: dispatch, engineering, report, review,
each recorded correction's fix/report/review links, train, landed and release
candidate. Press `p` on any Runs row or click its stage to inspect its chain,
including a worker that is still active; Enter on the run keeps opening its
session. Batch details show queued, rebase, CI, fast-forward, close lanes and
notify. Marks use `\u2713` for done, `\u25cf` for running, `\u00d7` for failed,
`\u25cb` for waiting and `\u2013` for skipped. They remain readable without colour. Wide views chain links horizontally, wrapping long
lifecycles into connected bands; narrow views stack them vertically. Arrows
select links, Enter or a click opens their brief, report, review, check output,
promotion receipt or candidate gate. Esc and Back restore the selected link
and scroll. The CI view includes each attempted check, a bounded live tail and
structured failing tests with their diagnostic messages from the full log.

Chains use record timestamps and receipts, with `unknown` for missing clocks.
The CI clock describes the current/latest attempted check, including its
recorded reuse evidence; it freezes when finished and stops on interruption.
Rebase, fast-forward, lane closure and notice delivery have no independent
stage clocks in older receipts and remain unknown. Closure and delivery use
the queue's distinct receipts and the notice journal, including autopilot
handling. Correction links require explicit settle/dispatch run relationships;
candidate membership requires the promoted commit in that project's recorded
candidate. Readers never use a file's modification time as a stage clock.
While validation runs, its temporary log is selected only when the validation
lock names this batch's exact receipt and one matching log exists. Ambiguous
logs wait for the completed gate's explicit path.
Each live session activation rechecks the exact occupant and canonical repository. The embedded view reuses the full
console's native terminal grid and Herdr control stream. **Esc** or the top-left
**‹ Back** button releases control and restores selection and scroll; Esc is never
sent to the pane. **Ctrl+\** deliberately sends Esc to interrupt the agent and
is labelled in the footer. Ctrl+] also returns. Ordinary typing belongs to the
agent, including Meta/Alt keys; q and Ctrl-C quit from read-only views. The session
opens at its own full viewport width. There are no other write paths.
Launch-pending shells appear only after agent detection. Release candidate gates
are reachable from a landed run's lifecycle link.

The minimal controller and fact readers load without console dependencies. Ink
and React load dynamically only when the minimal profile prepares its renderer;
other `--print` profiles and their tests do not need them. Install optional UI
dependencies with `npm --prefix console ci`. Tests requiring Ink visibly skip
when the packages are absent; run them in an installed checkout to validate views.
The standalone `--print --keys C` command refuses the chat request before
preparing any profile's renderer, so it also works without those packages.
The dependency-free `session-input.mjs` parser handles Esc, Meta, CSI and SS3
before any bytes reach a session. Bare or repeated Esc and partial CSI/SS3
return without forwarding the chunk; complete Alt+arrow sequences retain their
bytes. Its tests run in the promotion tier even when Ink and React are absent.

This is the native-spaces design connected to live org and Herdr data, with
the September 20 operator-study repairs. It is a live trial whose only writes
are the project screen's prompt (a new chat, or a task under the work block),
what the operator types into a session, session names, Waiting on you answers,
project route, desk and housekeeping overrides, and operator priority changes through validating record commands.
It runs in Ink through `console/app.mjs`; it is not the browser design preview or
`console/proto` fixture application. Opt in per launch; the existing console
remains the default and retains all of its operational actions.

The visual reference is the accepted `modern-console-preview.html` browser
preview, sourced from `.lane/design-preview/modern-console-overview.html`.
The first live renderer diverged from that reference; the September 20 fidelity
correction restores its color tokens, section surfaces, task grouping, central
navigation and overview composition. It starts dark; press `D` for the light
palette that matches the light browser preview, or launch with
`HERDR_CONSOLE_THEME=light`. The terminal controls font and cell dimensions.

From this worktree:

```sh
node bin/org.mjs console --modern --project bch-cloak
node bin/org.mjs console --modern --project herdr-brain

# Follow the calling Herdr workspace, or discover available projects.
node bin/org.mjs console --modern

# Inspect an existing repository or an ordinary folder, without setting it up.
node bin/org.mjs console --modern --folder /absolute/path/to/folder
```

To keep it open while the code changes, run the development loop in its own
Herdr tab. Saving any `.mjs` under `console/`, `lib/` or `bin/` restarts it in
place; after `q`, Enter reopens it and Ctrl-C ends the loop:

```sh
node console/dev.mjs --project bch-cloak
```

A direct launch supports an explicit config and one-frame output:

```sh
node console/app.mjs --modern --config /path/to/console.json --print 100x34
node console/app.mjs --modern --project herdr-brain --print 100x34 --keys 'g\n'
```

The keys in `--keys` are sent one character at a time; `\n` means Enter and `\e`
means Escape. This is a read-only rendering/testing interface in modern mode.

## What works

- The overview shows Decided, Asked and Waiting on you counts and the latest
  recorded decision. `c` opens Control: the current waiting queue, recent
  decisions, questions with recommendations and answer attribution, and routes.
  `d` and `f` open the complete decision and question histories, including old
  decision notes, run decisions, structured report fields and automatic answers.
  Enter opens their evidence; an unanswered record question opens the existing
  answer page. A report question with an existing record ID appears once. A
  report-only question is labeled as evidence and does not invent a waiting item.
- `P` opens Priorities: operator outcomes in rank order, open work and runs serving
  each, rank history with who/why, and advisory Unaligned work. Enter a priority
  to edit its rank and reason, then review the resulting order and Enter to save
  through `record priorities rank`. Add priority uses the same review and CLI
  validation. Esc or Cancel discards a draft; a stale review cannot overwrite a
  newer rank. During review, Up/Down scroll a line and PageUp/PageDown scroll
  a page, so long orders remain inspectable by keyboard. Backspace returns to
  editing. A project without priorities invites the operator to add one.
  Named agents use `record priorities propose` to leave a waiting question, even
  if category policy says auto. `--print` never changes priorities.
- `u` opens the effective project routes, configuration sources, dispatch
  defaults, primary pool, selection policy and always arguments. Enter on a
  route edits kind, model and effort; Tab changes fields, Ctrl+U clears, Enter
  reviews, and a second Enter saves through `record routes set`. Esc or Cancel
  leaves the config unchanged. A stale review cannot overwrite a newer edit.
  Model and effort may stay at the harness default; edits send only changed
  fields. Clearing an existing override requires a replacement. A record-only
  project must have its folder opened before routes can be read or edited.
  Unchanged configured routes close without a write; unchanged suggestions can
  still be adopted explicitly. Effective effort and launch arguments use the
  lane launch resolver, including legacy argument-encoded effort. Reading or
  changing another field does not turn that inferred effort into an override.
  Reads and writes use the canonical Git project's routing layers; inherited
  `LANE_CONFIG` launch overrides do not redirect project edits. The CLI preserves
  project lifecycle fields and inherited routes and writes only the project's
  `.lane.json`; a newly created config is ready to add and commit in Git.
  An unconfigured project shows portable suggestions as confirmation pending;
  its first saved edit adopts the complete preset, preserving other defaults.
- `S` opens Desks: review route (or worker-pool selection), fix route (or the
  worker route), review round cap, review timeout, stopped-worker reuse and
  supervisor target. Enter opens the six fields; Tab changes field, Ctrl+U clears,
  Enter reviews the before/after values, then Enter saves through `record desks
  set`. Blank removes that setting and uses its built-in default (cap 0 is
  unlimited). Item caps win; existing settle receipts keep their intake snapshot.
  Editing inherited desks preserves other effective settings because settle uses
  whole-object precedence. Saving desks does not confirm suggested routes.
  Opening a project requires no setup and writes nothing. Errors and stale reads
  block editing; stale confirmation keeps the draft for inspection. The console
  never launches settlement or review by changing desk settings.
- Routes also offers Add route/model, primary pool, dispatch defaults, task
  selections and always arguments. Existing task selections and always arguments
  are clickable further down the page. All use the same edit/review/save flow,
  then `record routes add|policy|defaults|arguments --value JSON --expect REV`.
  Route/model/effort/pool names remain opaque; references and pool coverage must
  validate. Argument arrays preserve token boundaries (JSON arrays of strings).
  New-route reviews show the effective model, effort and launch arguments,
  including inherited dispatch defaults and effort encoded in arguments.
  Always-argument reviews compare the entered kind's current array with its
  replacement, including when entering an existing kind through the generic form.
  Blank dispatch fields inherit harness defaults. The first route configuration
  change confirms the portable preset and preserves lifecycle/desk fields.
  All `.lane.json` editors share one lock, detect changes in parent configuration
  too, and replace only the canonical project's file. `--print` cannot save any
  of these changes.
- `H` opens Housekeeping, also linked from Control: running/stopped/unknown or
  stale-lock state, effective defaults and overrides, last live scan, recent
  closed/kept/resumed workers, reasons, failures and explicitly labeled previews.
  The module's bounded activity tail comes from the selected canonical Git
  project's state under its record; projects sharing a record remain separate.
  Pause reviews `enabled=false`, then saves through `record housekeeping set`.
  Enter on Edit overrides changes enabled, recovery, tick and cleanup intervals;
  blank fields remove an override and inherit its default. Tab changes field,
  Ctrl+U clears, Enter reviews then confirms, and Cancel/Esc discards. Stale
  reviews cannot overwrite newer config. Saving creates tracked-project config
  ready to add and commit; it never starts or signals the schedule. Pause takes
  effect at the next tick. A stopped schedule requires the project supervisor
  to start it after enabling. `--print` cannot save housekeeping changes.
  Missing/unreadable logs and PID checks stay explicit. A lock for a custom config
  or mismatched runtime prevents editing the default file as if it controlled
  that schedule. Older logs have counts but no per-tab keep reasons; new cleanup
  passes record those reasons. A valid identity with an inaccessible PID can
  still be paused through config, without guessing whether its process is alive.
- Existing records are discovered when opening a project or folder, with no
  console configuration required. Reading a project without a record does not
  create one; plain folders can inspect route suggestions but need Git to save.

- The project screen (`h`) opens with counts (sessions, working, blocked,
  idle, done), then the work block: an open goal marked `meta.block`
  (morning, afternoon, overnight), else the goal most current sessions are
  linked to. Its open tasks follow, the ones with a session first, with that
  session's number. Waiting on you shows each item with its recommended answer.
  Every session is then numbered, one row each, under a `checkout · count`
  heading: state, name, time in its current state (as this console saw it
  change), uptime, harness, and its task or what it is doing.
- A session's number opens it (two digits when there are ten or more).
  Clicking its name renames it: a display-only Herdr pane label (`herdr pane
  rename`); the agent name that record runs link to is never changed. `e`
  renames the focused session; an empty name clears the label.
- The prompt at the bottom (`n`, or click it) adds a task under the block
  through `record add`, or starts a chat with a configured agent kind
  (`chat_kinds`, default claude and codex) in a chosen checkout. The bar
  always shows which and where (`task → G-15`, `claude → main`); Tab and
  Up/Down change them, and one Enter starts it. `--print` never writes.
- A Waiting on you item's page lists its choices with what each causes, the
  recommended one starred, then Reply, Open the session, Save for later and
  Drop. A number (or `y` for the recommended choice) arms the answer line,
  which says exactly what will happen; Enter does it. A reply or an org
  decline asks for its words first. Session results go through the Brain CLI
  (the same verbs as the classic console); record questions through `record answer`.
- Current project sessions lead the overview. Goals/tasks come from `record status
  --json`; decisions and stopped-session results reuse the existing org/Brain
  read projections. Finished tasks are excluded from the active list.
- Activity (`a`) shows the last 36 hours of item creation, run starts, reports,
  decisions and closes from `record log`. Agent-created items keep their recorded
  reason there and on the item page.
- Main checkout and worktrees use canonical Git common-directory identity. No
  basename, workspace label or branch prefix is used to establish ownership.
- The scope dropdown overlays the current view, supports filtering, and cancels
  without losing context. It includes configured projects and repositories open
  in Herdr. Opening a known worktree/folder reuses a matching association.
- Under `HERDR_ENV=1`, native Herdr owns the persistent sidebar. The companion
  hides its duplicate rail; `w` reveals checkouts on demand. Standalone mode
  starts with the rail. `HERDR_CONSOLE_SIDEBAR=0|1` overrides that local default.
- Projects and ordinary directories without an organization are inspectable.
  Missing config does not write an example file or prevent discovery.
- Checkout tabs are horizontal. A split tab with several agents requires an
  explicit session choice. Shell tabs offer native terminal access.
- Opening a session lets you type into it here. The console takes Herdr's
  control stream for that pane (`herdr terminal session control`). While it
  holds the stream, Herdr sizes the pane's terminal to the console's area, so
  the agent redraws to fit, with its cursor. Every key goes to the session,
  including Esc, Ctrl-C and `q`. Ctrl+] or clicking ‹ Back releases the pane,
  which returns to its native size, and goes back to where you were. A crash or
  kill releases it too. The wheel scrolls the session. If Herdr hands the
  terminal elsewhere, the view drops back to watching; `i` types into it again.
- The watching view separates goal/task/summary from a live, read-only harness
  screen. An exact-pane observer preserves supported ANSI styles and cell layout.
  It reads the native dimensions and shows the bottom rows first, with explicit
  visible row/column ranges. Console resize and local panning never resize or
  scroll the actual harness. `l` switches to a plain transcript polled every
  1.5 seconds; `v` returns to the live screen. Unsupported hosts show an error
  and the native-open path, rather than an unlabelled transcript fallback.
- Goal/task readers put current linked sessions before criteria and notes. They
  include descendant active tasks, distinguish historical links, and explicitly
  name missing criteria. Compact overviews retain all four work categories.
- Open native terminal transfers focus to that exact session after checking
  current topology. The console continues in its own tab for the return trip.
- Back restores project, view, focus and scroll. Closed/missing sources and
  reconnect errors retain distinguishable last-good data instead of pretending
  the project is empty.
- Current, deferred and future-stage decisions remain separately reachable.
- Waiting on you holds only what still asks something open. A session result folds
  out, still readable, when its record item has closed or a newer result about the
  same item replaced it (Resolved), when it reported without asking (Reports),
  or when its session ended over a day ago and no record item holds it (Ended
  sessions). A stranded reply never folds. Org questions are never folded here.

## Keys

| Key | Action |
| --- | --- |
| `p` | Scope dropdown; type to filter, Up/Down choose, Enter selects, Esc dismisses |
| `h` | Project overview |
| `g` / `t` / `a` / `s` / `!` | Goals / Tasks / Activity / Sessions / Waiting on you |
| `c` / `d` / `f` / `u` / `P` / `H` / `S` | Control / Decided / Asked / Routes / Priorities / Housekeeping / Desks |
| `Tab` / `Shift+Tab` | Change section, remembering selection within it |
| `j` / `k`, Up / Down | Select within the current section |
| Left / Right | Change central view, or the selected checkout's horizontal tab |
| `w` | Show/hide local checkouts |
| `Enter` | Open the focused row/control |
| `Esc`, `b`, `Alt+Left` | Back |
| `Alt+Right` | Forward |
| `PageUp` / `PageDown`, wheel | Scroll; live output switches to the older/latest transcript |
| `l` / `v` | Plain transcript / live native screen |
| Shift + arrows | Pan the live screen locally; vertical steps are 3 rows, horizontal 12 columns |
| `r` | Refresh sources |
| `D` | Switch between the reference's light and dark appearance |
| `o` | Open selected native terminal in Herdr |
| `i` | Type into the watched session here |
| `Ctrl+]` | While typing into a session: release it and go back |
| `n` | Prompt: type, Tab task/chat kind, Up/Down checkout, Enter starts, Esc |
| `1`–`9` | Open that numbered session (project screen) |
| `e` | Rename the focused session (project screen) |
| `?` | Help |
| `q` | Quit, restoring terminal modes |

Mouse clicks share these actions. Extended SGR mouse Back/Forward codes are
parsed and tested; physical side-button forwarding depends on Herdr and the
outer terminal and has not been validated. The readable layout minimum is
80 × 20; 80/100/140-column views have been exercised. Wider session views show
Session, Who, Where, Up, State, Doing. Narrow views preserve identity/state and
show the remaining facts in session detail.

## Boundaries

Typing into a session writes only to that session's terminal, and only while
the operator is in it. The prompt bar writes `record add` through the CLI for a
task, and `herdr tab create` / `agent start` / `agent prompt` for a chat, on the
operator's typed text and Enter. Renaming sets only a pane label. A Waiting on you
answer goes through the Brain CLI or `record answer` after the answer line says
what it will do. Route overrides use `record routes set` after review. Housekeeping overrides use
`record housekeeping set` after review. Desks and additional routing controls use
`record desks set` and `record routes` through the same reviewed flow. There is no dispatch or model-call path; use
`node bin/org.mjs console --project NAME` for dispatch. Nothing writes as a side effect of opening or navigating the trial.

Goal/session associations use recorded run data. A title resemblance does not
establish a link; unmatched sessions say Unlinked and older recorded associations
say last. An agent marked working does not prove progress on a task.

Folder opening is temporary observation. It does not initialize Git, register a
project, create an organization or persist a new catalog entry. Startup/config
files and project files remain unchanged. Idea capture, new folders, project
registration, chat creation, and new-shell write workflows are follow-on work in
the [onboarding design](../../docs/design/console-projects-onboarding-2026-09-20.md).
The browser URL on port 8765 remains a captured-data design preview.
Goal creation is not connected; the header offers `n Start` on the project
screen and states Read only elsewhere. The product is shown as `Herdr Monitor`
while Projects remains a naming recommendation. Daily/weekly planning is
specified in the [backlog review design](../../docs/design/console-backlog-review-2026-09-20.md);
no scheduler or autonomous backlog mutation is enabled by this trial.

The watching viewer is a decoded terminal screen; typing uses Herdr's control
stream, not a local PTY. It supports
the observed Herdr renderer's bounded ANSI controls, not arbitrary terminal
images or every host palette customization. See the [terminal contract](../../docs/design/console-native-terminal-contract-2026-09-20.md).
Mouse clicks inside the session are not forwarded; use `o` for those.

## Herdr plugin package

The root `herdr-plugin.toml` registers the Herdr Monitor plugin (`rewt.herdr-monitor`). Its
`console` pane runs `herdr/console.sh`, which opens this modern console as a split beside the
chat; with no project or folder given, it selects the calling workspace's project. It honors
`HERDR_BIN_PATH` and the inherited socket context. Node 20+ and the console's dependencies are
required; a release built by `herdr/release.sh` installs them.

Releases are installed and switched with `herdr/release.sh` (see the root README). To run a
worktree beside the active release:

```sh
herdr/release.sh dev /absolute/path/to/this/worktree
herdr plugin pane open --plugin rewt.herdr-monitor-dev --entrypoint console
```

## Validation

`npm test` includes the offline modern-session tests: canonical repository
identity, project isolation, absent config, non-Git folders, exact-pane reads,
split-tab choice, disappearance, stale responses, refresh races, source recovery,
Back/Forward, mouse hit targets, section navigation, dropdown cancellation,
compact work summaries and native-screen cropping. Observer tests cover full
and differential frames, Unicode cells, source geometry, cancellation, stale
callbacks and failure handling. These tests do not call a model or a real Herdr server.
The repository/console suites also cover the existing interface.

Current evidence and limits are in the
[independent operator UX study](../../docs/reviews/console-full-ux-study-2026-09-20.md)
and [usability delivery report](../../docs/reports/console-usability-study-2026-09-20.md).
Earlier live-trial and visual-fidelity reports remain historical records.
