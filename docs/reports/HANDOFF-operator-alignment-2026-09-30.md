# Handoff: operator alignment, items pane and decisions (2026-09-30)

The operator and the previous session reached the conclusions below over
Sep 24–30. A fresh session should evaluate the whole system against them.
Some of it was already set up and then forgotten, for example bch-cloak's
SETTLE.md authority split and stage rules. Rebuilding those would be a
mistake; reconcile with them.

## What the operator wants (their words, condensed)

- **Observability of dynamic agent work, not a backlog to groom.** "The minute
  I create a list of goals it's out of date." Agents create typed items
  (ENG/REV/ARCH/HUM…) as they go. The operator wants to see them as they
  happen: what each session is working on, what is blocked and why, and what
  needs a decision.
- **The long-running supervisor chat stays.** It is how the operator steers.
  The items pane sits to its right. Workers notify the supervisor through Herdr.
- **Velocity.** Nothing should wait on the operator unless it truly must. In
  1–2 weeks the operator has never disagreed with what they were asked to
  approve, so per-decision approval is friction, not a check.
- **The real failure mode is scope drift.** Agents left alone went down rabbit
  holes of work the operator did not want. One research idea (ARCH-230) became
  33 runs in an afternoon.
- **Priorities are the anchor.** "It's important to maintain alignment on
  priorities."

## Conclusions

1. **Three decision classes.** Only one waits on the operator.
   - *Routine:* settle, review verdicts, promote, sequencing within the plan.
     The supervisor decides at once, records the decision as decided under
     policy (`org note --decision`), and shows it in a "steered and decided"
     list so the operator can overrule afterwards.
   - *Contested:* the author's recommendation is weak, a reviewer disagreed,
     or adopting it changes a frozen contract. One checker agent (proposed:
     a `check` route, Sonnet, medium effort) verifies the claims against the
     code and records agree or disagree with file:line references as an org
     note. Agree means proceed; disagree means the operator decides.
   - *Operator's:* funding, signing, broadcast or other chain contact;
     running a prover or Setup; deployed profile, pins and trust anchors;
     publication and pushes; changing the goal, opening a stage, changing
     priorities; anything AGENTS.md reserves. Asked as plain `org ask`
     yes/no questions with a recommendation (the template already exists in
     SETTLE.md §3).
2. **Scope guard against drift.**
   - Every dispatch names the priority it serves (`org start … --meta serves=<ID>`).
   - Work under no priority is parked and listed in the handoff, never
     dispatched and never asked about.
   - Studies, research and proposals: at most one at a time, time-boxed.
3. **Priorities are one short, operator-owned list.** For example #1 =
   ARCH-355 "working multi-party prototype on Chipnet" (operator note,
   2026-09-30 20:55). It would be recorded as `meta.priority_rank=1..N`,
   attributed to the operator, quoting their sentence. The supervisor orders
   and splits work inside a priority freely. Measured: item `priority`
   numbers in bch-cloak were changed 1,009 times, almost all by
   supervisor/settle sessions, while the operator's real priorities live
   only in prose notes. No single list is checked against today.
4. **Everything the chat names must be in the org**, so the pane can resolve it.
   - The supervisor names work by org IDs.
   - Plan labels (3A, 4-DC2, S1) go on items as `meta.alias`.
   - Operator questions go through `org ask`, never chat-only numbering like
     OD-1 or OD-9.
5. **Attribution must be honest.** Many writes marked `human` are agents. On
   branch lane/block-review, the core flags writes made without `ORG_ACTOR`,
   and the console and `brain start` set it. The supervisor launch should set
   `ORG_ACTOR` to its Herdr agent name (`supervisor-opus`).

## Proposed edits (NOT made; the operator has not approved them)

- **bch-cloak `.lane/supervisor/SETTLE.md`:**
  - §3 *Yours*: add adopting open-stage design and spec changes after review
    plus checker agreement.
  - New §3 *Contested*.
  - §3 *Operator's*: narrow to the list above. Library crypto, relation and
    contract adoptions move to Contested.
  - §5: add serves=, the research cap, park instead of ask, and priority
    ranks.
  - One-time pass: record the priority list, then triage Decide (15 open, 7
    of them stale HUM questions from Sep 25–29).
- **bch-cloak `scripts/lane/routing.json`** (the sole routing authority): add
  a `check` route.
- Open operator choices: (a) move library crypto, relation and contract
  adoptions to Contested (recommended); (b) checker model and effort
  (recommended: Sonnet, medium).

## State of the code (branch lane/block-review)

Worktree: `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-block-review`.
Based on lane/console-autonomy. Not merged, not pushed. Tests: 276 passing at
22ab311.

- **`org recap`** (core): a derived work-block view.
- **Unattributed-write flag** (core).
- **Modern console** with a block screen, numbered sessions, interactive
  sessions (Herdr `terminal session control`), Needs answering, and a direct
  painter that removed the screen blinking.
- **Items pane**, `node console/app.mjs --feed --project bch-cloak`
  (console/modern/feed.mjs):
  - Sessions are named by their Herdr workspace label.
  - Tracked items are grouped into decide, blocked, stalled, working,
    not started and resolved; `f` filters.
  - Blocked items show the actions that unblock them; dispatch and redeploy
    requests go to the supervisor.
  - Report "Decisions for the operator" sections are parsed and can be
    answered from the pane. Sends never go over an unsent draft in the
    supervisor's prompt box.
- **Chat index** (console/modern/chatindex.mjs): indexes the supervisor's own
  Claude transcript into `~/.local/state/herdr-brain/<project>/chat-index.json`.
  It is observation only and does not depend on the chat's scroll position.
- **WIP, the last commit on the branch:** console/modern/delegate.mjs plus the
  feed wiring. It is a queue that starts decider sessions via `brain start`,
  parses their JSON decision, and forwards it to the supervisor. One test in
  console/test/delegate.test.mjs fails (no decider starts after confirm).
  Per the conclusions, this should become the *checker* launcher: it writes
  its view as an org note and starts automatically for Contested decisions.
  It should not stay an operator-approved decider.
- **Lessons:**
  - `herdr pane read --source recent*` scrolls full-screen apps; use
    `visible` or the transcript.
  - Ink's renderer erased lines each frame and made the console blink; the
    modern mode paints rows directly.

## Live setup

- **bch-cloak workspace `wFN`, tab "supervisor":** supervisor-opus in pane
  `wFN:pY6`. The items pane is in `wFN:pY8`, run by `console/dev.mjs --feed`,
  which reloads on save.
- **bch-cloak supervisor kit** (`bch-cloak/.lane/supervisor/`):
  - `dispatch.sh`: org start, brief, lane dispatch, then a detached
    `notify-watch.sh --to supervisor-opus`.
  - `notify-log.tsv`, `SETTLE.md`, `OPEN-STATE.md`.
- **The org CLI** used by bch-cloak is herdr-brain **main**
  (`/Users/rewt/development/rewt/herdr-brain/bin/org.mjs`), not this branch.
- **Never write** to the real orgs (`/Users/rewt/development/bastian/.org`,
  `/Users/rewt/development/rewt/.org`) or to the supervisor's files without
  the operator's approval.
