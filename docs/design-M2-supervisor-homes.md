# M2 design: homes for supervisor jobs 2–5

Date: 2026-09-16, America/Chicago. Status: **proposal, nothing built.** Read
`north-star.md` and `pilot-M1-results-2026-09-16.md` first. This document
answers the last line of the north-star status table: the supervisor is gone
only when exceptions, planning, the operator window and oversight run
somewhere other than a live chat. The operator's open decisions are listed at
the end.

## The rule

Every job gets three parts. None of them is a conversation.

1. **Always on, zero inference.** Deterministic checks over org, Herdr and
   the clock.
2. **A short reasoning session**, opened only when step 1 finds something to
   reason about. It records its result and exits.
3. **A durable record in org**, which the next session and the operator read
   for free.

If a job can't be split this way, it goes to the operator on purpose. It never
goes back to a chat.

| Job | Always on (0 tokens) | Session, only when triggered | Record | The operator sees |
|---|---|---|---|---|
| 2 Exceptions | loop rules over agent state, launches, cap, clock | none of its own; a `continue` session when the fix is a decision within authority | `alert` events | `org today`; a system notification for *needs you* |
| 3 Planning | loop detects morning, new direction, starvation | `plan` | `direction` and `plan` notes, items, priorities | today's focus at the top of `org today` |
| 4 Operator window | `org today` | `brain`, on demand, disposable | `org decide`, `org direct` | one screen |
| 5 Oversight | explicit acceptance in org; `org audit` invariants on every loop tick | `audit`, evenings, only if anything happened | `audit` notes, alerts, reopened items | the last audit's findings in `org today` |

## Shared machinery

### The loop replaces per-run watchers

The loop is one zero-inference process per organization, kept alive by
launchd (`KeepAlive`). It lives in `contrib/` because it knows about Herdr
and Claude; the org core still never runs in the background. On each tick it:

1. folds org, lists Herdr agents, and reads its session ledger and the clock;
2. evaluates a fixed rule table (the Job 2, 3 and 5 sections below);
3. acts: runs `org alert` / `org clear`, opens at most one session, and sends
   notifications.

It wakes every 60 s and whenever `.org/events.jsonl` changes. Running
`herdr agent list` costs no inference. If latency ever matters, Herdr's
socket API has `events.subscribe` (`pane.agent_status_changed`) to replace
the timer. The loop keeps no state of its own across restarts, because
everything it needs is in org or the ledger. Killing it loses nothing, and
launchd restarts it. Rules are pure functions from (state, now) to actions,
so they can be tested offline the same way org is.

Why one loop instead of a watcher per run:

- **Sessions go unwatched.** A watcher watches only its worker, never the
  session it opens. The settle that sat 50 minutes on a permission prompt
  (incident 2) fell into exactly that gap.
- **Stopped watchers lose work.** A watcher that hits the cap or STOP exits,
  and its finished run is never settled. Nothing records this (incident 12).
- **Watcher deaths are invisible.** A killed watcher leaves no trace
  (incident 10). A dead loop shows at the top of `org today`, because its
  heartbeat file goes stale.
- **It deletes code.** Per-run locks, take-turns, `--spawn` tabs and tab
  pruning exist only because there are many watchers (incidents 4, 9). A
  single loop opens one session at a time by construction.

`arm-watch.sh` goes away. The loop watches every open run that has an
`agent` recorded.

Per-organization settings move into one file, for example
`bch-cloak/.lane/supervisor/loop.json`: org dir, cwd, lane config,
`--add-dir`s, cap and reservations, schedule, thresholds. They replace the
argument lists in `arm-watch.sh` and `continue.sh`. Under launchd, PATH
must include `~/.local/bin` and node, and the account comes from the
launcher exactly as it does today.

### One launcher, five modes

The session-opening code in `settle-watch.mjs` stays: account resolution,
`--add-dir`, the login check. It gains modes. Authority is written once, in
`AUTHORITY.md` (today's `SETTLE.md` §3), and every mode's checklist refers to
it. Checklists stay short and each mode reads only its own, which keeps cold
starts small.

| Mode | Opened by | Checklist | Dispatches |
|---|---|---|---|
| settle | a run stopped with a report | `SETTLE.md` | yes (§5) |
| continue | an operator decision or direction newer than the last session; a run that stopped without a report; `continue.sh` | `SETTLE.md` | yes |
| plan | the morning schedule; a new direction; starvation | `PLAN.md`, then `SETTLE.md` §5 | yes, after planning |
| audit | the evening schedule, if anything happened | `AUDIT.md` | no |
| brain | the operator (`brain.sh`) | `BRAIN.md` | only if the operator asks |

**Every session runs with `ORG_ACTOR=<session name>`.** Today
`bastian/.org` records 258 events as `human`, and every session write is
among them, so org can't tell the operator's priorities and decisions from a
session's. Several rules below depend on that difference, so this change
comes first. The operator keeps the default actor.

### Session guard

The loop keeps each session it opened under watch until the session stops:

- **`blocked`**: raise a *needs you* alert that names the tab. The loop
  never answers the prompt.
- **Working too long**: an *info* alert at 45 min, *needs you* at 90 min.
- **Stopped**: check the mode's postcondition deterministically:
  - settle: the run has a recorded report, and the session wrote at least one note;
  - plan: the session wrote a `plan` note;
  - audit: the session wrote an `audit` note;
  - continue: the session wrote at least one event.

  If the postcondition fails, the loop raises an alert and retries once. A
  second failure becomes *needs you*.

Only one executive session (settle, continue, plan or audit) works at a time,
as now, so two sessions can't dispatch the same work. Queued settles go in
the priority order of their items.

### Budget

The daily cap stays at 12 (the operator's choice), with **reservations**:
one slot for plan and one for audit. Settle and continue share the other
ten. When those ten are used up, finished runs wait under a single *info*
alert ("3 runs waiting to settle: cap"). They are settled when the budget
resets, and none are dropped. Brain sessions belong to the operator: the
ledger logs them, but they don't count against the cap. STOP still stops
everything.

### New records in org core

These additions are small and deterministic, and they stay within the
AGENTS.md contract: status is derived, and older folds ignore event types
they don't know.

| Addition | Shape | Jobs |
|---|---|---|
| alerts | `org alert <key> <text> [--on ID] [--level needs_you\|info] [--until TIME]` records `alert.raised`; `org clear <key> [--note T]` records `alert.cleared`. An alert is open if it was raised, hasn't been cleared and hasn't expired. Raising an open key again updates its text instead of duplicating it. | 2, 5 |
| tagged notes | `org note <ID> <text> --tag direction\|plan\|audit`; views use the newest note per tag | 3, 4, 5 |
| `org direct <text> [--goal G-n]` | Shorthand for a `direction` note on a goal (by default the top-priority open goal) | 3, 4 |
| `org decide <ID> <text> [--drop]` | A decision note plus a close (`done`, or `dropped` with `--drop`), in one transaction | 4 |
| explicit acceptance | With config `acceptance: "explicit"`, a worker's `done` report makes the item `awaiting_acceptance`, which does **not** resolve its blockers. `org accept <ID> [--review R-n]` closes it as done and records the evidence. Per-role override, for example reviewer reports accepted as they are. | 5 (defect 6) |
| `org today` | the operator's screen (Job 4) | 4 |
| `org audit [--json]` | invariant findings (Job 5) | 5 |
| sync fix | `org sync` skips an abandoned run whose report path now belongs to a newer open run | defect 7 |

## Job 2: exceptions

| Condition | Detected by | Automatic action | Alert | Clears when |
|---|---|---|---|---|
| a worker or session is `blocked` (permission prompt, question) | agent state | none; the loop never answers a prompt in another pane | *needs you*: "settle-r-2-1344 has waited 50m on a prompt, tab `settle R-2`" | it is working again, or gone |
| a session isn't logged in, or started on the wrong account (defect 1) | launcher checks, which already exist; the account warning becomes an alert | no retry | *needs you* | the next launch succeeds |
| a run stopped without a report, or its worker is gone | agent state plus the report path | open a `continue` session focused on the run (abandoning or re-dispatching is within authority) | *info* | the run is abandoned or reported |
| a finished run can't be settled (cap, STOP) | brakes | wait, then settle when allowed | *info*, one per day, listing the runs | all are settled |
| a session stopped without doing its job | postcondition | retry once | *info*, then *needs you* | the postcondition passes |
| a session or run is taking too long | clock | none | *info*, then *needs you* | it stops |
| a provider or quota is exhausted | the session that hits it runs `org alert quota:codex "…" --until 2026-09-19T22:25` | none; routing stays with the sessions, which already handle it | *info* | expiry |
| a tool misbehaves (`org sync` error, non-atomic `lane close`) | the session that hits it records an alert instead of writing prose in OPEN-STATE | none | *info*; the audit turns repeat alerts into herdr-org items | a fix lands |
| the loop is down | heartbeat file older than 3 min | launchd restarts it | top line of `org today` (a dead loop can't raise an alert) | the heartbeat is fresh again |
| Herdr notifications are off | loop start-up probe (`notification show` returns `disabled`) | none | *needs you*, once | delivery is on |

**Notification policy.** Only *needs you* alerts and new `human` items
trigger a notification, once per key. Everything else waits for
`org today`. Today every settle session announced itself, and that kind of
noise gets notifications switched off. Delivery requires `[ui.toast]
delivery = "system"` in `~/.config/herdr/config.toml`, which is the
operator's config (incident 3).

Nothing opens a reasoning session just because something went wrong. Each
exception is one of three things: mechanical (the loop handles it), a
decision within authority (a `continue` session), or the operator's (an
alert).

## Job 3: planning

**The operator's input** is one command:
`org direct "Protocol v1 publication is the priority …"`. The operator never
creates plan items by hand.

**Triggers**, all evaluated by the loop:

- **Morning**: weekday mornings (default 07:30), using the reserved slot.
- **Direction**: a `direction` note newer than the latest `plan` note.
- **Starvation**: nothing is active, no prioritized item is ready, and the
  prioritized work isn't all waiting on `human` items. If it is all waiting
  on the operator, a plan can't help. The loop opens no session and raises
  one *needs you* alert that lists the decisions. At most one starvation
  plan runs every 3 hours.

On 09-16, the direction trigger would have fired as soon as the operator
recorded the release priority, and step 2 of `PLAN.md` exists to catch the
release plumbing that org was missing.

**`PLAN.md`**, in order:

1. **Read**: `org today`, new directions, the latest audit note, open alerts,
   `org snapshot`, and OPEN-STATE's cautions.
2. **Coverage**: for each open goal, work back from its acceptance to the
   items that exist, and add what is missing, each with role, blockers,
   acceptance and priority. On the morning of 09-16, this step would have put
   the allowlists, target files, validation profiles, evidence records,
   release map and licensing into org.
3. **Prune**: drop superseded items, merge duplicates, and fix roles that
   should be `human`, recording why. Today HUM-1 and HUM-5 both ask the
   operator to adopt the fix.
4. **Prioritize** for the day. Operator-set priorities (actor = operator)
   stay untouched unless a newer direction supersedes them. All other
   priorities are the plan's to set, each with a recorded reason.
5. **Record**: `org note G-n --tag plan "<focus in 3–6 lines>; by tonight: <checkable expectations>"`.
6. **Dispatch** as in `SETTLE.md` §5, then stop.

**Authority.** The plan may create sub-goals and items under an operator
goal. Creating or changing a top-level goal is the operator's call: the plan
creates a `human` item with a recommendation instead.

**Cost.** One session per day, plus one per direction. Once the plan is
written, "what are today's goals?" is answered by `org today` at zero cost.

## Job 4: operator window

`org today` is one screen of at most 40 lines; `--all` shows the rest. The
mock-up below uses the live bch-cloak state at 15:00. The "unblocks" numbers
are real, derived from the blocking links.

```text
bch-cloak · 15:02 · loop ok · sessions 12/12 (plan ✓ · audit reserved) · 1 alert
FOCUS  plan 07:31 (plan-0731)
  Protocol v1 publication: close the theft-fix path (REV-7, ENG-7 → REV-9),
  then the release plumbing (ARCH-18 → ENG-11 …).
  By tonight: REV-7 settled · ENG-7 VM evidence · ARCH-18 dispatched

NEEDS YOU
  !  settle-r-2-1344 has waited 50m on a permission prompt   tab "settle R-2"
  ARCH-3  D1: where package retention binds          unblocks 8 on the path · rec: …
  HUM-2   Authorize L3 execution                     unblocks 5 · rec: …
  HUM-5   Adopt fix O1 (owner co-signature)          unblocks 2 · rec: adopt after REV-9
  HUM-8   Licensing and visibility, five repos       unblocks 1 (REV-10)
  … 4 more, none on the path                          org today --all

G-1  Protocol v1 publication     14 done · 3 active · 24 blocked · 9 ready
  next: REV-7 ▶ · ENG-7 ▶ · HUM-1 · ARCH-3 · ARCH-18 · HUM-2 · HUM-8

RUNNING
  R-15  REV-7  v0 line theft exposure      opus xhigh · 25m · tab "lane-source-anchor…"
  R-16  ENG-7  O1 seal in the local VM      opus xhigh · 25m
  R-14  REV-8  pstore design review         opus xhigh · 39m · backlog

TODAY  11 reports · 2 promotions · 8 items added · 14 session decisions
  14:37  exec-1433 settled R-2; prepared HUM-5, HUM-6
  14:14  settle-r-12-1408 promoted pstore v0.3 at 7344ff3f (REV-4 pass)
  …
LAST AUDIT  none yet
```

- **Decisions are ranked by leverage**: how much unresolved prioritized work
  each one transitively unblocks. Each shows the recommendation from its
  latest note.
- **`next`** lists the goal's unresolved prioritized items in priority order.
- **Running items show their tab label**, so the operator can find them
  among the tabs.
- **The first line** shows loop health, sessions used, reservations and
  STOP.

**The operator's commands:**

- `org decide HUM-5 "Adopt O1 once REV-9 passes"`. The loop sees an operator
  decision newer than the last session and opens a `continue` session within
  a minute.
- `org direct "…"` triggers a plan session.
- `org clear <key>` acknowledges an alert.
- `touch .lane/supervisor/STOP` works as it does today.

**Where it runs.** On demand in any terminal, or in a pinned Herdr tab
running `org-today --follow` (contrib), which re-renders whenever
`events.jsonl` changes.

**When the operator wants reasoning**, `brain.sh ["question"]` opens a fresh
session. Its cold start is `org today --all`, `org snapshot`, `north-star.md`
and `BRAIN.md`. `BRAIN.md` tells it to:

- answer the question;
- record any outcome with `org decide` or `org direct`;
- tell the operator it can be closed.

It must not:

- monitor, or wait on workers;
- answer prompts in other panes;
- edit tooling unless asked.

The loop raises an *info* alert once a brain session has been open for two
hours. That alert is the visible guard against another all-day chat.

## Job 5: oversight

Three layers, cheapest first.

**1. Make the known mistake visible (org core).** Explicit acceptance, as
described above. A worker's `done` no longer unblocks dependents, and
closing the item needs `org accept`, which records the review run. Under
this rule, R-2's study would have stayed `awaiting_acceptance`, and ENG-8
("implement the adopted fix") would have stayed blocked.

**2. Invariants at zero inference.** `org audit` runs on every loop tick,
and any new finding becomes an alert:

- an item was accepted without a review reference (roles that require one);
- a run was started on a `human` item;
- a backlog run was started while a prioritized item was ready (checked
  against the fold at that run's sequence number);
- more than one backlog run is open;
- a session changed an operator-set priority with no newer direction;
- an item was reopened more than twice;
- a run finished more than 30 min ago and is still unsettled, with budget
  available;
- **project checks**, configured as commands in the project. For bch-cloak:
  every commit on `main` since the last audit has an accepted review naming
  its SHA. That check needs git, so it belongs to the project, not the org
  core.

**3. The evening audit session (`AUDIT.md`).** It runs only if events were
recorded since the last audit, so an idle day costs nothing. Where possible
it uses a different harness or model from the day's executive; Codex returns
after 2026-09-19. That gives the executive's own work an independent
reviewer, the rule `SETTLE.md` §2 already applies to engineers.

- **Reads**: `org audit`, the day's decision notes, the plan's expectations,
  promotions, open alerts.
- **Judges** what a rule can't:
  - whether each acceptance and unblock was justified by the evidence it cites;
  - whether decisions stayed within `AUTHORITY.md`;
  - whether the day followed the plan, and if not, whether the deviation was
    recorded;
  - whether anything is stuck.
- **May**: reopen items, add items, raise alerts, and create `human` items,
  including proposed changes to `AUTHORITY.md` or `SETTLE.md`. Changing the
  protocol stays the operator's decision.
- **May not**: dispatch or promote anything.
- **Records**: `org note G-n --tag audit "<findings>"`, plus a note on each
  affected item. The next morning's plan reads these, and `org today` shows
  the count.

## Target day

07:30 plan → the loop settles and continues all day → the operator glances
at `org today`, answers with `org decide`, and redirects with `org direct` →
18:30 audit → nothing left open.

Tokens go to one plan session, N settle sessions, one audit session, and any
brain sessions the operator chooses to open. The design/monitoring chat line
in the cost table is zero.

**Incidents from the M1 pilot, and what handles each:**

- 2: session guard
- 3: notification probe and policy
- 4, 9, 10: a single loop under launchd
- 6: explicit acceptance
- 7: sync fix
- 11: `BRAIN.md`
- 12: reservations and settles queued until the budget resets
- 1: the launcher alert turns it into a visible exception; the cause is
  still open
- 5, 8: already fixed in the protocol

## Build order

**M2a: unattended safety** (before the next pilot day)

1. `ORG_ACTOR` for every session; alerts; the loop with guard, brakes,
   reservations and heartbeat; the launchd plist; the notification policy.
   Retire per-run watchers.
2. Explicit acceptance and `org accept`; the sync fix.

**M2b: the operator's channel**

3. `org today`, `org decide`, `org direct`, tagged notes; `brain.sh` and
   `BRAIN.md`.

**M2c: scheduled reasoning**

4. `org audit`, `AUDIT.md` and audit mode.
5. `PLAN.md`, plan mode and its triggers.

**Pilot M2** runs on bch-cloak and is measured the way M1 was, plus:

- how many times the operator opened a chat to supervise (target 0);
- time from an exception to its alert;
- exceptions caught by the loop versus by the operator;
- audit findings that turned out to be real.

## Operator decisions

**Decided 2026-09-16 (later the same day).** The operator accepted the
recommendations below, with these changes:

- **24/7 operation**, weekends included.
- **Daily session cap raised to 30** for now, as a ceiling until the loop is
  efficient. It is passed by bch-cloak's launchers.
- **Remote Control is on for every Claude session** (`remoteControlAtStartup`
  in both config dirs), so the operator can follow and answer sessions from
  the Claude app.
- **Every decision needs the operator's approval for now.** Agents research
  and recommend; the operator approves or declines in the Herdr Brain console.
  Categories are relaxed later, based on the approval record.
- **`org today` / `org decide` from Job 4 are replaced** by
  `spec-brain-console-v1.md` (`org ask`, `org answer`, `org today --json`,
  and an Ink console in a Herdr pane). The console is built first; the loop
  (M2a) follows.
- **Beads** (steveyegge/beads) is to be evaluated as the state backend.
  `org today --json` is the read seam that makes that swap possible.

1. **Scheduler: launchd on this Mac** (recommended). The loop needs local
   Herdr and local files, so cloud routines can't host it. Consequence:
   nothing runs while the Mac sleeps.
2. **Notifications: `system` delivery**, sent only for *needs you*.
3. **Plan and audit slots**: inside the cap of 12 (recommended; this leaves
   10 for settles) or in addition to it.
4. **Plan's priority authority**: re-rank everything except operator-set
   priorities (recommended), or only propose changes.
5. **Schedule**: plan at 07:30 and audit at 18:30 on weekdays; weekends
   on or off.
6. **Acceptance for bch-cloak**: explicit, with reviewer reports accepted as
   they are (recommended).

## Not decided here

- a Herdr plugin pane for `org today`;
- one loop across several organizations;
- trimming the ~54k cold-start floor;
- a phone-reachable channel for *needs you*.
