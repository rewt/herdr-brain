# Lane console UX review

2026-09-10 · Design proposal; no production implementation or OpenSpec amendment.

Keep the grouped session table and the bottom task bar. Give evidence a stable pane
below the table, make status readable without color, and make launch a deliberate
reviewed action. The console's first question is “what needs my attention?”; its
second is “what is the evidence?”; its third is “where should this new task run?”

The [revised interactive wireframe](lane-console.html) uses the original eight
sessions, task titles, messages, branch heads, gates, reports and route use notes.
Personal root/host labels and the other repository's name are replaced with public
sample aliases. Example paths are synthetic. The input had no resolved route models
or effort fields, canonical identity keys, completion markers, full SHAs or deadline
timestamps: the revision exposes those gaps rather than inventing evidence.
All data and interactions are illustrative; the HTML calls no CLI or Herdr service.
Google Fonts is optional; the local monospace fallback keeps it usable.

## Basis and decisions

Read the repository instructions, README and full handoff; the
[initiative report](../SPEC-20260908.md); the [OpenSpec guide](../../openspec/README.md);
and the proposal and design for each of discovery, messages, board UX, idea CLI and
composer. The local reference screenshot informs density, aligned rows, restrained
separators and a pinned launch strip. Its product name, branding, window chrome,
mascot, provider menu and host identity are not design elements to reproduce.

| Decision | Reason and source |
| --- | --- |
| One table grouped by development root, canonical repository, then facilitator/lanes | Keep discovery's ownership hierarchy. A role grouping loses repository context; role belongs in the session label/detail. [Discovery: filtering](../../openspec/changes/board-discovery/design.md#filtering-state-and-performance). |
| Selection reveals evidence; Enter focuses the live session once | Avoid making Enter mean “expand first, focus second.” This preserves the existing [one-action requirement](../../openspec/changes/board-ux/specs/board-terminal-ux/spec.md#requirement-one-action-keyboard-focus). |
| A fixed evidence pane below the table | The original inline drawer moves neighboring rows. The proposed permanent right panel at 100 columns leaves too little room for messages. Replace that geometry in [board UX](../../openspec/changes/board-ux/design.md#ui-and-dependencies). |
| Task input never dispatches on Enter | Multiline text and pasted newlines need safe input ownership. Require an editable topic and explicit review/submit. Correct the wireframe to match [composer](../../openspec/changes/idea-composer/design.md#interaction) and [idea CLI](../../openspec/changes/idea-cli/design.md#cli-contract). |
| Scope and launch destination are independent | Filtering observations must not silently redirect a draft. Canonical repository identity remains authoritative; root/repository labels are presentation. |
| Keyboard is the acceptance path | Browser clicks only make the prototype inspectable. Production mouse support remains the separate [optional research task](../tasks/board-mouse.md). |

The earlier report contains chronological “proposed” statements. Current
[AGENTS.md](../../AGENTS.md#product-contract) governs the CLI boundary and display
metadata now. This review neither adds a dependency nor grants approval for A4.

## Region review

### Sidebar

**Right:** The short tree is a useful map of the machine; repository counts make
the table's grouping easy to navigate. A local scope label is appropriate.

**Wrong or missing:** A fixed 250-pixel rail consumes too much of a terminal pane.
Its colored dots are not statuses, its leaves are mouse-only, and “+ add” implies a
catalog the product does not own. The original treats a non-git session as a third
repository. Group-by-role contradicts the requested persistent repository context.
There is no clear-filter key or explanation of partial discovery.

**Treatment:** Show a 22-column scope rail only at 140 columns or wider. Include
All repositories, root-qualified repository filters, Unknown repository, Attention
and History. Show textual counts and selected brackets; do not encode a whole
repository with its “worst” color. At 100 and 80 columns, move the same choices to
the `/` scope picker, keeping the active filter in the header. “Unknown repository”
is an observation bucket, never a launch target. No add button or persistent catalog.
Facilitators stay visibly outside the lane subgroup, even when unregistered.
Duplicate readable labels need the CLI's identity suffix and inspectable canonical
path; synthetic fixture keys stand in for those identities in the HTML.

### Header

**Right:** The top summary establishes scale quickly. Counts and refresh context
belong above the table.

**Wrong or missing:** Desktop traffic lights, a large glyph and a host/user title
waste rows inside an existing Herdr pane. Unconditional green “live” overstates
coverage. The original counts omit unknown status, count the non-git bucket as a
repository, and do not explain whether filtered-out rows contribute. “Stale” has
two unrelated meanings that a single counter obscures.

**Treatment:** Use two text rows: title/scope/coverage, then visible count, working,
attention, hidden completion count and active filters. Coverage means reachable
local endpoints out of enumerated endpoints; unknown denominator is “partial,
enumeration unavailable,” never “1/1.” Show sample age and last successful refresh.
Expose connection errors in a persistent line with an inspect action. A known
disconnect marks observations stale immediately; otherwise use discovery's ten-
second threshold. Leave earlier values visible with their age. A refreshing
indicator does not imply either a healthy connection or a current validation gate.
See [discovery and coverage](../../openspec/changes/board-discovery/design.md#discovery-and-coverage).

### Table

**Right:** Group separators, aligned gates and a message column are the right
language. Repeated sessions for one topic are useful evidence, not duplicates to
collapse away.

**Wrong or missing:** The original nine columns spend scarce width on Run, Idle,
provider and a duplicate status dot while useful text ellipsizes. Working/idle is
only a symbol in the row. Two board-messages sessions are hard to distinguish
without role. History filtering exempts engineer/reviewer rows by role, which is
unrelated to completion. “No message” reasons mix raw prompts with assistant text.
Row numbers are presentation IDs, not safe action targets.

**Treatment:** Keep five cells: selection/attention, session with short role, text
status, exact short gate and first substantive message line. Move runtime, silence
age, full provider/role, branch divergence and paths to detail. Unregistered is an
explicit detail/provenance label; a known live agent still deserves a row. Name the
source when a title substitutes for an unknown goal. Unknown and missing gates
are words, not a reassuring dash. Preserve all sessions, including unnamed agents
and non-git sessions; use their server-qualified opaque row IDs for actions.

The supplied `done` status has no completion marker. Display it as `done*` with
“Herdr done; completion unknown” in detail and keep it visible. Hide only known
registry/CLI completion when idle or offline. A marked-done working, blocked or
unknown row remains visible with “marked done; active.” History reveals hidden
completion records without changing their status. This fixes the wireframe;
[discovery's history semantics](../../openspec/changes/board-discovery/design.md#filtering-state-and-performance)
should stay unchanged.

Use stable group/session ordering; never sort rows under the cursor as state
changes. Selection follows row identity, not its index. If a filter hides it,
choose the closest remaining visible row and announce the change. If it disappears
entirely, retain a “session no longer present” notice and refuse focus. The fixture's
initial attention count is four sessions: two stale gates, one blocked/failed row,
and one unknown agent state. Reasons overlap; counts count sessions once.

### Row drawer / evidence pane

**Right:** The original juxtaposes branch, gate, report, brief and message. That is
the useful decision surface; keep it one selection away.

**Wrong or missing:** Inline expansion shifts the list. The drawer lacks goal
provenance, a brief excerpt, full evidence identity, observation age, raw-output
separation and unavailable-action reasons. It offers `c check`, `p promote` and
`x close` without a specified board command or action contract. Its overdue badge
has no timestamp. A gate marked stale has its historical exit hidden.

**Treatment:** Reserve a fixed-height pane below the table. Its title repeats the
selected session, text state and attention reasons. Message, Evidence and Context
tabs let the operator inspect complete wrapped content without growing the pane.
Message leads with the substantive block and its source/observed time/truncation;
put a separately labeled raw pane excerpt below “message unavailable.” Evidence
shows current HEAD, recorded gate SHA/exit/command/time/duration, report path,
reviewed SHA/verdict and whether each matches current HEAD. Context shows full
goal/provenance, brief path/excerpt, role/kind, canonical repository/worktree,
server/session identifiers, deadline, tripwire and observation freshness.
Use “not supplied” for fields absent from this fixture, including full SHAs and
the brief excerpt; the prototype must not manufacture them.

A historical NEEDS-WORK remains historical; a report with no reviewed SHA has
unverified applicability. A passing gate is validation evidence, never a review
verdict or promotion permission. The source's overdue flag is shown as “overdue?
deadline timestamp unavailable”; production requires an explicit valid deadline
before asserting overdue. Silence or a six-day runtime cannot establish it.

Keep only Focus live tab and Mark done as actions. Mark done is disabled with a
reason for unregistered rows; it never stops an agent or closes a lane. If a recorded
live target cannot be verified, focus refuses visibly. Enter and the `a` alias each
invoke one `lane board focus`; `d` invokes one `lane board done`. Observations,
refresh and reconnect invoke neither. Git lifecycle work remains in the CLI; retain
help guidance but remove the invented drawer actions. This follows
[AGENTS.md](../../AGENTS.md#product-contract) and [board UX's existing keys](../../openspec/changes/board-ux/design.md#ui-and-dependencies).

### Launch bar

**Right:** A persistent task affordance joins observing and starting work. Who as a
route and Where as a discovered repository are the right abstractions.

**Wrong or missing:** Enter dispatches from the single-line task field; a generated
four-word slug is not editable; the sample prints a shell-looking command with
unescaped task text; and its success toast claims row selection it never performs.
Repository changes silently select the first route. The root entry confuses “not a
repository” with “no routes.” Claimed command/editor shortcuts have no handlers.

**Treatment:** Keep a small pinned task strip; `n` enters it and expands the task
input while focused. Task text, editable topic, Where, Who and Review launch form
the tab order. Enter inserts a task newline; Enter in a one-line topic advances to
Where. Only the explicit Review launch control opens a review. Review contains the
complete task, topic, root-qualified canonical repository, destination and route
with kind/model/effort/use note, then Launch once and Edit then dispatch. No modifier
key is required to submit; do not advertise Command-key terminal shortcuts.

The draft stays in UI memory across selection, filtering and Escape. Filtering the
board never changes Where. Only a verified caller repository may prefill Where;
startup at an identity root leaves it unselected even if discovery finds repositories.
A repository change clears Who and loads that
repository's resolved routes; require a fresh selection even if the route names
coincide, since model/effort/use may differ. Do not infer model or effort from a route
name. The fixture lacks resolved fields, so the picker says “not supplied.” In
production show resolved values, “agent default” when known to be omitted, and
“unknown” when unsupported; the use note remains separate from those fields.

Submission freezes task/topic/repository/route for one foreground CLI invocation;
disable repeated submit and target editing until it returns. Show progress as
“starting lane,” not a queued job. Success refreshes/selects the returned registry
row, including briefly revealing it if a filter would hide it, without stealing
Herdr focus. Only a later Enter jumps to it. Until that row is observed, show
“launched; waiting for observation” and retain the returned identity; never guess
by topic. Failure handling follows [idea CLI](../../openspec/changes/idea-cli/design.md#editor-and-failure-behavior):
refusal before mutation, draft retained, lane opened but unprompted, ambiguous
delivery, and delivery with failed registration need different messages and
explicit next steps. No automatic retry, rollback deletion or action replay.

### Popups

**Right:** Near-input selectors keep launch context visible. A route use note helps
the operator choose based on the task rather than a provider logo.

**Wrong or missing:** The original options are click-only divs. There is no search,
active option keyboard model, focus containment, Escape return, or scroll position.
The root is selectable as if it could receive a lane. Pixel widths and shadows do
not describe terminal behavior. Provider color does not tell the operator a model.

**Treatment:** Use rectangular, character-aligned overlays bounded by the viewport,
with a title, search input, option list, selected-option detail and a hint line.
Arrows select; Enter accepts only an enabled option; Tab stays inside the popup;
Escape cancels and restores the invoking control. Search and ordinary text input
own all typing, including `d`, `q`, `n`, `/` and `!`. Escape first clears no data:
it closes the popup, then suspends composition, then returns to the table; `q`
quits only from navigation. Clicking is an equivalent prototype affordance.

Where lists canonical repositories with root/path disambiguation plus Enter path
for a repository absent from current discovery. Production validates that path
through `lane routes --repo --json`, never UI filesystem inspection. The HTML's
explicit-path form can only match its two synthetic repository fixtures; other
paths show that validation is unavailable in the prototype. An identity root is a
disabled guidance entry, not an empty repository. Who searches name, kind and use
and exposes model/effort availability. Zero search matches says “No matching
routes; clear search”; zero configured routes says “No routes for this repository;
inspect its configuration or choose another repository.” These are different states.

## State, density and attention

Use one monospace face at a uniform cell size inside the terminal; weight and
reverse selection provide hierarchy. The wireframe uses IBM Plex Mono with system
monospace fallbacks. Color is semantic, not provider branding. Borders stand for
terminal rules; no gradients, rounded cards, hover-only controls, animation,
decorative icons or proportional text. Keep normal content bright enough to read;
do not render error explanations as barely visible secondary text.

| Dimension | Text cue | Optional color | Attention rule |
| --- | --- | --- | --- |
| Working / idle / Herdr done | `working`, `idle`, `done*` | Cyan / neutral / neutral | Working or silence alone is not attention. Herdr done is not registry completion. |
| Blocked | `blocked` plus reason | Red | Needs operator input; include even if the last gate passed. |
| Current gate | `exit=0 @<head7>` or `exit=N @<head7>` | Green / red | Nonzero current exit needs attention; zero does not authorize promotion. |
| Gate from another commit | `STALE @<head7>` | Amber | Needs fresh evidence; retain the old exit in detail. |
| Observation unavailable | `STALE OBS`, age and error | Amber | Keep prior values labeled; never convert missing data to idle, clean or zero. |
| Deadline | `OVERDUE` and explicit deadline | Magenta | Only a valid elapsed deadline qualifies. The supplied unverified flag is `overdue?`. |
| Unknown status | `unknown` and source limitation | Neutral, `!` gutter | Surface a visibility problem without calling it blocked. |
| Missing gate or message | `unknown` / `message unavailable` | Neutral | Missing optional evidence alone is not a failure or universal attention trigger. |
| Review | Verdict plus reviewed SHA/current-or-historical label | Text; red only for a verified current non-pass | A historical or SHA-less report cannot turn the current commit red. |

These dimensions coexist: working, overdue and failed gate remain independently
readable. `NO_COLOR` suppresses all status/selection color, including background
accents; labels, `>` selection, `!` attention, focus outlines and borders survive.
Production must not emit ANSI color sequences when it is set. The prototype's
checkbox demonstrates the visual fallback, not terminal environment handling.

Attention is a view predicate, not saved state, scheduling priority or an unread
message system. Count unique sessions before the working/attention view filters,
within the active repository/history scope; also show visible/total. Surface
machine-level discovery failures independently even when all rows are filtered out.
`!` toggles attention; `[` and `]` visit previous/next attention rows without sorting.
The rail and header show counts; the row gutter and detail explain why. No flashing,
sound or stolen focus. Refresh never marks attention handled. Do not make long idle,
dirty work-in-progress, unsupported message extraction or an old review into alerts.
The conservative message rule comes from [message extraction](../../openspec/changes/board-messages/design.md#evidence-and-extraction).

## Width, height and navigation

Measure terminal cells, not browser pixels. No horizontal scrolling is needed for
the core scan. In the following budgets the terminal width is the inner frame;
the HTML's outer hairline is only a preview boundary. Column gaps each use one cell.

| Pane width | Geometry and column budget | Evidence / composer |
| --- | --- | --- |
| 140 | 22-column scope rail; 118-column main. After two padding cells: 116 = gutter 2 + session 29 + status 8 + gate 15 + four gaps 4 + message 58. One line per session. | Fixed evidence below list; collapsed task strip spans the entire pane. Full route/destination information is in review. |
| 100 | No rail; 98 usable cells = 2 + 29 + 8 + 15 + 4 + message 40. Same scan order and full seven-character gate. | Same fixed evidence pane; `/` supplies scope. Inputs and review values wrap vertically. |
| 80 | No rail; 78 usable cells. First line: gutter 2 + session 50 + status 8 + gate 15 + three gaps 3 = 78; second line uses a two-cell indent and 76 message cells. | Two lines per session; no loss of gate or preview. Evidence remains fixed and scrolls internally. Launch selectors occupy separate lines while editing. |

At 24 rows, reserve two header rows, one coverage/error line, one footer and the
collapsed three-row launch strip. Use a seven-row evidence pane and give the list
the remaining ten rows, including its heading and group labels. At 40 rows grow
the list, not line spacing; the evidence pane can grow to ten rows. Opening the
composer takes its extra rows from the list; a popup temporarily overlays it.
At 80x24 the list cannot show all eight sessions at once; an explicit position
indicator and page keys make that limitation visible. Below 80 columns or 20 rows,
switch to a selected-row summary with evidence reachable and a resize hint; do not
shrink type. Below 60 columns or 16 rows, show the resize hint and quit control.
Full Unicode cell-width/grapheme behavior still needs implementation-level tests;
CSS clipping is not proof of terminal width correctness.

| Focus owner | Keys and behavior |
| --- | --- |
| Session list | Up/Down or j/k select; Home/End and PageUp/PageDown move within the list. Selection updates evidence without focus calls. Enter/a focuses once; d marks an eligible row done once. |
| Board navigation | `/` scope; 0 clears filters; `!` attention; w working; h history; `[`/`]` attention navigation; r restarts observations only; v inspects coverage/notices; n task; ? help; q quits. Escape closes the current local mode before returning to list. |
| Evidence | Tab from list enters the pane; 1/2/3 choose Message/Evidence/Context. Up/Down and page keys scroll. Enter/a focuses the selected live session; Escape returns to list. |
| Composer | Tab/Shift-Tab traverse task, topic, Where, Who, Review. Enter in task inserts a newline. All typed letters belong to the field. Escape suspends and retains the draft; no global lifecycle shortcuts run. |
| Popup / launch review | Focus is contained; search owns text. Up/Down choose, Enter accepts an enabled choice. Page keys scroll review text. Launch requires its own focused control. Escape returns to the invoker with task and choices intact. |

Refresh retains selection, scroll and focus by identity. Toggling history or scope
does not change the draft. Re-entering the board after focusing a live tab preserves
the selected row where it still exists. Terminal exit/editor restoration and signal
cleanup remain requirements from board UX; browser focus behavior cannot verify them.

## Empty and error states

| Condition | Visible explanation and next action |
| --- | --- |
| No accessible server | “Coverage unavailable; start or select Herdr, then refresh.” Show an explicit repository's offline snapshot when available. Keep the draft; disable launch and live focus. |
| Partial discovery | “1/2 local endpoints reachable” or “enumeration unavailable.” Retain reachable rows; inspect localized errors. Never call this the entire machine. |
| No sessions, repositories known | “No sessions in this snapshot.” Keep repository choices and the task strip. Discovery is not required to invent a facilitator. |
| Empty repository inventory | “No repositories discovered; enter an existing repository path or start its Herdr workspace.” A non-git session can still appear under Unknown repository. |
| Filters match nothing | State the active filters, with Clear filters. Keep the inventory, draft, global error and counts. |
| No repository / no routes | Explain the exact missing prerequisite by its control; disable Review. Preserve task/topic while choosing a valid repository or inspecting route configuration. |
| Message unavailable | Show reason/source separately from any raw excerpt. Do not relabel a shell prompt, approval request or footer as an assistant answer. |
| Focus refused | Keep selection and show “session unavailable or replaced; refresh and inspect.” Do not focus the next occupant or retry. |
| CLI refused before mutation | Show the CLI cause and known stage. Correct the input and submit explicitly; do not imply a lane exists. |
| Brief retained / editor cancelled | Show the CLI-reported draft path and inspection guidance. No lane was opened if cancellation occurred before open. |
| Open succeeded, dispatch failed | Show the retained lane/brief and an explicit inspection/dispatch step only when known unprompted. Never call lane new again automatically. |
| Delivery ambiguous / registration failed after delivery | State whether delivery is unknown or known successful, retain returned lane/agent/brief evidence and direct inspection. Do not offer a convenient resend button. |

The wireframe's outside-frame controls expose width, height, NO_COLOR, observation
states and launch outcomes. They are review apparatus, not proposed product menus.
Demo actions cannot establish real availability, validation, focus or dispatch.

## Bootstrap gap

An identity root can supply configuration and git conditional-include context; it
does not supply a canonical repository, main branch, validation or parent workspace.
Routes resolving there would not make it a valid lane destination.

| Option | Tradeoff |
| --- | --- |
| Root default repository | Fast for recurring work, but a hidden default can send arbitrary tasks to an unrelated project. Requires a separately specified config key, canonical resolution and a visible explicit target before launch. It is not in the present CLI contract. |
| Per-identity scratch repository | Useful for deliberate notes/experiments when an operator creates and configures it. Automatic creation would add repository bootstrapping, validation and workspace policy outside idea-cli's non-goals. A manually prepared scratch repo can use the ordinary picker. |
| Refuse launch with guidance | Preserves the explicit-repository contract and avoids guessing task scope. Allow typing and retain the draft; block only dispatch until a real repository is chosen. |

**Recommend refuse with guidance now.** At an identity root, show “Choose an
existing repository; this root is not a repository.” Offer discovered repositories
or an explicit path validated through the CLI. Do not silently choose the first
repository, use a temp directory, run git init, create a scratch repo or start a
facilitator. If no project is appropriate, tell the operator to create/configure
one explicitly, start its Herdr workspace, then return. A future visible root-default
preselection needs a separate proposal; it must still submit explicit `--repo`.
This preserves [idea-cli's non-goals](../../openspec/changes/idea-cli/proposal.md#impact)
and its [preflight](../../openspec/changes/idea-cli/design.md#cli-contract).

## Design doc changes

The following are concrete replacement paragraphs for a separate documentation
lane. OpenSpec files remain unchanged here. Keep dependency, isolation,
verification and split prerequisites unless explicitly called out below. Applying
these replacements also requires synchronizing the named scenarios and task briefs;
this review is not approval or evidence that those behaviors have shipped.

### board-ux/design.md — replace layout and key paragraphs under “UI and dependencies”

> Render a two-row header with title, active repository/history/view filters,
> reachable local-server coverage, last successful observation age and unique
> attention count. Keep connection errors visible separately from agent status and
> gate state. Group sessions by development root, canonical repository, then
> facilitator/lanes. Repository labels never substitute for canonical identity;
> preserve unknown-repository and unregistered rows. At 140 columns or wider reserve
> 22 columns for a scope rail. Below 140, use a keyboard scope picker and header
> filter label. The main view is an aligned session table with selection/attention,
> session/role, text state, exact short gate and first substantive message. Move
> provider, runtime, silence age and paths to evidence. At 80–99 columns use a
> second line for each message; at 100 columns and above use one line. Keep a fixed
> evidence pane below the table rather than an inline expansion or permanent right
> column. Message, Evidence and Context views expose the complete goal/provenance,
> brief path/excerpt, git state, full gate evidence, report/review applicability,
> deadline/tripwire, message source/freshness and unavailable-field reasons.

> At 24 rows reserve two header rows, one coverage/error line, one footer, a
> three-row composer slot and a seven-row evidence pane; the list uses the remaining
> ten rows including headings. Before idea-composer ships, the reserved composer
> slot is available to the list. At 40 rows let evidence grow to ten rows and give
> the additional space to the list. Scroll each region internally. Below 80 columns
> or 20 rows use a selected-row summary with evidence navigation and a resize hint;
> below 60 columns or 16 rows show a minimal resize/quit view. Never shrink type or
> horizontally scroll the core state/gate/message scan. Measure terminal display
> cells and preserve graphemes, stable row identity, selection and focus on resize.

> Arrows/j/k select; Home/End and page keys navigate the list. Selection immediately
> reveals evidence and never invokes a Herdr action. Enter invokes lane board focus
> exactly once for the selected verified live row; a remains its alias. d invokes
> lane board done only for eligible registered rows and never closes or stops work.
> Tab moves from list to evidence; 1/2/3 select its Message/Evidence/Context views,
> and scroll keys operate within it. / opens scope, ! toggles attention, w toggles
> working, h toggles history, 0 clears filters, [ and ] visit attention rows without
> sorting, r restarts observation only, v inspects coverage/notices, and ? opens help.
> q quits only from navigation. Escape cancels
> the innermost input/popup or returns to the list; it does not quit the board.
> Popups contain focus and restore their invoker on close. Text controls own all
> typing. Do not add check/promote/close actions or Command-key-only shortcuts.

### board-ux/design.md — replace the “State is text plus color” paragraph

> Encode status, gate, observation freshness, deadline and review applicability as
> independent text fields with optional colors: working cyan, blocked/current gate
> failure red, stale observation/gate amber, verified overdue magenta, idle/unknown
> neutral, and matching zero gate green. Distinguish Herdr done from registry/CLI
> completion using discovery's history rules. Preserve the historical exit/SHA of
> a stale gate; a review only describes its recorded reviewed commit. Missing gate,
> unavailable message and unknown applicability are explicit, never success.
> Attention includes blocked status, a current failed gate, a stale gate or
> observation, a verified elapsed deadline, a verified current non-pass review or
> an unknown agent state. Count each session once within repository/history scope
> before attention/working filters, explain every reason in detail, and surface
> discovery errors independently. Missing optional messages/gates, silence, dirty
> work-in-progress and historical reviews alone do not trigger attention. Do not
> reorder rows on updates. NO_COLOR suppresses ANSI colors and background accents;
> textual labels, > selection and ! attention remain legible. Document NO_COLOR.

### idea-composer/design.md — replace “Interaction” in full

> Keep a pinned task strip below the board; n from navigation focuses and expands
> it. Draft task, editable topic, repository and route live only in UI memory and
> survive selection, filtering and Escape. Task Enter inserts a newline. Suggest
> a valid topic until the operator edits it; require a visible nonempty valid topic
> before review. Tab/Shift-Tab traverse task, topic, Where, Who and Review launch;
> Enter in topic advances to Where. Text controls own d/q/n and all other typing.
> Escape closes the innermost popup or suspends composition without losing the draft.

> Where uses the CLI's canonical repository inventory, with root/path or identity
> suffixes to distinguish duplicate labels. An explicit path is validated through
> lane routes --repo --json and does not create a persistent catalog. Board scope
> changes never change the draft destination. Only a verified caller repository
> may prefill Where; without that anchor leave it unselected, even if discovery has
> results. Selecting a different repository
> clears Who, reloads its routes and requires a fresh choice even for a same-named
> route. Show route name, resolved kind/provider, model, effort and use note. Model
> and effort come from CLI resolution and recognized arguments, never the route
> name; distinguish known agent defaults from unknown values. Missing use is
> “no usage note.” Expose no environment secret values. No repository or no routes
> disables review with guidance while preserving the task. An identity root is not
> a repository and cannot dispatch; offer an existing repository or explicit path.
> Do not create repositories, select implicit scratch/default targets, or start a
> facilitator. Inaccessible Herdr blocks dispatch without discarding the draft.

> Review launch opens a focus-contained review showing the complete task, topic,
> canonical repository/root, worktree destination and selected route/use with
> resolved model/effort. Show unavailable destination data honestly and let the CLI
> preflight be authoritative; do not compute a competing configuration/identity
> resolver in the UI. Launch once and Edit then dispatch are explicit controls;
> Enter from task input never launches. Submit one frozen argument-array request to
> lane new, disabling repeated submit and target editing until that foreground
> invocation returns. Do not persist or resume it as a job. Success refreshes and
> selects the exact returned registered row without Herdr focus, revealing it if
> necessary under an active filter. If it has not appeared, show “launched; waiting
> for observation” using the returned identity rather than guessing by topic. A
> subsequent Enter focuses it. Report refusal, retained draft, known unprompted
> lane, ambiguous delivery and post-delivery registration failure distinctly, with
> CLI-provided paths/identifiers and explicit inspection guidance. Never replay,
> automatically retry, silently substitute a route, or delete retained work.

> Edit then dispatch invokes lane new --edit with inherited terminal input.
> Suspend/close the observation child, leave alternate screen and release raw mode
> before handoff. Restore the board and refresh only after the command exits.
> Editor cancellation preserves the CLI's draft and performs no dispatch. Present
> duplicate-brief recovery without overwrite. The UI writes no brief, reads no
> target files, runs no git command and opens no Herdr control connection directly.

### Companion specification work for the documentation lane

In board-ux's responsive scenario add 140x40, 100x24 and 80x24 cell budgets and
stable selection through filtering; retain the 40x12 limitation scenario. Add
attention counting, no-color independent indicators, drawer scrolling and
Escape-return acceptance. Update “all listed keys” and both split briefs for the
new keys/geometry; retain Enter focus and terminal cleanup requirements. Composer's
scenarios need multiline Enter, explicit topic/review, same-name route invalidation,
scope-independent drafts, root refusal, filtered success and distinct partial outcomes.

The present read contracts may not provide full gate metadata, brief excerpts,
canonical destination previews or a structured successful lane-new row identity.
Do not assume those fields exist or fill them by direct UI I/O. The documentation
lane must audit the CLI schemas and specify bounded read/result additions in the
owning changes where needed. Until then show unavailable fields and a pending
observation result honestly. Route effort display likewise needs a documented
recognized-argument projection or a CLI field, not guessed model defaults.

## Verification and limits

Reviewed the original HTML source and the local reference image. No browser was
available from the browser runtime, so rendered layout, browser keyboard behavior,
screen-reader behavior and real Ink/Herdr input remain unverified. Width/height
figures above are design budgets, not measured terminal results. The wireframe
provides manual controls for inspecting them in a browser.

The initial read-only load probe found other test-related processes; no build,
test suite, package install, OpenSpec validation or lane check was run for this
documentation-only task. No product behavior or tests changed, so no product
negative control was applicable. Source syntax, whitespace, public-text and scope
checks are recorded in the dated handoff. Actual message extraction, CLI return
schemas, discovery coverage, terminal teardown, editor handoff, Unicode width and
100-session responsiveness still require their implementation lanes' verification.
