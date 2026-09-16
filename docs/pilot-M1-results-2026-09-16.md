# Pilot results — 2026-09-16, bch-cloak

Read `north-star.md` first; this records what one day of running toward it showed.
It is written so a fresh session can continue the design discussion without the
chat that produced it. All times America/Chicago unless marked UTC.

## One-line result

**Ephemeral sessions replaced the supervisor's *transition* work cheaply and
correctly — and the supervisor's other four jobs moved into a new long-running
chat, which then cost more than the supervisor it replaced.**

## What ran

- Retired: the bch-cloak supervisor chat (tab `supervisor`), after it wrote its
  own open-state handoff.
- Durable state: `org` at `/Users/rewt/development/bastian/.org`.
- Loop: `herdr-org/contrib/settle-watch.mjs` (one watcher per run; waits inside
  Herdr with `herdr agent wait`, zero inference) opens a fresh Claude Opus session
  per finished run, following `bch-cloak/.lane/supervisor/SETTLE.md` (the
  executive protocol). That session verifies, records in org, decides within the
  orchestrator's authority, dispatches the next work with the project's
  `scripts/lane/lane.mjs`, arms its watcher, and stops.
- Operator entry points: `.lane/supervisor/arm-watch.sh R-n`,
  `.lane/supervisor/continue.sh "focus"`; brakes: `.lane/supervisor/STOP`, a
  daily cap of 12 sessions (ledger `sessions-YYYY-MM-DD.log`), ≤ 3 dispatches per pass.

Between 12:41 and 14:38: runs R-1 … R-16 (R-4/R-5 abandoned — Codex quota
exhausted until 2026-09-19 22:25, re-dispatched on Claude), 14 settle/executive
sessions, 6 commits promoted to local `main` (`22f27837` → `7344ff3f`, nothing
pushed), every one covered by an independent review PASS (two of them only after
the fact — see incidents).

## Measured cost (Claude transcripts, input = all context tokens read)

| Who | Sessions | Calls | Context per call | Input read | Output |
|---|---|---|---|---|---|
| Old supervisor chat, 2026-09-16 until 12:14 | 1 | 163 | 103k → **856k** | 78.1M | 458k |
| Settle + executive sessions, from 12:40 | 14 | 274 | median start 54k, peak **124k** | 23.2M | 167k |
| Lane workers (the actual R&D), from 12:40 | 13 | 481 | median start 62k, peak 516k | 92.5M | 770k |
| **This design/monitoring chat, 2026-09-16 UTC** | 1 | 251 | 131k → **596k** | **99.0M** | 296k |

Reading it:

- The coordination layer the loop provides cost 23.2M for 13 worker runs in two
  hours — flat-sized sessions instead of a context that grows all day. That part
  of the thesis held.
- Workers dominate, which is correct: reasoning should cost tokens.
- The monitoring chat cost more than the supervisor it replaced. Part of that is
  building and debugging the tooling live; the rest is supervision that has no
  other home yet (next section). **No savings can be claimed until that chat is
  gone.**
- A fresh session's floor is ~54k before it reads anything project-specific
  (system prompt, tools, claude-mem start-up context ~11k). A trimming target.

## The five jobs of a day supervisor

| Job | Where it lived today | Status |
|---|---|---|
| 1. Route transitions (worker stops → verify → record → next work) | watchers + fresh settle sessions | **works** |
| 2. Handle exceptions (stuck prompts, wrong account, caps, overlap, tool bugs) | this chat | no home |
| 3. Plan and prioritize (what matters today; is the plan in org at all) | this chat | no home |
| 4. Be the operator's window (what is going on, what needs me) | this chat | no home |
| 5. Oversee quality across sessions (skipped reviews, unsafe unblocks, drift) | this chat, partly the protocol | partial |

Evidence for each gap:

- **2** — Watchers "notified" failures, but Herdr notifications are off
  (`[ui.toast]` unset in `~/.config/herdr/config.toml` → delivery off). A settle
  session sat on a Claude permission prompt for 50 minutes; only this chat noticed.
- **3** — Most of the protocol-release plan (allowlists, target files, validation
  profiles, evidence records, release map, licensing) was not in org, so the loop
  prioritized what existed and spent four runs on pstore housekeeping. The
  operator had to say "the priority is protocol release"; this chat then rebuilt
  the org graph around it.
- **4** — `org status` is accurate but long and unranked for a human; with 32 tabs
  open the operator could not tell what was running or whether it mattered.
- **5** — A settle promoted two spec commits without an independent review; `org
  sync` marked a study done on the worker's own report, which unblocked
  "implement the adopted fix" before any fix was adopted. This chat caught both.

## What worked

- **Workers write valid org reports.** Every report since R-3 passed `org check`
  unedited, and workers decomposed their own follow-ups (e.g. R-3 proposed two
  architect items the brief forbade it to do itself; R-2 proposed six, correctly
  marking two as operator decisions).
- **Settle sessions verify for real.** They re-derived hashes and HEADs, re-ran
  repros, and refused to accept a worker's self-reported `done` once the protocol
  said so.
- **The review discipline held** after it was written into `SETTLE.md` §2: every
  later promotion had an independent PASS on the exact SHA.
- **Authority delegation worked** once the protocol granted the supervisor's own
  authority (from `AGENTS.md` Roles): sessions accepted, promoted, closed lanes,
  placed holds, deferred decisions, and escalated only what is the operator's.
- **Adaptation**: sessions routed around the Codex quota, merged duplicate items,
  held work behind the right blockers.
- **The loop recovered** from its watchers' waits being killed (30 s back-off).

## Incidents and defects (fix before relying on unattended runs)

| # | What happened | State |
|---|---|---|
| 1 | Herdr drops `CLAUDE_CONFIG_DIR` for sessions the watcher starts, so they run from `~/.claude` (same personal account, different local config) while lane workers get `~/.claude-personal`. Cause not found. | open |
| 2 | Claude "Allow reads outside the working directories?" prompt blocked a settle 50 min. | launcher now passes `--add-dir` for `bastian/` and `~/.herdr/worktrees/bch-cloak`; the stuck session was closed |
| 3 | Herdr notifications disabled, so every alert was invisible. | open (operator config) |
| 4 | Two settle sessions ran at once. | watchers now take turns (lock + wait for working sessions) |
| 5 | Protocol pointed at the generic `lane` instead of bch-cloak's `scripts/lane/lane.mjs` and its tier file. | fixed in `SETTLE.md` |
| 6 | `org sync` treats a worker's `done` as done; the project allows only independent review to do that. Sessions reopen by hand. | **org design gap** |
| 7 | `org sync` scans abandoned runs; a re-dispatch sharing the report path errors on every sync. | org bug |
| 8 | Operator decisions were stored as ready architect items. | protocol now uses `role=human`; never dispatched |
| 9 | Tab sprawl (32 tabs). | watchers close their own tab and the stopped worker's; opener prunes finished session tabs beyond the newest two |
| 10 | This chat killed the watchers' wait processes by pattern. | recovered; never kill by pattern |
| 11 | This chat closed a settle session that had just resumed after `/login`. | recovered by relaunch |
| 12 | Daily cap of 12 reached at 14:33; later results are not settled today. | operator kept the cap at 12 |

## What would remove the chat (proposal, not decided)

Give jobs 2–5 homes that are not a live conversation:

- **Exceptions → org.** Watchers and sessions write failures as ATTENTION items
  in org; notifications on. Seen without asking anyone.
- **Planning → a short morning session.** Fresh; reads operator direction, org,
  yesterday's results; writes the day's priorities and missing plan items into
  org; exits.
- **Operator window → zero-inference `today` view + `decide` command.** One screen:
  release-path progress, running, finished today, decisions waiting, incidents.
  `decide HUM-5 "…"` records the answer and opens a continue session.
  Discussion happens in a disposable brain session started from org +
  `north-star.md` + this file, closed afterwards.
- **Oversight → a short evening audit session.** Checks promotions had reviews,
  unblocks were safe, priorities did not drift, nothing is stuck; writes findings;
  exits.
- **org**: an accepted/awaiting-review distinction (defect 6) and the sync bug (7).

Target day: morning plan → loop runs → operator glances at `today`, answers with
`decide` → evening audit → nothing left open. Success is measured the same way as
today, and a design/monitoring chat line in the cost table should read zero.

## State at 14:40 (for whoever continues)

- Running, each with a watcher: **R-15 / REV-7** (does the already-published v0
  line have the same theft exposure — priority 55), **R-16 / ENG-7** (execute fix
  O1 in the local BCH VM), R-14 / REV-8 (pstore design review, backlog). The cap
  is reached, so their watchers will not open settle sessions today; reports land
  in `bastian/archive/`, and `org sync && org status` (zero inference, from
  bch-cloak) records and shows them.
- Org is organized around **protocol v1 publication** (G-1). Critical path:
  REV-7 → freeze ARCH-9 (gated on the fix HUM-5/ENG-7/REV-9/ENG-8/REV-6, D1 ARCH-3,
  WALLET-POLICY ARCH-8, D2 ARCH-4, wording ARCH-11 family) → release steps
  ARCH-18 (release map, ready now), ENG-11 … ENG-15, HUM-8, REV-10.
- Waiting on the operator: HUM-5/HUM-1 (adopt O1), ARCH-3 (D1), HUM-8
  (licensing), HUM-2 (L3 execution), HUM-6 (five unspent L2 seal cells),
  HUM-3, HUM-4, HUM-7.
- Findings of the day: the successor path is **exploitable at host level** (R-1,
  reproduced); the recommended fix is O1, an owner co-signature on the seal's
  aggregate branch (R-2), not yet executed in the VM.
- `herdr-org` has no commits yet; everything above is untracked files.
