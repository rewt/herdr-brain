# Live Projects trial and fresh-project onboarding

Design correction: the operator subsequently identified that this first live
renderer diverged from the approved HTML. Its integration checks did not verify
visual fidelity. The [fidelity correction report](console-design-fidelity-2026-09-20.md)
records the changes and actual terminal captures; it supersedes this report's
claim that the original trial faithfully implemented the accepted layout.

The accepted console layout now reads live Herdr sessions and org records in an
opt-in Ink mode. Project switching, direct worktree navigation, session output,
goals, tasks and attention details work against the existing projects. The
recommended product name is **Herdr Projects**, with **Projects** inside Herdr.
Fresh-project onboarding should accept an idea before requiring a goal or repo.

This is a delivery addendum for the operator's continued design work. The
previously recorded R-25 report, `console-goals-autonomy.md`, is unchanged; this
document is not a second report to ingest against that run.

## Run the live trial

Worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy`.
Branch: `lane/console-autonomy`. Changes are in the working tree.

```sh
cd /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy
node bin/org.mjs console --modern --project bch-cloak
```

Use `p` to switch/discover projects, `s` for sessions, Enter to open output,
`g`/`t`/`!` for goals/tasks/Needs you, and Escape or `b` to go back.
`PageUp` reads older output; `PageDown` returns toward the latest output.
`--modern --folder /absolute/path` opens an existing folder for temporary
inspection. With no explicit project, the plugin's calling workspace guides
selection when available.

The trial is read-only for organization and agent work. Existing actions remain
in `org console --project NAME`. The browser preview at port 8765 still uses
captured data; launch the command above to inspect live sessions.

## Delivered behavior

- The overview puts scoped sessions first, with goals/tasks and attention
  alongside the same project context. Main checkout and worktrees appear in the
  rail; checkout tabs run horizontally. Narrow layouts preserve identity/state.
- Configured projects and repositories open in Herdr share a picker. Canonical
  Git common-directory identity groups worktrees and symlinks; same-named repos
  remain distinct. Opening a folder creates no project files or configuration.
- Session output is read by exact pane ID every 1.5 seconds. Multiple agents in
  a split tab require selection. Recorded run associations connect sessions to
  tasks/goals; unmatched sessions say Unlinked, and historical links say last.
- Source errors retain labeled last-good data. Project changes and late responses
  cannot put one project's records or output into another selected scope.
- Back/Forward preserve view, scope, selection and scroll. Mouse clicks use the
  same controls; extended SGR Back/Forward events are decoded.
- The plugin manifest declares a tab entrypoint, uses the host's binary/socket
  context and has no automatic hooks. Herdr remains the terminal host.

Implementation is in `console/modern/`, with the shared Ink renderer and small
CLI/config/input adapters. It adds no core dependency, background service, model
call, org-write route or agent-start route. The `o` action checks current topology
before transferring focus to an existing native terminal.

## Naming and onboarding

The [design recommendation](../design/console-projects-onboarding-2026-09-20.md)
compares Projects, Studio, Workbench, Brain and Org and specifies the proposed
flows. Projects describes the operator's work without requiring a preexisting
organization or implying autonomous execution. Keep Brain and org as internal
and compatibility names; no repo or command rename is needed for this design.

The three entrances are **Bring an idea**, **Open a folder**, and **Use an open
Herdr space**. A draft project should save original ideas with a stable identity,
then support exploration, choosing a folder, and shaping a goal when useful.
Existing projects should be discoverable before registration. Development work
should enter a worktree through the existing dispatch layer.

Implemented now: read-only discovery and folder inspection, with accurate empty
states. Durable ideas, project registration, new folder creation, conversation
launch, and goal/task creation are designed follow-on work. Their trial screens
say that setup and chat creation are not connected yet.

## Validation

- Before changes: `npm test` passed 185/185.
- After changes: `npm test` passed 204/204; `npm --prefix console test` passed
  117/117. The console suite overlaps the root suite. Nineteen new offline tests
  cover identity, project isolation, exact output targets, split tabs, stale
  responses, source recovery, navigation, folder opening and terminal rendering.
- A read-only live check passed against both configured projects at 80×24,
  100×34 and 140×42. It observed seven BCH sessions and three Brain sessions,
  discovered five projects, read the selected idle pane `wHD:pM`, verified output
  scrolling and Back, and confirmed the console config checksum was unchanged.
- An [independent operator review](../reviews/console-live-trial-independent-2026-09-20.md)
  exercised real PTY navigation and live output. It found four issues: list
  shortcuts focused Back, task states clipped at narrow widths, session columns
  wasted space on missing metadata, and empty-folder copy implied unavailable
  resources. All four were repaired and independently retested successfully.
- The manifest parses and its standalone entrypoint runs against live sources.
  Installed Herdr CLI/server: 0.8.2, protocol 20. `git diff --check` passes.

Evidence is under `.lane/design-preview/live-{before,after,console-after}.log`,
`.lane/live-trial/` and `.lane/operator-live-independent/`. These local captures
include live project/session content and are not intended as public fixtures.

## Remaining work and limits

1. Implement a shared durable project catalog and idea documents, with a
   compatibility path for current console/Brain config. Distinguish opening from
   registration; support deliberate folder creation and recoverable retries.
2. Add exploratory chat and goal/task creation through their owning tools.
   Exploration must work without a fabricated goal; development must preserve
   the existing dispatch and promotion checks.
3. Bring existing decision, reply, instruction and dispatch actions into the new
   layout before making it the default. Keep unavailable goal-rank/authority
   contracts explicit. Further operator polish should shorten long attention
   identifiers and reduce output-view chrome at small sizes.
4. Validate the actual plugin-owned tab and native-terminal round trip, physical
   mouse side buttons, and terminal resizing with the operator. These were not
   exercised by the read-only review. The staged plugin has not been globally
   linked; simulated input decoding does not prove host mouse forwarding.

No live org changes, agent messages, dispatches, promotions, new sessions, or
global plugin registration were performed. Preexisting design/prototype changes
in this worktree were retained.
