# Independent operator review — 2026-09-19

Review target: `http://127.0.0.1:8765/modern-console-preview.html`.

This review starts from the requested operator outcomes. The reviewer has not read implementation, tests, or prior design documents. Acceptance criteria were recorded before receiving execution evidence. No production org or Herdr state may be changed, and no messages may be sent to actual agents.

## Evidence and verdict

**Latest verdict: targeted preview fixes pass independent retest.** IR-1 and IR-2 are resolved in the tested interactions. Draft editing, repeated-navigation recovery, keyboard focus restoration, a new-worktree preview, and the final browser-Back dialog checks also passed. This is a source-blind simulated operator review, not human usability validation or approval of live integrations.

**Baseline verdict: requires fixes.** The independent preview run supports the main navigation and creation routes, but deferring a decision removes its recovery path, and an empty instruction receives no validation feedback. Live integrations, backend failures, and human comprehension remain unvalidated.

The initial browser connection and Computer Use native pipe failed. The parent recovered with isolated headless Chromium. The reviewer then independently operated a fresh browser context through accessible controls, visible text, screenshots, and keys, without reading application source, tests, hidden state, or design documents. The only setup source read was the parent's five-line browser launcher. This browser had no production sessions.

The run started on the live preview immediately before the parent froze `operator-baseline.html`. The parent reports the frozen copy was byte-identical to the loaded page. The reviewer did not reload during the baseline run. Evidence is in `.lane/operator-simulation/independent/`: `actions.jsonl`, numbered PNGs, and matching accessibility snapshots. Viewport: 1280 × 900. All mutations were explicitly labeled preview actions. The screenshots numbered 000–054 preserve the pre-fix evidence.

A control's presence, a successful test assertion, or a handler returning without an exception is insufficient to establish an operator outcome. The matrix below preserves the criteria and initial statuses recorded before execution; current results follow it.

## Pre-execution mission and acceptance matrix

| ID | Operator mission | Observable pass | Observable failure | Result |
| --- | --- | --- | --- | --- |
| O1 | Understand the project on entry | The visible screen identifies the current project and lets an operator distinguish its goals, tasks, and sessions. Counts, empty states, and labels agree with the displayed items. | Current project or item types are ambiguous; a heading implies data the screen does not show; an unexplained empty region looks like loading or failure. | NOT TESTED |
| O2 | Determine which session is working on a task | From a task, the operator can identify its associated session and distinguish working, finished, and unavailable states. Multiple or absent sessions are represented clearly. | Association depends on guessing from names, timestamps, or placement; a selected row looks active; an old or missing session is presented as currently working. | NOT TESTED |
| O3 | Open the exact session output | An action reached from the task opens the selected session's identifiable output. The view carries enough identity to confirm the target and distinguishes output from input or a preview. | A generic console opens; another session is selected; output is static but presented as live; the operator cannot confirm whose output is shown. | NOT TESTED |
| O4 | Return using Back | Back returns from output to the prior task/project context with a sensible selection and scroll position. Repeating the trip does not accumulate confusing navigation states. | Back exits unexpectedly, opens another project, loses the task, or gets trapped in a loop. | NOT TESTED |
| O5 | Switch project | A discoverable project control switches the visible project identity and all relevant goals, tasks, sessions, and decisions. An empty project is understandable. | Old project content remains under the new heading; output targets leak across projects; the current project cannot be determined. | NOT TESTED |
| O6 | Find a pending decision | The operator can discover that a decision needs attention, open it, and understand the question, relevant project/task context, and available responses. | Pending work is hidden behind an unexplained count; the question or response consequences are missing; resolved items appear unanswered. | NOT TESTED |
| O7 | Answer a decision | After responding, the UI acknowledges the selected answer and updates pending state consistently. A repeat click has a clear, non-duplicating outcome. | Submission silently disappears, remains ambiguously pending, records a different answer, or appears to submit twice. | NOT TESTED |
| O8 | Add a goal | A discoverable action accepts a plainly written goal, indicates required information, and shows the new goal in the intended project after success. Invalid input has a recoverable explanation. | Entry requires undocumented syntax; the goal appears in another project, is duplicated, or is lost without explanation. | NOT TESTED |
| O9 | Reprioritize a goal | The operator can change priority, see the resulting order or priority value, and verify it after leaving and returning. Boundary actions behave clearly. | Controls change a different goal; visual order and priority disagree; the change silently resets or cannot be checked. | NOT TESTED |
| O10 | Start a conversation on main | Before starting, the operator can identify the project and main destination. On success, the new conversation is visibly associated with that destination and can be opened. | Target is hidden or ambiguous; another branch/worktree is used; success does not lead to a findable session. | NOT TESTED |
| O11 | Start development in a worktree | The operator can choose development separately from main, understand the worktree destination, start once, and find the resulting session with its destination identified. | Main and development choices are indistinguishable; worktree creation or session location is opaque; retry creates unnoticed duplicates. | NOT TESTED |
| O12 | Cancel before committing an action | Cancelling each creation/response dialog returns to useful context without a success message or visible new item. Reopening behaves predictably. | Cancel submits, creates an item, strands the operator, or leaves stale loading state. Absence of backend side effects requires separate evidence. | NOT TESTED |
| O13 | Recover from an error | A controlled failure yields a visible, specific explanation and a usable retry or exit. Valuable input survives when practical; retry can be distinguished from an already completed action. | A spinner never ends; an exception is the only feedback; the form closes and loses input; retry repeats an action whose success was merely unacknowledged. | NOT TESTED |

“Back” in O4 means the control an operator naturally uses in the tested environment. Evidence must state whether it was an in-app Back control, browser Back, or both; one does not prove the other.

## Evidence needed

For each mission, capture the starting screen, the visible action target, the action, and the resulting screen at a stated viewport. Keep stable project/task/session identities in the evidence so the chosen target can be compared with the result. Record any instruction or hint given to the operator; a hinted success does not establish discoverability.

For actions that change data, use an isolated fixture and provide the resulting fixture state or action log alongside the UI. A screenshot can establish feedback, but cannot establish exactly-once delivery, persistence, worktree isolation, or absence of side effects. Demonstrate those claims separately. Never use actual production messages or state changes as review probes.

For cancellation and failure, include an attempted submission, a deliberate cancel or controlled failure, and the return/retry result. A happy-path demonstration does not cover these cases. Any fixture-only behavior must remain clearly identified as simulated.

## Reporting standard

Findings require an observed action and consequence, with expected behavior tied to a mission above. Classify blocked core work or a wrong destination as high severity; misleading state, repeated lost input, or an avoidable detour as medium severity; and minor presentation friction as low severity. Proposed improvements are hypotheses until exercised. Do not report environmental tool failures as application defects.

## What simulation can and cannot establish

- Visible interaction replay can establish whether controls expose the expected states, navigation reaches the selected identity, and controlled fixture changes produce consistent feedback.
- An independent simulated operator can identify ambiguous labels, hidden paths, excess steps, and inconsistent screens without consulting the implementation. These remain reviewer judgments, not measured human performance.
- A scripted route supplied by the developer establishes route execution, not independent discovery. Prior hints and screenshots can also teach a route, so later success must not be described as a first-use result.
- Fixture-backed success cannot establish real CLI, Herdr, process, model, worktree, durability, or multi-user behavior. Those integrations need separate, safely scoped validation.
- Human comprehension, perceived confidence, first-use completion time, error rate, and accessibility with assistive technology require representative human or assistive-technology testing. No claim about them follows from this simulation alone.

## Execution record

The reviewer chose the entry, task, output, project, decision, goal, and session routes from the visible UI. The parent later reported an empty-instruction problem; that case was independently reproduced afterward and is a confirmation, not an independently discovered route. The reviewer received no implementation details.

| Mission | Baseline result | Observed evidence and limits |
| --- | --- | --- |
| O1 — Entry orientation | PASS within fixture | 000 shows bch-cloak, separate session/goal/task regions, linked task counts, state labels, and a sample disclosure. Human comprehension is not measured. |
| O2 — Task/session association | PASS for sampled associations | 001 links ENG-116 to an idle named session; 015 links ARCH-4 to working session `1`. 008 explicitly says no verified session link for ENG-89. Multiple sessions on one task were NOT TESTED. |
| O3 — Exact output | PASS for captured target identity; partial content coverage | 002 identifies ENG-116, R-137, lane-pstore-v031-implementation, and wH7:p5 with captured terminal output. 016 identifies ARCH-4/R-25/wHJ:p1 but explicitly has no terminal excerpt. Real streaming output is NOT TESTED. |
| O4 — Back | PASS for one app-Back return | 001 → 002 → 003 returns from the session to the original ENG-116 detail. Browser Back, repeated navigation, and scroll restoration were NOT TESTED by this reviewer. Parent separately reported navigation stress results. |
| O5 — Project switching | PASS for the two supplied projects | 013 → 014 switches all visible project regions to herdr-brain; 037 → 038 switches back to bch-cloak. The added herdr-brain goal and preview sessions do not appear in bch-cloak. An empty project was NOT TESTED. |
| O6 — Find decision | PASS for queue discovery; FAIL for deferred recovery | 004 → 005 exposes the question, options, context, and rationale. After Later, 006/007/039 provide no visible route to the deferred question. Source inspection is a placeholder, shown in 048. |
| O7 — Answer decision | PASS for one simulated answer | 008 → 009 → 010 cancels without decrementing the queue; 011 → 012 confirms the chosen answer, closes the item, and changes the count 12 → 11. Exactly-once delivery and answer durability are NOT TESTED. |
| O8 — Add goal | PASS for one valid goal | 023–026 creates herdr-brain G-3 with its title and success criteria, and shows it at priority 2. Invalid goal input was NOT TESTED by this reviewer. |
| O9 — Reprioritize | PASS within the current page session | 026 → 027 changes G-3 from priority 2 to 1; 028 shows the matching list order after leaving detail. The unavailable upward/downward boundary control is disabled in the corresponding detail. Reload persistence is NOT TESTED. |
| O10 — Main conversation | PASS for simulated session creation | 030–033 defaults to Conversation/Main checkout, reviews the `main` target, and opens the new preview tab and pane in main. Sending a first message and real launch are NOT TESTED. |
| O11 — Development worktree | PASS for an existing worktree | 017–020 defaults to Development session/current worktree, reviews lane/console-autonomy, and opens the named preview session there; 021 lists it in the project session table. Creation of a brand-new worktree and real worktree isolation are NOT TESTED. |
| O12 — Cancellation | PASS for sampled cancellation; incomplete coverage | Decision confirmation cancellation leaves the question pending (010). Reply cancellation returns to the original pane with no added output (035 → 036). Instruction review cancellation closes the dialog (053 → 054). Cancellation of every form, draft preservation, and absence of backend side effects are NOT TESTED by this reviewer. |
| O13 — Error recovery | FAIL for empty-input feedback; system failures NOT TESTED | An empty instruction followed by Review leaves the unchanged form with no visible explanation (050 → 051, screenshot visually inspected). Entering text permits review (052 → 053). No backend/network/model failure was induced. |

## Baseline findings

### IR-1 — High: Later hides a pending decision without a return path

Route: bch-cloak → Needs you → ENG-116 “Confirm whether to stop proving-key work” → Later. The queue count drops from 13 to 12 and the question disappears. The footer says “Saved for later in this preview.” The queue provides no deferred list, undo, due time, or destination. App Back still shows the reduced queue. Switching to herdr-brain and returning also leaves the question absent.

Evidence: `005-click.png`, `006-click.png`, `007-click.png`, `039-click.png`, with matching text snapshots. The later count of 11 includes a separately answered ENG-89 question; it is not a second deferral.

Impact: an operator trying to postpone a decision cannot find it again through the observed interface. Expected recovery: a visible deferred section or undo/restore control, with a clear distinction between deferred and answered questions. No claim is made about backend deletion; only the visible recovery path was tested.

### IR-2 — Medium: Empty instruction submission has no explanation

Route: Instruct → leave Your text blank → Review. The dialog is unchanged and provides no error, focus guidance, or disabled action. Entering text then permits review.

Evidence: `050-click.png`, `051-click.png`, `052-fill.png`, `053-click.png`. The empty-result screenshot was visually checked to exclude an omitted browser validation bubble.

Impact: the operator cannot distinguish required input from a failed control. Expected recovery: a clear required-input message and usable input focus. The parent first identified this case; the independent reviewer confirmed it without inspecting its implementation.

## Explicit preview limits encountered

- Read source on REV-64 opens only a statement that the existing brief, memo, or report would appear; it does not provide the document (`048-click.png`). A decision can be selected, but the evidence-review workflow is NOT TESTED.
- The ARCH-4 session identifies the exact captured pane but provides no excerpt (`016-click.png`). Selection correctness does not demonstrate output comprehension or streaming.
- New sessions say no agent was launched and identify preview pane/tab IDs (`020-click.png`, `033-click.png`). This validates visible destination selection only.
- A keyboard attempt to change the native Start a selection did not change its selected option (040–045). Native-select behavior in the headless fallback was not isolated, so this is not classified as an application defect. The successful development route used the existing worktree's contextual default.
- The reviewer did not inspect hidden fixture state or action handlers. UI acknowledgments alone do not establish delivery, event durability, or the absence of side effects outside the preview.

## Retest

The parent notified the reviewer that fixes were ready. A fresh isolated browser loaded the revised live preview at the same 1280 × 900 viewport. The parent supplied the intended changes, so this is a targeted confirmation rather than a fresh first-use discovery exercise. The reviewer still did not inspect implementation, tests, or hidden state.

Retest evidence is separate: `.lane/operator-simulation/independent/retest/`, screenshots and accessibility snapshots 000–037. Focus was observed through the browser's focused element accessibility snapshot, not application state. Selected screenshots for the Later queue, validation alert, and new-worktree result were visually inspected.

| Check | Result | Evidence |
| --- | --- | --- |
| IR-1: defer and recover the same question | PASS | 001–006: defer ENG-116, follow Later 1, reopen the matching question, and select Return to open queue. Open returns to 13 and Later to 0. The deferred footer now names the recovery route. |
| IR-1: find deferred work from overview and answer it directly | PASS | 031–037: defer ENG-116 again, return to overview, follow 1 later, reopen the same question, and confirm an answer. Later becomes 0 with an explicit empty state; Open remains 12, avoiding a second decrement. |
| IR-2: explain invalid input and support correction | PASS | 007–010: empty Review shows “Enter some text before reviewing.” and focuses Your text. Filling the field allows review. |
| Preserve an instruction draft when editing or escaping review | PASS | 010–013: Edit and Escape each return to the composer with the exact entered text. 014 confirms explicit Cancel exits without a submission acknowledgment. |
| Create development in a brand-new worktree, with goal context | PASS within preview | 015–024: choose Development session/New worktree, enter `operator-recovery`, name the session, select G-1, review, Edit, review again, and confirm. All fields survive Edit. The result identifies lane/operator-recovery and G-1, appears in the sidebar and session table, and explicitly says no agent was launched and Git was not created. |
| Avoid repeated same-view history entries | PASS for sampled route | 024–028: Overview → Goals → Goals → Goals → app Back returns directly to Overview. |
| Restore keyboard focus to the triggering goal | PASS for sampled route | 029–030: Enter on the G-4 overview goal opens its detail; Escape returns to Overview with focus on that exact G-4 control. |

No additional blocking defect was observed in this targeted retest. The source-reader and output placeholders, live dispatch, actual worktree creation, durable writes, failure/retry semantics, browser Back, multi-session task ambiguity, and assistive-technology use remain outside the independently validated scope. Browser Back and broader regression coverage belong to the parent's separate report; this reviewer does not claim those results as personal observations.

The evidence files are local generated artifacts under `.lane`; the review itself is in `docs/reviews`. Neither page-session success nor these artifacts establishes production behavior.

## Final browser-Back confirmation

After the parent reported a further history fix, the reviewer used a third fresh browser context at 1280 × 900. Only the independent UI driver was extended. The reviewer did not inspect the preview implementation. Evidence: `.lane/operator-simulation/independent/retest-history/`, screenshots and accessibility snapshots 000–021, with actions and focused-control observations in `actions.jsonl`.

The first check used Playwright's browser Back navigation. Later checks used Chromium's simulated mouse Back button through `Input.dispatchMouseEvent`; they did not call application history functions or evaluate application state. The earlier NOT TESTED statements about browser Back describe the earlier runs and are superseded only for the specific routes below.

| Route | Result | Evidence |
| --- | --- | --- |
| Goals → New goal → browser Back | PASS | 001–003: the dialog closes, Goals remains visible, and focus returns to + New goal. |
| Overview → Chat → enter session name → Review → mouse Back | PASS | 004–008: New chat returns with the exact name “Native Back preserves this draft,” Conversation, Codex, main checkout, and No goal yet. The restored form was visually inspected. |
| Restored chat composer → next mouse Back | PASS | 009: the composer closes and Overview remains visible, with focus on + Chat. |
| Chat → enter name → Review → Cancel → mouse Back | PASS | 010–014: Cancel closes the flow; Back returns to the preceding Goals view without reopening the composer or confirmation. |
| Chat → enter name → Review → Confirm in preview → two mouse Back actions | PASS | 015–021: confirmation creates one visibly labeled preview session. Back returns to Overview, where that session remains listed; the next Back returns to Goals. Neither the completed confirmation nor its composer reopens. |

Playwright's first Back call timed out waiting for a main-frame navigation, while the iframe visibly completed the correct transition. The warning is retained in the action log and is a harness limitation, not an application failure. The mouse Back checks avoided that main-frame wait. Screenshots 003, 008, and 020 were visually inspected in addition to their accessibility snapshots.

No additional defect was observed. Physical mouse hardware, browser Forward, other dialog types, and live side effects were not tested in this final pass. The parent reported broader automated and headed checks separately; their pass counts are not presented here as independent observations.
