---
run: R-25
outcome: done
summary: |
  Designed goal priority, delegated pickup and durable explanations within the existing console cascade.
  Added sourced field notes, reasoned answers to all six questions, twelve exact renders at three widths,
  and an interactive fixture extension with goal reordering, authority review/editing and lasting pickup decisions.
  Root and console tests and the real Ink PTY smoke pass. Production changes remain proposals; no live organization was changed.
headline: Goal priorities and autonomous task choices are ready to inspect in the console prototype
blockers: []
proposals:
  - role: engineer
    title: Implement the goal priority and durable authority read contract
    why: The design needs project-local goal rank, task-local preference, versioned authority and compact pickup records that can be read without inference. Add atomic relative reorder and revision checks through org CLI while preserving numeric priority direction, old folds and derived status; record the legacy-priority migration explicitly.
  - role: engineer
    title: Add bounded executive pickup on the brain dispatch boundary
    why: Build on ENG-23 rather than duplicating its dispatch verbs. Coalesce meaningful wakeups and explicit requests, claim work by canonical project and task identity, recheck authority and conflicts before starting, reconcile interrupted starts, and record why and what actually happened before the executive exits.
  - role: engineer
    title: Integrate goal rank and autonomy evidence into the product console
    why: After the org and brain contracts and the ARCH-3 product integration are ready, connect the fixture design to read projections and CLI actions. Keep global attention and the session pane, protect edits with current revisions, retain pickup evidence after tabs close, and validate real handoffs without per-task operator approval.
learnings:
  - The current org comparator sorts larger priority numbers first and has no goal-to-task inheritance.
  - unblocksPrioritized orders human attention by prioritized dependents; it does not select ready work.
  - The current product print refresh can call brain explain; a worktree-local configuration with explain false permits inspection without that model/cache effect.
  - Continue mode already selects work within goal notes, but its watcher serialization is not a durable task claim and org start permits parallel runs with a warning.
  - Session metadata must remain display-only; pickup must use durable goal authority and current work records.
artifacts:
  - docs/design/console-goals-autonomy-2026-09-19.md
  - docs/reports/console-goals-autonomy.md
  - console/proto/autonomy.mjs
  - console/proto/autonomy.test.mjs
  - console/proto/controller.mjs
  - console/proto/frame.mjs
  - console/proto/main.mjs
  - console/proto/README.md
  - console/proto/render-autonomy.mjs
  - console/proto/snapshots/autonomy/
  - console/proto/smoke-pty.py
  - lane/console-autonomy
---

## Recommendation in five sentences

Rank goals visibly within each project, retain higher-first numeric storage, and let tasks inherit goal importance with only a local task preference.
Keep the next-task judgment in a fresh executive that works within recorded authority, writes its decision and exits.
Show each pickup's reason, authority at the time, alternatives and observed outcome in a lasting reader linked from the existing sessions pane.
Let the operator reorder goals, inspect and revise authority, pause future pickup, and explicitly request an executive pass from the console.
Use automatic pickup for authorized reversible work now, with substantive exceptions and existing review gates instead of an approval for every task.

## Delivered

The [design document](../design/console-goals-autonomy-2026-09-19.md) starts with
field notes researched before implementation, using official Kubernetes,
Buildkite, Linear, PagerDuty and Warp/Oz documentation. It distinguishes
documented interfaces from inference, answers all six questions with a clear
recommendation and reasoning, and records rejected alternatives. It reuses the
ARCH-3 visual system and contains exact crops of changed regions at 80×30,
100×40 and 140×45; twelve complete frames are also saved for inspection.

The fixture extension keeps the cascade, one-line waiting rows, detail readers,
session reservation and global needs-you count. Goals gain Earlier/Later rank
controls. Authority shows issuer/revision, allowed work, ask boundaries,
promotion gates and pickup permission; editing scope or allowing/pausing pickup
has an explicit review. Missing authority cannot be enabled with a toggle.
Next work holds four durable-looking synthetic decisions covering a confirmed
start, an authority deferral, a capacity deferral and no pick. Task/session
readers link to the recorded rationale and honestly identify missing records.
The authority exception uses one existing human row with context, three viable
options and a recommendation, preserving thirteen global waiting entries.

The explicit executive action records only a simulated request and coalesces
duplicates. It never claims a model ran or a worker started. Rank and authority
edits persist through Back without changing historical evidence or running
sessions. The fixture aligns the started retry task's current state with its
working session and the deferred migration's state with its human blocker.

Try it:

```sh
node console/proto/main.mjs
node console/proto/main.mjs --print 80x30 --screen authority
node console/proto/main.mjs --print 100x40 --screen decisions
node console/proto/main.mjs --print 140x45 --screen decision
node console/proto/main.mjs --print 100x40 --screen decision --goal G-2 --keys o
```

In the interactive prototype, `e` opens Next work, `n` there reviews an executive
request, `[`/`]` reorder the selected goal, `a` in goal detail reads authority,
and `w` in task/session detail reads why it was picked. Every new action has a
mouse route. Restarting resets the fixture.

## Evidence and limits

- Read the north star, prior design/report, Continue protocol, watcher and
  priority/model code; verified all eight required context files match the
  canonical checkout. Read live data only with `org today --json`,
  `org status --json` and `brain queue --all --json`.
- Inspected the existing product print renderer at all three requested sizes
  using a local configuration copy with `explain: false`. Herdr was unavailable
  to those reads, so they showed unknown live-session state; these captures
  are not evidence of a working live connection or actual pane switching.
- Installed locked console dependencies with a worktree-local npm cache. The
  first restricted download failed; the approved network retry installed the
  forty locked packages. No new dependency or lockfile change was introduced.
- The initial root attempt, while dependencies were absent, passed 166/167;
  its sole failure was the dependency-presence check. After installation, the
  unchanged baseline passed 167/167 root tests and 98/98 console tests.
- Final `npm test` passed **175/175** and `npm --prefix console test` passed
  **98/98**. The root suite includes the original thirteen prototype tests
  and eight new autonomy checks. Tests are offline and never call a model.
- `python3 console/proto/smoke-pty.py` passed with real Ink, including rank
  changes, authority review/cancel, bracketed-paste ownership, executive
  request/deduplication, existing keyboard/mouse flows, resize and terminal
  cleanup. This is a PTY check, not a physical mouse test in a Herdr popup.
- All twelve saved frames exactly match their documented `--print` commands;
  dimensions and hit bounds are checked at all three sizes. `git diff --check`
  passed. No file under `console/lib/`, core, brain, lanes or supervisor changed.

The prototype does not implement persistence, actual pickup, crash recovery,
cross-project allocation, first-envelope creation or arbitrary promotion-policy
editing. Its full-policy reader and one-field editor make the intended console
interaction reviewable; the document identifies the remaining production
contracts and migration requirements. Routine scheduling does not depend on
the console staying open. No organization mutation, live session action,
configuration deployment, promotion or push was performed.

One process-scope deviation: the first pre-install baseline test process used
the test harness's default system temporary directory before I redirected
`TMPDIR`; subsequent baseline and final checks used worktree-local temporary
directories. The harness cleans its temporary fixtures. No live organization
or user configuration was written. Validation logs are retained under the
worktree's ignored `.lane/arch4-validation/`; downloaded cache and captured
live data were removed. Changes remain uncommitted in this lane worktree.

## Questions only the operator can decide

1. **Which real work receives the first automatic-pickup trial?** Recommend
   reusing an existing goal's explicit grant for reversible local work in this
   project, retaining its launch limits and all review/promotion gates. This
   design itself grants no authority.
2. **May the executive create or reorder strategic goals?** Recommend allowing
   decomposition and ordering within goals under existing authority; delegate
   strategic goal changes explicitly where desired rather than deriving that
   power from a rank control or an agent's own note.
3. **Is a cross-project portfolio rank needed now?** Recommend no. Keep ranks
   project-local and current configured capacity rules until actual resource
   contention establishes a need for a portfolio policy.

No answer is required to finish this design run. These choices govern adoption
of the proposed production behavior.

## Cutover

None. This is a design document and isolated fixture prototype. The three
proposals identify the org contract, executive continuation and console
integration work needed for a later product cutover.
