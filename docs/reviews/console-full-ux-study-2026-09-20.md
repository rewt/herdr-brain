# Independent operator UX study — live Projects trial

Date: 2026-09-20. Reviewer: independent operator agent. Checkout: `lane/console-autonomy`.

## Verdict and method

**Baseline: needs work.** The console reads real project and session data and several individual routes work, but the operator cannot yet rely on its keyboard model, scope switching, or session presentation. Passing route tests did not establish usability. The strongest issues are traversal cost, loss of context during scope changes, and the mismatch between a terminal-looking transcript and an actual harness terminal.

**Final verdict: pass for the observed read-only trial missions, with the explicit host and workflow limits below.** Navigation, scope selection, goal relationships, compact overview, honest action availability, styled terminal/transcript switching, and local native-viewport panning were independently retested after repair. All observed implementation defects raised in this study were repaired; durable linkage for unassigned sessions is still a backend/workflow gap, and actual native-host handoff remains untested. This is not a blanket production-readiness or human-usability certification.

This was a task-based expert walkthrough, not a user research panel. The baseline was source-blind: the reviewer read AGENTS.md and the Herdr skill, then launched the real Ink app in a PTY, issued keys to that app, and inspected its rendered terminal frames. Production source was opened only after baseline findings had been sent to the implementer. The reviewer did not edit production code.

The entry was `node bin/org.mjs console --modern --project bch-cloak`. Captures cover 140×43, 100×35, and 80×25. Actual ANSI output was replayed through xterm in Chromium for screenshots; this was not an HTML mockup substituted for the app. The operator agent observed both screenshots and terminal text. The live data changed during the study (for example, 135 became 136 needs), so counts are evidence of a particular moment, not assertions about durable totals.

Read-only boundaries: no org/config writes, agent messages, native focus changes, dispatch, project registration, or creation of actual work. Temporary study files and an empty `/private/tmp` directory were created. `HERDR_ENV=1` was checked before live inspection. A failure-state experiment replaced the study process's Herdr binary with `/usr/bin/false`; the running Herdr service was untouched.

## Operator missions

| Mission | Baseline result | Operator consequence |
| --- | --- | --- |
| Open a project and identify active work and its purpose | Partial | The wide overview connects two current sessions to goals/tasks. Several other sessions are honestly Unlinked, but the overview does not explain what is missing. |
| Move from checkout navigation into work using only keyboard | Fail | Tab visits each worktree and other controls rather than moving between sections. Left/Right do not operate the main view tabs. |
| Switch scope, compare projects, and return to the previous context | Partial | Selection works, but opening the switcher replaces the main view; Back after switching visits that switcher instead of immediately returning to the prior goal. |
| Find the active session contributing to a goal | Partial | G-8 has a live link, buried below substantial notes; the first goal has unlabeled empty relationship sections. |
| Understand a working session before reading its output | Partial | Identity, Git, harness, task, and output blend together; purpose appears late and the transcript resembles an interactive harness prompt. |
| Return from session output to the session list | Pass | Escape returned to the list. Earlier/later transcript navigation responded. |
| Keep project awareness when the terminal is narrow | Partial | No observed line overflow, but tasks and decisions disappear below the initial viewport while many goals remain visible. |
| Inspect a folder with no organization | Partial / retest required | Honest setup limitations were visible and no project files were created. Later picker experiments overlapped implementation edits and are not valid final results. |
| Explain host failure instead of fabricating healthy session state | Pass with reservations | A connection issue and retry hint appeared, with unavailable-session text. The zero count still needs to be visually subordinate to the unavailable label. |

## Findings and concrete acceptance criteria

### UX-01 — Tab order is a flat list, not a pane model

**High · observed interaction bug.** Repro: launch the overview and press Tab repeatedly. The sixth Tab highlights a lower worktree; the twelfth is Refresh; the nineteenth reaches the first session's goal link. The screenshot sequence preserves the actual highlight. A growing worktree list increases the keyboard cost of reaching the central work.

Acceptance: Tab/Shift+Tab visit stable regions, independent of row count. Within the checkout region, Up/Down move between checkouts. From any checkout, one Tab moves into the next region, and Shift+Tab returns to the previous region's remembered selection. Focus must remain visible after scrolling/resizing. Region focus and selected route must have distinct visual indications.

Evidence: `.lane/ux-study/baseline-tab-{01..19}-140x43.{ansi,json,png,txt}`.

### UX-02 — The horizontal view tabs have no horizontal keyboard behavior

**High · observed interaction bug.** Repro: use `h`, then Right/Left on Overview. The view and tab selection do not change. Mouse interaction and the `g`/`t` shortcuts offer workarounds, but the visible tab strip implies a conventional arrow-key model that is absent.

Acceptance: Left/Right operate the Overview/Goals/Tasks/Needs-you tab strip with a documented focus rule. The implementation must not steal horizontal keys from a text field, picker, or a horizontally scrollable terminal. Enter/Space behavior and activation-on-arrow should be consistent, with visible focus.

Evidence: `baseline-home`, `baseline-right`, `baseline-left` captures.

### UX-03 — Scope switching replaces the work instead of opening a local selector

**High · observed navigation/design mismatch.** Repro: open G-8, press `p`. The main panel becomes Project/Projects, while its surrounding tabs still describe the old scope. Selecting Herdr Brain works; Escape returns to the old project's Projects screen. This adds an incidental navigation step and makes comparing projects feel like leaving the work.

Acceptance: the project control opens an anchored, bounded selector over the existing view. Up/Down choose, typing filters, Enter commits, and Escape dismisses without changing view, selection, or scroll. Clicking outside dismisses. A committed project change should preserve an intelligible Back route to the previous context. Zero matches, long names, and many projects must remain usable at 80 columns.

Evidence: `baseline-project-picker`, `mission-switch-project`, `mission-scope-back` captures.

### UX-04 — Session purpose and terminal output have no clear boundary

**High · observed presentation problem.** Repro: `s`, Enter on the first working session. The view begins with branch/Git status, native-open control, pane ID, session label, activity, harness/version/state/cwd, and finally the goal/task line. Log text starts immediately afterward. A Codex prompt and “esc to interrupt” instruction appear inside the read-only transcript, even though Escape actually navigates this console. Uniform recoloring also removes familiar harness emphasis.

Acceptance: a compact Work section leads with the recorded goal, task, and useful summary; a separate Session section shows identity/state/location; a visibly bounded Terminal section states whether it is read-only or interactive. Harness prompt/key instructions must never imply that input is sent when it is not. The terminal view should preserve supported styling and cell layout from the exact selected pane, or clearly label itself a transcript and provide an explicit native-terminal handoff. Native handoff must validate current pane identity. ANSI text alone must not be described as an embedded interactive PTY.

Evidence: `.lane/ux-study/baseline-output-140x43.png` and its ANSI/text recording. Actual native focus and return were deliberately untested in this study.

### UX-05 — Empty success criteria and array serialization are exposed as UI

**Medium · observed data presentation bug.** Repro: `g`, Enter on G-2. The view prints `Success:` with no content. Open G-8 instead: multiple criteria are concatenated into one paragraph with `.,The`/`.,An` boundaries. An absent field looks like a failure to load, while populated criteria are harder to scan.

Acceptance: absent criteria receive an explicit, brief empty state such as “Success criteria not recorded.” Multiple criteria render as separate readable items. The UI distinguishes missing data from a connection failure; it does not invent criteria.

Evidence: `baseline-goal-detail-140x43`, `mission-active-goal-140x43`.

### UX-06 — Active goal/session relationships are buried or ambiguously empty

**High · observed information hierarchy issue, with data limitations.** Repro: open G-8. Its current working session appears near row 34 after criteria, historical prose, and related tasks; at smaller sizes it is offscreen. The direct tasks list omits ARCH-126, although the active session correctly links G-8 › ARCH-126 through recorded ancestry. G-2 shows empty Related tasks and Related sessions headings. These are different situations but look equally incomplete.

Acceptance: show current linked sessions near the top, with a count, goal/task link, current state, and direct drill-down. Distinguish current sessions from prior recorded work. Include relevant descendant tasks via the recorded graph, with understandable grouping. Empty sections state what is absent. G-2 must not acquire G-8's sessions merely because both are visible: the observed goals are siblings under G-1, not evidence of a G-2 → G-8 link.

Evidence: `mission-active-goal-140x43`, `baseline-goal-detail-80x25`. “Unlinked” sessions are not themselves a UI mapping bug; their durable relationship must be recorded before the UI can claim a task/goal association.

### UX-07 — Narrow overview loses its single-screen purpose

**Medium · observed responsive information-priority issue.** Repro: resize the overview to 100×35 or 80×25. At 100 columns the first task appears at the bottom of the viewport and Needs you is absent. At 80 columns three of eight sessions and eight goals fill the body; all tasks and decisions are below the fold. The footer indicates scrolling, but the initial screen no longer answers the user's combined “goals, tasks, agents, attention” question.

Acceptance: all four sections retain at least a summary/count and one useful route in the initial compact viewport. Avoid spending eight rows on goals while hiding every task and decision. Use a deliberate compact budget, shortened lists, and “View all” controls. Section grouping and priority cues must survive resize.

Evidence: `baseline-overview-100x35.png`, `baseline-overview-80x25.png`.

### UX-08 — A second persistent checkout sidebar competes with Herdr

**Medium · host integration design issue; full host composition untested.** The Ink captures show a full-width persistent project/checkout tree. The user reports that it competes with Herdr's native spaces/agents sidebar. The reviewer did not capture or focus the host UI, so the combined double-sidebar experience is based on the user's observation plus the observed inner rail, not a newly witnessed host screenshot.

Acceptance: define ownership explicitly. Herdr owns native spaces/agents and the actual terminal. The plugin owns project intent, tasks, decisions, and their relationship to sessions. Inside Herdr, use a compact project control and on-demand checkout inspector; retain a useful standalone option. Hiding the duplicate rail must not remove access to checkout/Git context or make project scope depend on currently focused native work.

### UX-09 — Enabled-looking actions promise unavailable behavior

**Medium · observed affordance mismatch.** `Instruct`, `+ Chat`, and `+ Goal` are displayed like normal actions in a read-only trial. A read-only footer/help screen does not adequately explain the outcome of each action before it is attempted. This particularly affects a newcomer who has ideas but no goals or agents.

Acceptance: an unavailable action is visibly marked before activation, with a specific explanation and a useful existing route where possible. Fresh onboarding offers an honest next step: inspect an existing folder/open Herdr space, or create/capture an idea once that durable path exists. Do not label an explanatory page as successful project/chat creation. No silent folder registration or agent dispatch should occur.

### UX-10 — Missing relationship records prevent the promised goal-to-session view

**Medium · data/workflow gap, not a reason to guess UI links.** The wide live overview showed eight sessions but only two current goal/task links. Herdr Brain's current console-development session was Unlinked despite its recognizable label. The trial correctly avoids deriving authority from names, but the operator still cannot answer what every active session contributes to.

Acceptance: session launch/dispatch records explicit project/task/run identity, and the UI explains “No current task recorded” separately from past work, lost connection, or a deliberately free-form conversation. Backlog review can propose reconciliation, but session titles and cwd must not silently authorize work or assign goals. The daily review design should surface these gaps as actionable proposals rather than manufacture associations.

### UX-11 — Help is unavailable through the advertised wrapper

**Low · observed CLI discoverability bug.** `node bin/org.mjs console --modern --help` exits with “Unknown option '--help'”; `node console/app.mjs --help` succeeds. The in-app `?` help does work.

Acceptance: the documented entrypoint accepts `--help` and prints the relevant launch/key help without requiring project setup or a live host.

### UX-12 — Live terminal styling is repaired, but the observation window silently crops old top rows

**High · observed during final repair retest.** The new styled view preserves Codex colors, green diff background, syntax emphasis, and indentation. However, opening the working ARCH-126 session at 140×43 shows diff lines 1107–1130. Switching to plain transcript immediately reveals later lines through 1165, subsequent commands, Working, and the prompt. Returning to Live screen again shows 1107–1130. At 80×25 it shows only 1107–1111. “0s ago” suggests current state, but there is no visible explanation that most of the native viewport is outside the panel.

Acceptance: default to the part of the native viewport containing current activity/prompt (normally bottom alignment), preserve cell layout, and explain the cropped viewport with its dimensions or visible-row range. A read-only pan/full-screen route should make the rest discoverable without resizing or sending input to the actual agent. If terminal rows are omitted, freshness must not imply that the visible fragment is all current activity.

Evidence: `final-live-screen-140x43.png`, `final-live-screen-80x25.png`, `final-screen-return-140x43.png`, `final-transcript-140x43.png`. The native terminal was not focused or resized by this review.

## Study limitations and evidence integrity

- The study did not control native Herdr focus, test the physical mouse back button, inject input into a live harness, or install/open a plugin-owned tab. These require a separately controlled host interaction check.
- Recorded SGR mouse handling or unit tests cannot establish physical mouse delivery through every terminal/Herdr combination.
- The baseline captured live data, not deliberately fabricated goal/session links. Counts and agent states naturally changed between missions.
- An initial “empty folder” created under this repository correctly inherited its Git identity and showed this repository's sessions. That is not evidence of a non-Git onboarding failure. The non-Git experiment was then moved to `/private/tmp`.
- Later fresh-folder/picker experiments ran while the implementer was changing modal handling. Their apparent invisible picker and quit timeout are **not accepted as baseline defects**: the process had new picker state handling with the old frame presentation. They must be rerun after integration. The harness killed only its own app child after a timeout; it did not stop Herdr or other agents.
- This report evaluates observable UX. It is not a complete accessibility audit or evidence that a group of novice human operators will succeed.

## Repeatable operator review recommendation

Keep this as a separate operator role with explicit outcome missions, not a second implementation test suite. The operator should start from the documented launch command, avoid implementation source until the first findings are recorded, and prove what it saw with terminal frames. At each significant UI change, repeat the mission set across a busy project, a sparse project, a non-Git folder, and an unavailable host, at compact and wide sizes. Use recorded/fake transport data for destructive or timing scenarios and reserve real sessions for read-only confidence checks.

Judge whether the operator can answer a question, not merely whether a route rendered: “What is running for this goal?”, “What needs my decision?”, “Where is this checkout?”, and “How do I return to the previous context?” Record wrong turns, ambiguous labels, input count where meaningful, hidden information, and recovery. A green result must list untested boundaries explicitly. For a live-data UI, visual comparison should focus on hierarchy, focus visibility, clipping, boundaries, and link correctness rather than exact volatile text.

Backlog grooming is a separate workstream. A daily review can use the same project overview to identify unlinked sessions, missing goal criteria, blocked high-priority tasks, and conflicting records. Those are proposals to reconcile durable state, not permission for the UX reviewer or display metadata to schedule work.

## Retest status

Fresh-PTY retest of the integrated navigation/goal/compact-layout repairs is complete for the cases below. A subsequent fresh-process terminal retest verified the styled read-only screen and found the cropping issue recorded as UX-12; it was sent to the implementer before final acceptance.

| Finding / mission | Independent retest |
| --- | --- |
| UX-01 region traversal | One Tab from a selected checkout moves to the central view tabs; Shift+Tab restores that checkout selection. Up/Down in Sessions move actual rows. Overview Tab moves between sections. Evidence: `nav2-*`. |
| UX-02 horizontal tabs | Right changed Overview to Goals; Left returned to Overview. |
| UX-03 scope selector | `p` overlays the existing G-8 view. Escape and click outside dismissed it without route change. Choosing Herdr Brain then Back returned directly to G-8. |
| Back/Forward | Injected SGR back/forward buttons navigated G-8 → Goals → G-8. This establishes app handling, not physical mouse delivery through a host. |
| UX-05 criteria | G-2 explicitly reports missing success criteria. G-8 displays three numbered criteria instead of a comma-joined paragraph. |
| UX-06 relationships | G-8's current linked session is now above criteria/notes; its related active tasks include descendant ARCH-126. |
| UX-07 compact overview | At 80×25, Sessions, Goals, Tasks, and Needs you all appear in the initial viewport. At 100×35, the two-column overview retains decisions visibly. |
| UX-08 host rail | Rail is hidden by default under HERDR_ENV=1; `w` reveals/hides the on-demand checkouts. The surrounding native sidebar is still untested. |
| UX-09 unavailable actions | Instruct/+Chat/+Goal no longer appear enabled; header states Read only. Fresh folder explicitly explains that project setup and chat creation are not connected. |
| Fresh non-Git folder | Shows zero sessions/checkouts and no connected organization, with a concrete Herdr route. Picker opens/dismisses, and app quits cleanly. Folder remains empty. |
| Host failure | An unavailable-host experiment still displays a connection issue/retry hint. Picker dismisses and app quits cleanly; no host process was altered. |

A further **medium scope regression** was discovered independently: on G-8 detail, `p`, Enter (the already-current bch-cloak selection) resets the route to Overview. Reselecting the same scope should only dismiss the selector, retaining route, scroll, and focus. Evidence: `scope-same-before-140x43.png` and `scope-same-after-140x43.png`; reported to the implementer and **repaired/retested**: `final-goal-before-scope` and `final-goal-after-scope` both remain G-8.

Two minor retest findings were sent back promptly: (1) a project filter with no match shows Open folder/Start with an idea but no explicit “No matching projects” explanation; (2) at 100×35 the footer combines `PgDn mRead only` as shortcut text overlaps status, and at 80×25 clips `PgDn mo…`. Both were **repaired/retested**: the filter now says “No matching projects,” and the compact footer no longer overlaps status. These were presentation/discoverability issues, not evidence that scope switching or scrolling failed.

The final fresh PTY also verified `org console --modern --help`, `l` to plain transcript, `v` to styled live screen, PageUp into transcript, `v` back to screen, Escape back to Sessions, resize to 100×35 and 80×25, and normal quit/terminal cleanup. The Work context card now leads with the recorded goal, task/run, and summary. A separate Live screen header states read only, and the native-open instruction explicitly says this view does not accept agent input. No native handoff was invoked. The raw-screen cropping finding was subsequently **repaired and independently retested** as detailed below.

Fresh retest evidence: `retest-*.{ansi,json,png,txt}`, `retest-events.json`, `retest-fresh-folder-*`, and `retest-fresh-error-*`. The complete scripts are `retest-pty.py`, `empty-pty.py`, and `error-pty.py`. The contaminated mid-edit experiments described above were superseded by clean fresh-process runs.

Evidence lives under `.lane/ux-study/`: baseline and mission PTY scripts, ANSI recordings, dimension-aware replay JSON, xterm PNG captures, and text projections. `baseline-events.json` records the baseline sequence and clean terminal exit. `mission-events.json` records the goal/project/decision/help walkthrough. `render-pty.mjs` renders the actual terminal output; it does not implement a replacement UI.


### Final native-viewport retest

A new process observed the same live Codex pane without sending input or changing native focus. The app reported **Native 177×79** across all three console sizes, while only its local viewport changed:

| Console size/action | Observed viewport | Result |
| --- | --- | --- |
| 140×43 | Rows 56–79, columns 1–134, bottom | Current commands, Working indicator, prompt, and harness footer visible with native styling. |
| Shift+Up | Rows 53–76, panned | Local three-row pan; clear position cue. |
| Shift+Down | Rows 56–79, bottom | Prompt and latest area restored. |
| Shift+Right / Left | Columns 13–146 / 1–134 | Horizontal local pan and return; native dimensions remain 177×79. |
| 100×35 | Rows 65–79, columns 1–94, bottom | Working indicator and prompt visible. |
| 80×25 | Rows 75–79, columns 1–74, bottom | Prompt visible; cropped area explicitly identified. |
| Shift+Up / Down at 80×25 | Rows 72–76 / 75–79 | Working indicator discoverable above prompt; return to bottom works. |
| `l`, then `v`, then Escape | Transcript → styled screen → Sessions | Correct route and mode changes. Normal exit and terminal cleanup passed. |

Evidence: `crop-pty.py`, `crop-events.json`, and `crop-*.{ansi,json,png,txt}`. `crop-native-bottom-140x43.png` is a useful final visual reference because it shows both the work context and native Codex formatting, including diff colors and prompt treatment.

At 80×25, only five native-screen rows fit under the context and controls. This is now accurately disclosed and navigable, rather than a silent stale-looking fragment. An optional expanded-terminal/collapsed-context view would be a useful later improvement; it is not required to establish that the repaired crop is honest and functional.

Final remaining boundaries: actual plugin installation/tab lifecycle, native `o` handoff and return, physical mouse routing through the host, broad harness compatibility beyond this observed Codex session, and a human novice study. The console still cannot create the missing durable task/run links, onboard/dispatch fresh work, or groom the backlog merely by displaying it. Those need their own implementation and evaluation.
