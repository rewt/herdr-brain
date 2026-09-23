# Operator study and repairs for the live console

headline: The live console now has section navigation, a scope dropdown and a readable native session view.

The operator's findings were reproduced against the actual Ink application, then
repaired in `lane/console-autonomy`. An independent operator agent performed a
source-blind baseline walkthrough and fresh-process retests. A separate agent
investigated the native terminal contract; another designed daily and weekly
backlog review. This is an expert walkthrough with real terminal interaction,
not a human research panel or a claim of complete product acceptance.

The final independent verdict is **pass for the observed read-only trial
missions**; detailed reproduction evidence is in the
[UX study](../reviews/console-full-ux-study-2026-09-20.md). The approved browser
preview remains the visual reference; this pass changed the live Ink trial.

## Implemented repairs

- Tab and Shift+Tab move between sections rather than visiting every checkout.
  Up/Down and j/k choose rows within a section. Returning to a section remembers
  its selection. Left/Right operate the main view tabs and checkout tabs.
- Project scope opens an anchored dropdown over the current view. Typing
  filters; Escape or clicking outside dismisses. Reselecting the same project
  preserves the current detail. After a scope change, Back restores the prior
  project and detail without an intermediate picker screen.
- Under Herdr, the companion hides its duplicate checkout sidebar by default.
  The native Spaces/Agents navigation remains the outer navigation; `w` opens
  local checkouts when useful. Standalone mode retains the rail.
- Session detail leads with the recorded goal, task/run and summary in one
  surface, followed by separated session identity and live terminal sections.
  Unsupported creation actions no longer look enabled in the read-only header.
- The live screen uses Herdr's exact-pane read-only observer. A bounded decoder
  retains supported ANSI colors, emphasis, background, indentation and cell
  positions. It never forwards raw terminal commands into Ink's own terminal.
  `l` selects a clearly labelled plain transcript; `v` returns to the screen.
  `o` remains the explicit handoff to the actual harness for interaction.
- Goal/task details put current linked sessions before criteria and notes, and
  include tasks under descendant goals. Historical links stay distinct. Empty
  criteria say “No success criteria recorded”; arrays render as numbered items.
- Compact overviews keep Sessions, Goals, Tasks and Needs you visible together.
  Full lists remain reachable with honest summary counts. Help forwarding,
  empty picker results and footer spacing were also repaired.

## The additional bug found by independent testing

The initial styled observer implementation requested the console panel's small
dimensions. Herdr projected the top of its much larger native screen, hiding
the current prompt and latest work. A fresh timestamp made the result especially
misleading. The independent reviewer found this after the first repair pass.

The corrected adapter reads exact native pane geometry and observes that full
screen. The console crops locally to the bottom, showing native dimensions and
the visible row/column range. Shift+arrows pan the local view. Console resizing
does not change the native terminal or restart its observer; a change in native
geometry replaces only the owned observer. Missing/unsupported geometry fails
visibly rather than returning a silently clipped top fragment.

The final fresh PTY retest retained a native 177×79 screen across console sizes:
rows 56–79 at 140×43, 65–79 at 100×35, and 75–79 at 80×25. The prompt remained
visible. Vertical and horizontal panning, returning to bottom, transcript/live
switches and Back passed. At the smallest size only five terminal rows fit;
an optional expanded-terminal view remains a useful future refinement.

The [terminal contract](../design/console-native-terminal-contract-2026-09-20.md)
records the installed Herdr 0.8.2/protocol 20 behavior, decoder limits and evidence.
This is a live screen mirror, not an embedded interactive PTY. Default colors
and customized ANSI palettes can differ from the host; terminal images and
interactive hyperlinks are not implemented.

## Daily and weekly backlog review

The [backlog review design](../design/console-backlog-review-2026-09-20.md)
recommends one durable weekly outcome, a short fresh daily planning session,
and coalesced reviews after material changes such as settled reports or answered
decisions. Unchanged routine checks should avoid model calls. Each review
records what changed, the next useful task and why it serves the outcome.

Review, backlog maintenance and starting work have separate authority. Priority
and eligibility come from durable goal/task records; session activity is only
observational evidence. Recorded claims and conditional starts must prevent
duplicate dispatch. A project starting with ideas can begin with an authorized
exploration task and establish goals from its findings.

This is a design, not an enabled scheduler. Current production lacks goal
priority inheritance, the focus/review contract, conditional autonomous claims
and project-scoped scheduled planning. The existing Continue wrapper can
dispatch and is scoped to herdr-brain; it is not a generic read-only grooming
command for bch-cloak.

## Verification and remaining limits

- Before changes: `npm test`, 208/208 passed.
- After changes: `npm test`, 234/234; `npm --prefix console test`, 147/147.
  These suites overlap. Focused modern/observer tests passed 49/49.
- `git diff --check` passed. Tests are offline and never call a model.
- `org check docs/reports/console-goals-autonomy.md` passed; its expected warning
  confirms R-25 already has a recorded report. That report was not changed or
  ingested again. Local documentation links and wrapper help also passed.
- Independent live PTY missions exercised real BCH/Herdr project data at
  140×43, 100×35 and 80×25. ANSI recordings were replayed through xterm in
  Chromium for visual inspection, not replaced by an HTML mockup.
- Live read-only observation verified native colors and prompt position. Native
  terminal input, actual focus round trips, globally installed plugin lifecycle
  and physical mouse side-button forwarding were not exercised. Injected mouse
  Back/Forward handling and keyboard history were exercised.
- Some live sessions lack durable task/run links. The UI labels them Unlinked;
  a title resemblance does not manufacture a goal association. This remains a
  workflow gap, not a completed repair.
- No live org/config writes, agent input, dispatch, native focus changes,
  scheduled jobs or global plugin installation were performed.

Evidence is local under `.lane/ux-study/`: `baseline-*`, `mission-*`, `retest-*`,
`final-*`, `crop-*`, observer samples and `native-bottom-view.json`. The
`final-live-screen-*` files precede the crop correction; use
`crop-native-bottom-*` for the delivered behavior. Suite logs are under
`.lane/design-fidelity/usability-{before,root-after,console-after,targeted}.log`.

## Follow-on proposals

These extend the earlier goal/autonomy and onboarding proposals; do not create
duplicate work for already recorded items.

```yaml
proposals:
  - role: engineer
    title: Preserve durable goal task run and pane links through session launch and recovery
    why: The study found active sessions that remain Unlinked. Explicit launch receipts and recovery must carry canonical identities so the console can explain their contribution without guessing from names.
  - role: engineer
    title: Add project focus and review receipts with an explicit read-only planning command
    why: Implement the first stage of the backlog review design and expose current focus, last review, next task and reasons in the existing overview. Reuse earlier priority and authority contracts rather than a parallel planner.
  - role: engineer
    title: Add conditional backlog maintenance and delegated pickup with coalesced scheduled review
    why: Unattended daily review needs idempotent mutations, durable claims, bounded wakeups and uncertain-launch recovery. This is larger than a UI repair but is required to automate the requested process reliably.
  - role: engineer
    title: Complete native host acceptance and offer an expanded session terminal view
    why: Validate actual focus return, physical Back-button forwarding and plugin lifecycle with an operator. At 80 by 25 the context leaves only five terminal rows; an optional expanded view would improve sustained observation.
```

## Run the updated trial

Relaunch from this worktree to load the changes:

```sh
cd /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy
node bin/org.mjs console --modern --project bch-cloak
```

Implementation is in `console/modern/`, with integration in `console/app.mjs`
and wrapper help in `bin/org.mjs`. The original recorded R-25 report at
`docs/reports/console-goals-autonomy.md` remains unchanged. This document is a
delivery addendum, not a second report to ingest for that run.
