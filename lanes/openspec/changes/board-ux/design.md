# Design: Build the fullscreen keyboard board

## UI and dependencies

Discovery supplies grouped rows, machine coverage and --all filtering; messages
supplies substantive previews. Both must be promoted. The focus/done and UI process
boundary arrive through discovery's board-actions (2b-ii) prerequisite.

Use Ink 5/React 18 plus @inkjs/ui, selecting a pinned release compatible with Node 20.
The reviewed upstream @inkjs/ui manifest reports 2.0.0, Node >=18 and Ink >=5;
verify its published package/lockfile at implementation, since moving branches are
not a lock. Keep plain .mjs/React.createElement; do not reintroduce tsx/esbuild or a
root install. Use the official components for selections, input and status where
they fit; bespoke layout uses Ink Box/Text.

Render a two-row header with title, active repository/history/view filters,
reachable local-server coverage, last successful observation age and unique
attention count. Keep connection errors visible separately from agent status and
gate state. Group sessions by development root, canonical repository, then
facilitator/lanes. Repository labels never substitute for canonical identity;
preserve unknown-repository and unregistered rows. At 140 columns or wider reserve
22 columns for a scope rail. Below 140, use a keyboard scope picker and header
filter label. The main view is an aligned session table with selection/attention,
session/role, text state, exact short gate and first substantive message. Move
provider, runtime, silence age and paths to evidence. At 80–99 columns use a
second line for each message; at 100 columns and above use one line. Keep a fixed
evidence pane below the table rather than an inline expansion or permanent right
column. Message, Evidence and Context views expose the complete goal/provenance,
brief path/excerpt, git state, full gate evidence, report/review applicability,
deadline/tripwire, message source/freshness and unavailable-field reasons.

At 24 rows reserve two header rows, one coverage/error line, one footer, a
three-row composer slot and a seven-row evidence pane; the list uses the remaining
ten rows including headings. Before idea-composer ships, the reserved composer
slot is available to the list. At 40 rows let evidence grow to ten rows and give
the additional space to the list. Scroll each region internally. Below 80 columns
or 20 rows use a selected-row summary with evidence navigation and a resize hint;
below 60 columns or 16 rows show a minimal resize/quit view. Never shrink type or
horizontally scroll the core state/gate/message scan. Measure terminal display
cells and preserve graphemes, stable row identity, selection and focus on resize.

Arrows/j/k select; Home/End and page keys navigate the list. Selection immediately
reveals evidence and never invokes a Herdr action. Enter invokes lane board focus
exactly once for the selected verified live row; a remains its alias. d invokes
lane board done only for eligible registered rows and never closes or stops work.
Tab moves from list to evidence; 1/2/3 select its Message/Evidence/Context views,
and scroll keys operate within it. / opens scope, ! toggles attention, w toggles
working, h toggles history, 0 clears filters, [ and ] visit attention rows without
sorting, r restarts observation only, v inspects coverage/notices, and ? opens help.
q quits only from navigation. Escape cancels the innermost input/popup or returns
to the list; it does not quit the board. Popups contain focus and restore their
invoker on close. Text controls own all typing. Do not add check/promote/close
actions or Command-key-only shortcuts.

Encode status, gate, observation freshness, deadline and review applicability as
independent text fields with optional colors: working cyan, blocked/current gate
failure red, stale observation/gate amber, verified overdue magenta, idle/unknown
neutral, and matching zero gate green. Distinguish Herdr done from registry/CLI
completion using discovery's history rules. Preserve the historical exit/SHA of
a stale gate; a review only describes its recorded reviewed commit. Missing gate,
unavailable message and unknown applicability are explicit, never success.
Attention includes blocked status, a current failed gate, a stale gate or
observation, a verified elapsed deadline, a verified current non-pass review or
an unknown agent state. Count each session once within repository/history scope
before attention/working filters, explain every reason in detail, and surface
discovery errors independently. Missing optional messages/gates, silence, dirty
work-in-progress and historical reviews alone do not trigger attention. Do not
reorder rows on updates. NO_COLOR suppresses ANSI colors and background accents;
textual labels, > selection and ! attention remain legible. Document NO_COLOR.

Enter alternate screen once on startup. Restore previous screen, cursor, raw mode,
and observers on normal exit, Ctrl-C, SIGTERM, render failure, and editor handoff.
Ink 5 fullscreen/alternate-screen capability must be verified locally; use a tiny
UI-only lifecycle wrapper if needed, not a major Ink upgrade. No mouse modes yet.

Schema audit: board-cli's v1 schema already supplies `brief {path, excerpt}` and
repository canonical path plus resolved lane destination base. Its gate only has
state, head, exit_code and signal: **needs field (board-cli)** for recorded gate
command, observation time and duration before Evidence can claim full gate metadata.
Do not substitute UI reads for unavailable data.

## Verification and risks

Keep npm test dependency-free using built-ins-only state/width/process-boundary
fixtures and an injected UI-command adapter. A separately serialized optional
npm --prefix board ci plus real-TTY smoke verifies rendering and key sequences;
it is not a root test prerequisite. Report installation size/dependency count and
compare with the previous 41-package/22 MB recorded board baseline.
Do not claim real terminal input, terminal restoration, or Linux behavior from a
string rendering test. Preserve process teardown and responsiveness budgets.

## Pre-agreed split point

Choose combined delivery or this exact split at dispatch, before implementation.
The split needs no new product decision. If the combined scope will exceed one
focused session, use these boundaries:

| Subphase / topic | Scope and required acceptance | Depends on |
| --- | --- | --- |
| 3a-i / board-frame | Alternate-screen header/list/fixed evidence panel/footer, 140x40, 100x24 and 80x24 geometry, Unicode clipping, stable selection through filtering, Enter focus, NO_COLOR independent text indicators, all navigation/filter/attention/evidence keys, and terminal/observer teardown. Own Fullscreen responsive board, One-action keyboard focus, and Terminal and dependency isolation. Retain the 40x12 limitation and test resize, Escape return and exit paths. | board-discovery (2c), board-messages (2d); approved A4; may start before board-messages promotes if it displays unavailable message evidence honestly |
| 3a-ii / board-details | Complete goal/brief/report/message detail content and scrollable Message/Evidence/Context views, @inkjs/ui component adoption for selectors/status, upgrade the frame's simple repository/history controls to those components, and all state badges/colors. Own Complete session details plus the final component/dependency-footprint checks. Verify simultaneous working/overdue/stale/failed indicators, input focus, evidence scrolling, expanded details and the isolated install/TTY smoke. | board-frame (3a-i) |

When activated, partition complete requirement blocks into those two OpenSpec
changes and one dispatchable brief each before writing code. Each gets a
`docs/reports/<topic>.md` report, tests and post-commit check. The frame uses Ink/
React with simple controls first; complete details and @inkjs/ui adoption follow
in board-details. Full UX acceptance, idea-composer, and optional mouse research
wait for board-details to promote. Do not sync unfinished detail requirements or
mark the original combined task complete after shipping the frame alone.
