# Herdr Brain 0.1.0: one instrument panel

Date: 2026-09-17, America/Chicago. Status: **proposed, nothing built.** This is
the spec an engineer builds from. The evaluation that produced it, with the
measurements, is `docs/reports/brain-0.1.0-evaluation.md`; read that when you
want to know *why*, read this when you want to know *what*.

It absorbs `spec-waiting-on-you-0.0.3.md` and supersedes its screen. It builds
the parts of `design-M2-supervisor-homes.md` that a day of running proved
necessary and drops the rest. Section 14 says exactly what happens to each
earlier decision.

## 0. The model in one paragraph

A **project** is a repository checkout that has an `.org`. Everything the brain
knows about the project lives in that `.org`: the goals, the stages, the items,
the runs, the reports, the decisions, and one small `project.json` that says
where the checkout, the lanes and the protocol are. **One loop** per project,
zero inference, watches the runs and Herdr, records what is mechanical, and
opens a short session only when a judgement is needed. **One read model**,
`org today --json`, is the only thing any screen reads. **One panel**, the
console, shows every session with the goal and stage it serves, everything
that waits on the operator, and where the open stage stands, and lets the
operator peek, reply, answer, redirect and stop without leaving. Herdr is the
terminal and the session state. Lanes are the worktrees. claude-mem stays
beside all of this, not inside it.

## 1. What is wrong today, in five lines

Measured on the live bch-cloak organization and its Herdr session on 2026-09-17
(details and numbers in the evaluation report):

1. **The operator cannot see what the fix is doing** because the plan for it is
   prose in a 21 KB file that a session rewrites every pass, the panel groups
   sessions by repository not by goal, and nothing anywhere says "step 3 of 8,
   held by one review".
2. **The operator's answer went into a session's prompt box, not into org.**
   That session is stuck on a first-run dialog because it runs on the wrong
   Claude account. The panel shows neither fact as "waiting on you".
3. **Coordination costs 4× the chat it replaced.** 80 settle sessions today read
   425M tokens of context (median 4.1M and 44 calls each) to run a markdown
   protocol; the pilot called a 99M chat a failure.
4. **A project is six things**: an identity folder, an `.org`, lane worktrees in
   two roots, a Herdr workspace, a console config entry and a supervisor folder
   of scripts with the project's paths hard-coded.
5. **Worker-said-done and accepted are one status.** 51 reopen events and 7
   notes of sessions fighting `org ingest` in 28 hours; 49 open items sit
   "done" that nobody accepted.

## 2. The model

### 2.1 Five words

| Word | Meaning | Where it lives |
|---|---|---|
| **project** | a repository checkout with an `.org` | `.org/project.json` |
| **goal** and **stage** | what the project is trying to reach, in order | goal items; `meta.stage` on items; `stages` in `.org/config.json` |
| **item** | one piece of work with a role, a stage and a status | `.org/events.jsonl` |
| **run** and **session** | one attempt on an item, and the terminal it runs in | run events (`meta.agent` names the Herdr agent) |
| **decision** | a question only the operator answers, with options and a recommendation | a `role: human` proposal on a report; answered by one event |

Nothing else is a first-class thing. A lane is how a run gets a worktree. A tab
is where a session lives. A watcher, a ledger and a supervisor directory are
implementation details this spec removes or folds into the loop.

### 2.2 A project is one file

`.org/project.json`, read by the loop and the console, ignored by the org core
(which never talks to Herdr, lanes or Claude):

```json
{
  "name": "bch-cloak",
  "checkout": "/Users/rewt/development/bastian/bch-cloak",
  "add_dirs": ["/Users/rewt/development/bastian", "/Users/rewt/.herdr/worktrees/bch-cloak"],
  "lane": { "bin": "node scripts/lane/lane.mjs", "worktree_root": "/Users/rewt/.herdr/worktrees/bch-cloak" },
  "protocol_dir": ".org/protocol",
  "launch": { "via": "/Users/rewt/bin/ai", "memory": "/Users/rewt/development/claude-mem/bin/cmem-domain" },
  "routes": {
    "settle":  { "harness": "claude-code", "model": "opus", "effort": "high" },
    "review":  { "harness": "claude-code", "model": "opus", "effort": "xhigh", "use": "Independent review" },
    "engineer": { "harness": "claude-code", "model": "opus", "effort": "high", "use": "Default engineering" }
  },
  "limits": { "workers": 3, "settle_sessions_per_day_alert": 40 },
  "report_dir": "/Users/rewt/development/bastian/archive"
}
```

Rules:

- The console **discovers** projects: every `.org` with a `project.json` under
  the roots listed in `~/.config/herdr-org/console.json` (`"roots": [...]`).
  The per-project entries in `console.json` (`org`, `cwd`, `ledger_dir`,
  `claude_config_dirs`, `session_cap`) go away; the file keeps only `roots`,
  `refresh_seconds`, `glyphs`, `peek_colour` and `routes` defaults.
- The **identity folder** (`~/development/{rewt,bastian,costco}`) stays what it
  already is in `~/bin/ai` and `domains.conf`: the account boundary (Claude
  config dir, GitHub config, claude-mem domain). It is not a project and holds
  no project state beyond its `.lane.json`. Nothing new is added to it.
- **The protocol moves into the org**: `bch-cloak/.lane/supervisor/*` becomes
  `bastian/.org/protocol/{SETTLE.md,AUTHORITY.md,CAUTIONS.md}` plus
  `STOP` and the ledger. `stage.sh`/`stage.py`, `arm-watch.sh` and
  `continue.sh` are deleted once the loop runs (section 7).
- **Two worktree roots stay two** for 0.1.0. `project.json` names the root, so
  the console and the loop stop guessing. Unifying bch-cloak's `scripts/lane`
  fork with `~/.local/bin/lane` is a lanes change, out of scope here.

### 2.3 Who owns what

| Concern | Owner | Never |
|---|---|---|
| goals, stages, items, runs, reports, decisions, status | org core | talks to Herdr, lanes, Claude or a model; runs in the background |
| project paths, routes, limits | `.org/project.json` | is read by the core |
| watching runs and sessions, recording reports, opening a session when a judgement is needed, closing finished tabs, notifying | the loop (`contrib/loop.mjs`) | decides anything a protocol section calls a judgement |
| judgement: verify claims, accept on review, decide within authority, write briefs, dispatch | a short settle session under `SETTLE.md` | monitors, polls, or waits on workers |
| the operator's screen and verbs | the console, reading `org today --json` and `herdr agent list` | writes to `events.jsonl` directly; stops or kills an agent |
| terminals, agent state, prompts, keys | Herdr | is asked to hold project state |
| worktrees, branches, promotion | lanes | keeps a session registry the panel reads |
| per-worker recall | claude-mem | is read by the loop, the core or the console |

### 2.4 What is deleted or merged

Deleted:

- `org ask` and the `org set … meta.*` enrichment pass (decided in 0.0.3).
- Per-run watchers as the control loop: `arm-watch.sh`, `continue.sh`, the
  per-run lock, the take-turns lock, the `--spawn` watcher tabs and
  `pruneSessionTabs`. `settle-watch.mjs` stays in `contrib/` until the loop
  has run one full day on bch-cloak, then is removed.
- The daily session **cap as a brake**. It stopped work on day one at 14:33 and
  was raised from 12 to 30 to 100 within a day; a brake that is raised
  whenever it fires is not a brake. It becomes an alert.
- `OPEN-STATE.md` as a session-rewritten state file. Its cautions become the
  static `CAUTIONS.md`; its state was already in org or belongs there.
- `TODAY.md`, `PROJECT.md`, `monitoring-*.md` in the supervisor folder and the
  `.lane-supervisor/<version>` folders at the identity level: stale, moved to
  `archive/` by the operator.
- The console reading Claude transcripts for **session notes**. The model name
  lookup (WHO) stays, bounded to one file per named agent as it is now.
- `console.json` per-project entries (replaced by discovery).
- The lanes session registry (`.lane/sessions.json.d`, `lane board`) as a
  source for the panel. It records a goal of "Brief: run R-4 on ENG-1" and
  a status of "offline" for live sessions; org runs plus `herdr agent list`
  already carry the truth. `lane board` itself is a herdr-lanes concern and is
  not touched; the console simply never reads it.

Merged:

- `contrib/org-map.mjs` into `org today --json` as `ladder` and `path`
  (section 3). The script is deleted once the tests move.
- `contrib/tidy-tabs.mjs` into the loop as its tidy step; the pure
  `planTidy()` and its tests move with it.
- `stage.sh`/`stage.py` into the core's stage awareness (`org today`,
  `org start`).
- `settle-watch.mjs`'s launch code (account resolution, `--add-dir`, memory
  args, the login check) into `contrib/lib/launch.mjs`, shared by the loop and
  the dispatch chain.

## 3. The read model: `org today --json` in 0.1.0

Deterministic given (events, config, now, TZ). Everything below is added to
the 0.0.2 document; nothing existing is removed in this version. The console
reads this and `herdr agent list`, nothing else.

```jsonc
{
  "project": { /* as today, plus */ "name": "bch-cloak", "stages_configured": true },

  "ladder": {                                   // from org-map.mjs
    "open_stage": "1",
    "stages": [
      { "stage": "1", "name": "close the theft hole", "goal": "G-2", "is_open": true,
        "total": 35, "done": 9, "open": 26, "running": 2, "blocked": 13, "ready": 9, "decisions": 2 },
      { "stage": "2", "name": "freeze, then re-run the transfers", "goal": "G-3", "total": 9, "done": 0, "open": 9, "decisions": 0 },
      { "stage": "keys", "name": "proving-key storage", "goal": "G-6", "standing": true, "total": 8, "done": 2, "open": 6, "running": 1 },
      { "stage": "parked", "name": "parked by the operator", "open": 31 },
      { "stage": null, "name": "no stage", "open": 49 }
    ]
  },

  "path": {                                     // the open stage, derived; zero inference
    "stage": "1", "name": "close the theft hole", "total": 35, "done": 9,
    "done_items":    [ { "id": "ENG-32", "title": "…", "short": "wallet signs each consumed cell", "accepted_by": "REV-52" } ],
    "now":           [ { "id": "REV-54", "short": "review of the freeze document", "run": "R-117", "agent": "lane-freeze-policy-cod-213357", "since": "…" } ],
    "next":          [ { "id": "ENG-34", "short": "assembler places signatures", "priority": 45 } ],   // ready, by priority
    "held": [                                   // blocked, grouped by the blocker that holds the most
      { "by": { "id": "REV-54", "short": "review of the freeze document", "kind": "run", "run": "R-117" }, "count": 5, "items": ["ARCH-51", "ARCH-52", "ENG-38", "ENG-98", "ARCH-54"] },
      { "by": { "id": "HUM-28", "short": "quit the browsers", "kind": "decision" }, "count": 1, "items": ["ENG-84"] }
    ]
  },

  "waiting": [                                  // 0.0.3: decisions in the open stage, ready; PLUS session rows the console adds
    { "kind": "decision", "id": "R-111.1", "title": "…", "category": "design", "options": [ … ], "recommend": "yes", "blocks": [ … ], "stage": "1", "asked": "…" }
  ],
  "not_ready": [ … ],                           // 0.0.3
  "later_stages": [ { "stage": "4", "count": 9, "titles": [ … ] } ],   // 0.0.3
  "legacy_questions": [ … ],                    // 0.0.3

  "running": [ { /* as today, plus */ "stage": "1", "goal": "G-2", "goal_short": "close the theft hole", "role": "reviewer", "short": "review of the freeze document", "round": 1 } ],
  "agent_runs": [ /* as today, plus the same fields */ ],

  "sessions_expected": [                        // every agent name org knows, with what it serves
    { "agent": "lane-freeze-policy-cod-213357", "run": "R-117", "item": "REV-54", "kind": "worker" },
    { "agent": "settle-r-115-1628", "run": "R-115", "item": "ARCH-51", "kind": "settle" }
  ],

  "alerts": [ { "key": "session:settle-r-115-1628:blocked", "level": "needs_you", "text": "…", "on": "R-115", "since": "…" } ],
  "loop": { "heartbeat": "2026-09-17T21:41:03Z", "stop": false, "sessions_today": 56 },

  "finished": [ … ], "decided": [ … ], "approvals": { … }, "attention": [ … ]
}
```

Definitions the core must implement:

- **`short`** for an item: the title up to the first `:`, `(` or ` — `, then
  cut at a word boundary to 40 cells. Codes are stripped. It exists so every
  screen names the same item the same way.
- **stage name** for a goal: the title after `Stage N —` up to the first `:`.
- **`path.done`** counts items in the open stage that are closed `done`, or
  accepted when acceptance is explicit (section 9). A worker's own `done`
  report does not count.
- **`held`** groups the open stage's blocked items by their unresolved
  blocker; a blocker with an open run is `kind: run`; a `role: human` blocker
  or a pending decision is `kind: decision`; else `kind: item`. Largest group
  first, at most five groups.
- `loop` and `alerts` come from events the loop writes (section 7); with no
  loop events they are `null` and `[]`.

## 4. The instrument panel

The console keeps its packaging, theme, glyphs, `NO_COLOR`, popup machinery,
mouse handling and tests from 0.0.2a. The **screen changes**: it is organized
by what the project is trying to do, not by repository.

### 4.1 At 140 × 40

Live data from bch-cloak at 16:41 on 2026-09-17, rendered as this spec wants
it. Every row is what the operator would actually have seen.

```text
 bch-cloak  16:41  stage 1 of 4 · close the theft hole  9/35 done  3 running  2 waiting on you  loop ok        console 0.1.0  ? help
╭ WAITING ON YOU ──────────────────────────────────────────────────────────────────────────────────────────────────────────── 2 ╮
 > ■ A settle session is stuck at a Claude dialog, and your reply is sitting unsent in it        12m    Enter peek · 1-3 answer it
   ! Should the payment data packet stop carrying four fields the receiver recomputes?           design · from a session 15:37
       1  yes   the packet shrinks; two freeze-window items are written against the smaller shape           ← recommended
       2  no    the four fields stay, and the wallet must refuse a mismatch instead
       holds up 2 things in this stage · memo recorded
╭ THE FIX · stage 1 · close the theft hole ────────────────────────────────────────────────────────────────────────── 9 of 35 ╮
   done   wallet signs each consumed cell ✓   parity gate in validate:protocol ✓   pstore ingest ✓   … 6 more
   now    aggregator verifies signatures — being settled (3m)   ·   review of the freeze document — running (7m)
   next   assembler places signatures  ·  circuit size under seal v2  ·  replays bind the v1 profile  ·  seed binds profile id
   held   9 wait on the freeze-document review (running now)   ·   1 waits on you: quit the browsers   ·   3 wait on the assembler
╭ SESSIONS · what each one serves ──────────────────────────────────────────────────────────────────────────────────────────── 5 ╮
     SESSION                       WHO                    WHERE              UP   STATE    SERVES                DOING
   ● review of the freeze document Claude Opus 5 · xhigh  lane freeze-policy 7m   working  the fix · stage 1     reading the checklist gate
   ● review of pstore §9.2         Claude Opus 5 · xhigh  lane pstore-lease  18m  working  key safety · standing checking lease staleness
   ● settling: aggregator run      Claude Opus 5 · high   bch-cloak          3m   working  the fix · stage 1     verifying the run's claims
   ■ settling: freeze document run Claude Opus 5 · high   bch-cloak          12m  blocked  the fix · stage 1     stuck at a Claude dialog
   ✓ v1 fixture replay             Claude Opus 5 · xhigh  lane source-anchor 5h   done     the fix · stage 1     finished 11:48 · unread
╭ IDLE · 8 sessions nobody is using ─────────────────────────────────────────────────────────────────────────────── i to show ╮
╭ LATER ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
   stage 2  freeze, then re-run the transfers · 9      stage 3  public demo corpus · 3      stage 4  five-repo release · 46 (9 decisions)
   parked 31  ·  no stage 49  ·  key safety: 1 running                                                                / to open one
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Task   n  Describe the outcome. Enter adds a line.      Where [bch-cloak]   Who [review]   Goal [the fix]            Review launch
  Enter peek  g go there  r reply  1-9 pick  a answer  w work it up  b holds up  S stop/resume loop  / stage  h history  ? help  q quit
```

Rows 1–38 used; two spare. Rules:

- **Header**: project · clock · `stage N of M · <stage name>` · `done/total`
  for the open stage · sessions running · waiting count (alert colour above
  zero) · loop health (`loop ok`, `loop down 4m`, `STOP`) · version · help.
  Herdr unavailable and stale org data stay as alert segments.
- **Waiting on you** follows 0.0.3 exactly (decisions with their options under
  the row, not-ready and later-stage groups), plus **session rows** for
  `blocked` and `done` agents, sorted `blocked` then `done`, oldest first, above
  the decisions. A blocked session's row says what it is stuck on in words,
  read from its screen: a Claude dialog, a permission prompt, a question. If
  its prompt box holds text, the row says so; the operator's unsent words are
  the most urgent thing on the machine.
- **THE FIX** is `path`. Four fixed rows: `done` (the first three short names
  with ✓, then `… N more`), `now` (each running item with its session state
  and age), `next` (ready items by priority, as many as fit), `held` (the
  `held` groups: count, what holds them, and whether that thing is running,
  waiting on the operator, or idle). The group name is the stage name; "THE
  FIX" is what the operator calls stage 1 today and is the stage goal's
  `short`; it is not hard-coded.
- **Sessions** lists every Herdr agent that is `working`, `blocked` or `done`,
  plus every org run whose agent is gone (`gone`), in one table. Idle sessions
  collapse into one line with a count; `i` expands them. Columns:

  | Column | Content | Source |
  |---|---|---|
  | SESSION | a plain name: `<role word> of <item short>` for a worker (`review of the freeze document`), `settling: <item short>` for a settle session, `deciding what's next` for a continue session, else the tab label or terminal title | org run + item; `herdr agent list` |
  | WHO | tool, model and effort in words, as 0.0.2 | run meta; Herdr `agent`; transcript model |
  | WHERE | `lane <topic>` for a lane worktree, else the checkout name | Herdr `cwd`, `project.json` |
  | UP | since the run started, else since Herdr first listed it | run `started`; console memory |
  | STATE | `working`, `blocked`, `done`, `idle`, `gone`, each with its glyph | Herdr `agent_status` |
  | SERVES | `<stage name> · stage N`, `<name> · standing`, `parked`, or `no goal` | run → item → stage goal |
  | DOING | Herdr's `terminal_title_stripped` if it says something beyond the agent's own name; else the brief's first sentence; else the item short; for a blocked session, what it is stuck on; for a done one, when it finished and whether it was read | Herdr; org |

  Group order is by state (blocked, working, done, gone), then by SERVES (open
  stage first), then by UP. Selection follows identity, as in 0.0.2.
- **Later** is one line per stage that is not open, plus parked and no-stage
  counts. `/` opens a stage picker that scopes THE FIX and SESSIONS to that
  stage; the header then says `viewing stage 4 (open stage is 1)`.
- **Launch bar and footer** as 0.0.3, with `S` (stop/resume the loop) added.
- Idle sessions are not hidden from `h history` or the `i` expansion; they are
  hidden from the main table because 26 of 33 agents were idle when this was
  measured and they buried the four that mattered.

### 4.2 At 80 × 24

```text
 bch-cloak 16:41  stage 1/4 close the theft hole  9/35  2 waiting  loop ok
╭ WAITING ON YOU ─────────────────────────────────────────────────────── 2 ╮
 >■ A settle session is stuck at a Claude dialog; your reply sits unsent 12m
  ! Should the payment packet stop carrying four recomputed fields?  design
     1 yes  packet shrinks; two freeze items written against it  ← recommended
     2 no   fields stay; the wallet refuses a mismatch instead
╭ THE FIX · stage 1 ─────────────────────────────────────────────── 9 of 35 ╮
  now   aggregator verifies signatures (settling 3m) · freeze-doc review (7m)
  next  assembler places signatures · circuit size · replays bind v1 profile
  held  9 on the freeze-doc review · 1 on you: quit the browsers · 3 on the…
╭ SESSIONS ─────────────────────────────────────────────────────────────── 5 ╮
  ● review of the freeze document   Claude Opus 5 · xhigh   7m   working
    the fix · stage 1 · reading FREEZE-CHECKLIST gate text
  ● review of pstore §9.2           Claude Opus 5 · xhigh   18m  working
    key safety · standing · checking lease staleness rules
  ● settling: aggregator run        Claude Opus 5 · high    3m   working
    the fix · stage 1 · verifying the run's claims
  ■ settling: freeze document run   Claude Opus 5 · high    12m  blocked
    the fix · stage 1 · stuck at a Claude dialog
↓ ✓ v1 fixture replay               Claude Opus 5 · xhigh   5h   done
╭ LATER  stage 2 · 9   stage 3 · 3   stage 4 · 46 (9 decisions)   parked 31 ╮
 Enter peek  g go  r reply  1-9 pick  a answer  S stop  / stage  ? help  q quit
```

At 80 columns THE FIX drops its `done` row (the header carries the count),
sessions take two lines each, SERVES and DOING share the second line, the
launch bar is reached with `n` and is not drawn resting, and LATER is one line.
At 100 columns the 140 layout is used with WHERE dropped and DOING shortened,
as 0.0.2 already does. Below 80 × 20, the resize hint.

### 4.3 The summary popup

Unchanged from 0.0.3 for decisions (Decision, Memo, Holds up, Context). For a
session row the tabs are **Message** (last assistant text, from
`herdr agent read`, not from transcripts), **Brief**, **Serves** (the goal,
the stage, the item, its blockers and what it blocks, in words), **Context**
(codes, paths, agent and pane ids, run, report path, account).

## 5. The round trip

Board → session → board, for the four cases the live install showed.

**A working session.** `Enter` peeks (0.0.3 §1): a 90 % popup with the
session's recent screen from `herdr agent read <name> --source
recent-unwrapped --lines 400`, re-wrapped, following the end. `Esc` returns
with the same row selected. `g` goes there (`herdr agent focus`), and
`last_pane` (bound in `~/.config/herdr/config.toml`, README setup line) brings
the operator back with one key. Run as a `type = "popup"` custom command, the
console opens over any pane and closing it restores the layout; the console
persists selection, scope and drafts to
`~/.local/state/herdr-org/console-<project>.json` (0.0.3 §4).

**A blocked session.** The row is first in Waiting on you. The peek shows the
dialog from the session's own screen, names the keys that answer it
(`1`–`9`, `y`, `n`, `esc`), and sends the chosen one with
`herdr agent send-keys <name> <key>` after a confirmation that names the key
and the session. After the key, the peek re-reads within two seconds. **If the
prompt box holds unsent text**, the peek shows it under `Your unsent reply:`
and the footer offers `Enter  send it` (`send-keys enter`, confirmed) and
`x  clear it` (`send-keys ctrl+u`, confirmed). This is the case measured
today: the operator's answer to the browser question was typed into
`settle-r-115-1628` and never sent because a "Teach auto mode about your
environment?" dialog was in the way.

**A finished session nobody read.** A `done` agent is a waiting row that says
when it finished. `Enter` peeks at its last message; peeking records the
agent name in the console's state file and the row leaves the group on the
next tick. The loop also closes a done worker's tab once its run's report is
recorded and a settle session has been opened for it (section 7), so a
session that finished and was settled does not sit as `done` for five hours,
as two did today.

**A session whose run is gone from Herdr.** Shown as `gone` for one hour, as
0.0.2; the loop raises an `info` alert if no report exists at the run's path.

**Replying.** `r` on any session row opens the own-words editor and sends the
text with `herdr agent prompt <name> "<text>"`, which refuses a blocked agent
before sending anything; the refusal is shown and the operator is pointed at
the dialog keys. A reply is also recorded as an org note on the run
(`org note R-n "operator: <first line>"`, actor `human`), so the answer is
durable even if the session dies.

## 6. Redirecting work

Direct verbs, each writing one thing. No interpreter. The operator's own words
reach a session only through `r` (reply) and `org direct`.

| Verb | Key | What it writes | Who acts on it |
|---|---|---|---|
| **Stop everything** | `S` | creates `.org/protocol/STOP` (removes it on the second press, confirmed both ways) | the loop opens no sessions and dispatches nothing; the header shows `STOP`; running workers finish on their own |
| **Answer a decision** | `1`–`9`, `y`/`n`, `a` | `org decide <run>.<n> <answer> [--note]` (0.0.3) | the loop sees a decision newer than the last session and opens a continue session |
| **Reply to a session** | `r` | `herdr agent prompt` + `org note` on the run | that session |
| **Answer a dialog** | `1`–`9`, `esc` in the peek | `herdr agent send-keys` | that session |
| **Open a stage** | `/` → `o` on a stage | `org set G-1 meta.stage_now=<N> --note "<why>"`, confirmed with the stage name | the next settle or continue session dispatches from it; nothing in flight is touched |
| **Park / revive an item** | `p` / `u` on a THE FIX or Later row | `org set <ID> meta.stage=parked` / `meta.stage=<open stage>`, with a required one-line reason recorded as a note | the next dispatch honours it |
| **Give direction** | `d` | `org direct "<one or two sentences>"` = a `direction` note on the top goal (M2) | the loop opens one continue session that reads it first and records what it changed |
| **Start a task** | `n`, Tab | the launch bar (0.0.3 piece 4): `org add` under the chosen goal in the open stage, `lane open`, brief, `org start`, dispatch, `org set R-n agent=` | the loop watches it like any run |
| **Work up a question** | `w` | `contrib/workup-question.mjs` (0.0.3) | a study session reports a real decision |

Not in 0.1.0: pausing or killing a session from the console, changing
priorities from the console, typing "do X" and having it interpreted. The
operator has said the last may be too complex for now; it is, and the launch
bar is the constrained form of it.

## 7. The loop

`contrib/loop.mjs --project <dir-with-.org>`. One process per project, kept
alive by launchd (`KeepAlive`, plist in `contrib/launchd/`), zero inference,
no state of its own except a heartbeat file. It replaces `settle-watch.mjs`,
`arm-watch.sh`, `continue.sh` and `tidy-tabs.mjs`.

**Tick**: every 30 s, and whenever `events.jsonl` or `STOP` changes. On each
tick it reads `org today --json`, `herdr agent list` (and `agent get` for the
agents it cares about), the clock and `STOP`, then applies a fixed rule table.
Rules are pure functions from (state, now) to actions, tested offline against
fixtures; the only side effects are `org` writes, `herdr` calls and
notifications.

**Rules, in order:**

1. **Heartbeat**: write `.org/loop.heartbeat` (mtime is the signal). Record
   `loop.tick` in org only when something below happened.
2. **Record reports** (mechanical, no session): for every open run whose report
   path exists and is non-empty, `org check` then `org ingest <path> --run
   R-n`. A report that fails `check` is still ingested (0.0.3) and the failure
   becomes an `info` alert on the run. A run whose report path is shared with a
   newer run is skipped (the sync fix, M2 defect 7).
3. **Watch sessions**: for every agent named by an open run or opened by the
   loop:
   - `blocked` → `needs_you` alert naming the session and what its screen
     shows (first dialog line); the loop never answers a prompt;
   - `done` or `idle` with a recorded report and a settle session opened → close
     its tab (the tidy rule);
   - gone with no report → `info` alert; after 10 minutes, `org abandon` with a
     note, and the item is ready again;
   - a settle session working for more than 45 minutes → `info`; 90 → `needs_you`;
   - a settle session that stopped without writing an event since it started →
     retry once, then `needs_you`.
4. **Open a settle session** when all of these hold: no `STOP`; no settle or
   continue session is `working`; and at least one of: a run was recorded
   since the last settle session started; an operator decision or direction is
   newer than the last session; the open stage has ready prioritized work, a
   free worker slot (`limits.workers`) and no session has run for 20 minutes.
   Several finished runs are settled by **one** session. At most one session
   every 10 minutes. The session's prompt names every run to settle and every
   new decision, and points at `SETTLE.md`.
5. **Tidy**: `planTidy()` from tidy-tabs, every tick, for this project's
   workspaces only.
6. **Notify**: `herdr notification show` for `needs_you` alerts only, once per
   key. The README tells the operator to set `[ui.toast] delivery = "system"`;
   the loop probes `notification show` at start and raises one `needs_you`
   alert if delivery is off (it is off today, and every alert of the pilot was
   invisible).
7. **Count, do not stop**: the ledger stays (`sessions-YYYY-MM-DD.log` in the
   protocol dir). Passing `limits.settle_sessions_per_day_alert` raises an
   `info` alert; nothing stops. `STOP` and `limits.workers` are the brakes.

**Launching a session** uses `contrib/lib/launch.mjs`, extracted from
`settle-watch.mjs`: account from `launch.via env` in the checkout, memory args
from `launch.memory`, `--add-dir` from `project.json`, `ORG_ACTOR=<session
name>` and `ORG_DIR` in the environment, a Herdr tab in the checkout's
workspace, `herdr agent start --name`, the login check, then `herdr agent
prompt`. **After start it verifies the account**: if the agent process does
not carry the intended `CLAUDE_CONFIG_DIR` (today's settle sessions carry
`AI_PERSONA=personal` and no `CLAUDE_CONFIG_DIR`, so they run on `~/.claude`
and hit first-run dialogs), it raises a `needs_you` alert naming the tab and
does not prompt the session. Fixing the drop itself is a Herdr issue and is
proposed separately; 0.1.0 makes it visible within one tick instead of after
50 minutes.

**Alerts in org** (M2, minimal): `org alert <key> <text> [--on ID] [--level
needs_you|info]` and `org clear <key>`, folded into `alerts` in `org today
--json`. Raising an open key again updates its text. These are the only two
new write commands the loop needs.

**Cutover, per project, by the operator**: `touch STOP`; wait until no settle
session is working; kill the remaining `settle-watch` processes by pid (never
by pattern); write `project.json`; load the launchd plist; remove `STOP`. The
loop's first tick records any report the watchers left unsettled. The old
scripts are deleted a day later.

## 8. The protocol: what becomes code and what stays words

`SETTLE.md` today is 11.8 KB governing a 24/7 loop over 176 open items, read
in full by about 80 sessions a day. Roughly 60 % of it tells a session how to
operate tools: which file lists the stage, how to `check` and `sync`, how to
park proposals, how many dispatches, how to arm a watcher, how to record the
agent. That part is the loop's and the core's job. The other 40 % is
judgement: verify before accepting, what is the session's authority and what
is the operator's, how to write a brief. That stays a protocol.

| Today, in SETTLE.md | 0.1.0 |
|---|---|
| §1 "read this much": `org status`, `stage.sh`, OPEN-STATE, `org show G-1` newest-first, roadmap files | the loop's prompt carries the settle brief: `org today --json` filtered to the open stage (`path`, the runs to settle, new decisions), the report(s) in full, `AUTHORITY.md`, `CAUTIONS.md`. ≈ 8–12k tokens. No OPEN-STATE, no whole-org status |
| §2 verify before you accept | **stays**, verbatim, in `SETTLE.md` |
| §3 authority lists | **stays** as `AUTHORITY.md`; the decision format is the 0.0.3 report decision |
| §3 `org add … --role human` + `org set meta.*` | deleted (0.0.3) |
| §4 `org check`, `org sync`, park proposals, legacy reports, usage | code: the loop records; the core parks new proposals by default (`proposals.default_stage` in config); usage is recorded by the loop from the harness when available |
| §5 stage rule, prioritized-first, dispatch caps, "check for an open run" | code: `org start` refuses an item outside the open stage unless `--force --note`; the loop enforces `limits.workers`; the settle brief lists what is dispatchable in priority order |
| §5 dispatch steps 1–5 | `contrib/lib/dispatch.mjs` (0.0.3 piece 2), one command the session runs: `org dispatch <ID> --route <name> --brief <file>`; it does the lane, the start, the agent record. Arming a watcher is gone |
| §6 stop; plain-language summary | **stays**; the summary is also written as `org note R-n --summary` so the panel can show it |
| OPEN-STATE.md state paragraphs | org notes on the items they concern (they already mostly are) |
| OPEN-STATE.md cautions | `CAUTIONS.md`, static, edited by the operator or by an accepted proposal |

The judgement that remains is invoked less often (section 7 rule 4) and with a
smaller cold start (section 11). `SETTLE.md` after this change should be under
4 KB. The operator owns the protocol files; a session may propose a change to
them as a decision and never edits them.

## 9. Core changes

All behind config so that the live loop sees no change until bastian's
`.org/config.json` opts in. `~/.local/bin/org` is a symlink into the main
checkout; **every core change lands warn-only or flag-gated**, with a test that
the default configuration behaves exactly as before.

1. **Actor.** Every session the loop or the dispatch chain opens runs with
   `ORG_ACTOR=<session name>`. The core already honours it. Today 2,012 of
   2,346 events say `human`, so org cannot tell the operator's decisions from
   a session's.
2. **Explicit acceptance** (M2 defect 6): `"acceptance": { "mode": "explicit",
   "auto_roles": ["reviewer"] }`. Under it a worker's `done` report puts the
   item in `awaiting_review`, which does **not** resolve its blockers;
   `org accept <ID> --review R-n [--note]` closes it as done and records the
   review. Reviewer items accept on their own report. `itemStatus` gains the
   state; `path.done` counts accepted items only. Without the config, nothing
   changes. This ends the 51 reopen events and the "reopened after org ingest
   auto-closed it" notes.
3. **Stages** (0.0.3): `"stages": { "open_from": "G-1", "field": "stage_now",
   "item_field": "stage", "standing": ["keys"] }`. `org today` gains `ladder`
   and `path`; `org start` on an item outside the open stage (and not
   standing) prints a warning by default and **refuses** when
   `stages.enforce` is `true`, unless `--force --note`. New proposals get
   `meta.stage = proposals.default_stage` (`"parked"` for bch-cloak) at ingest
   unless they block an open-stage item, in which case they get that stage —
   exactly the rule SETTLE §5 asks sessions to apply by hand.
4. **Decisions** (0.0.3 piece 1, unchanged): report `options`/`causes`/
   `recommend`/`category`/`memo`/`blocks`; `org check` warn-only; `org ingest`
   creates no item for `role: human`; `org decisions`; `org decide`;
   `org answer` kept for the legacy items.
5. **Alerts and direction**: `org alert`, `org clear`, `org direct` (a
   `direction` note on the top goal) — the three M2 writes the loop and the
   panel need. Tagged notes beyond `direction` are not added.
6. **`short` and stage names** in `org today --json` (section 3); `org note
   --summary` is already in the lane.
7. **Sync fix**: skip an abandoned or reported run whose report path a newer
   open run owns (2 shared paths today, each an error on every sync).
8. **`org dispatch`** is *not* a core command. The core never talks to lanes or
   Herdr; `dispatch.mjs` lives in `contrib/` and the session calls it through
   the protocol.

## 10. claude-mem: stays beside the brain

**Decision: claude-mem is not part of this architecture. It stays a parallel
recall system for workers, and 0.1.0 neither integrates nor removes it.**

Reasons, from the installs:

- It is already opt-in per launch, not a platform piece: the plugin is
  disabled in `~/.claude-personal/settings.json` (`claude-mem@thedotmack:
  false`) and loaded per session by `--plugin-dir` through a per-domain
  adapter (`cmem-domain launch-args`). Its scope follows the identity folder
  (`domains.conf`), not the project. That is the right shape for recall and
  the wrong shape for state.
- Nothing the panel, the loop or the protocol needs is in it. Status, stages,
  decisions and what a session serves are org facts. The north star says
  memory must never determine whether an item is active, complete or blocked;
  today it does not, and this spec keeps it that way.
- It costs a cold start (≈ 11k tokens of start-up context per session, pilot
  measurement) and a hook on every tool use, for 80 settle sessions a day that
  need none of it. The settle brief in section 8 does not tell a settle
  session to search memory; `SETTLE.md` §1 lists it as a retrieval option and
  that line goes.
- It is a leak channel. `OPEN-STATE.md` carries a standing caution that a
  private fixture value echoed by a run was "likely forwarded by claude-mem
  (not verified)" and that sessions must never query it for that session. A
  cross-session store that a security project's workers feed by default needs
  its own review, which is not this spec's.
- Whether workers benefit is unmeasured: 3,850 observations from 273 sessions
  (331 MB) in the bastian domain, and no measurement of how often a worker's
  retrieval changed what it did. That measurement is proposed in the report;
  the removal or deepening decision waits for it.

What 0.1.0 does with it: settle sessions launch without the adapter (the
`launch.memory` field is honoured for workers only); the console never reads
it; the report's `learnings` remain the durable cross-session facts.

## 11. Cost model

Units as in the pilot write-up: **input = all context tokens read per call**,
summed. Measured from the Claude transcripts modified on 2026-09-17 (about 96 %
of these are cache reads).

| Layer today | Sessions | Calls | Input read | Output | Per session |
|---|---|---|---|---|---|
| Workers (lane worktrees) | 88 | 13,498 | 2,883M | 19.9M | median 29M |
| Settle / executive sessions | 80 | 4,129 | 425M | 3.2M | median 4.1M, 44 calls, peak context 114k |
| Design and review chats in `rewt` | 6 | 970 | 241M | 2.5M | up to 162M |

Coordination (settle + chats) is 666M of 3.55B, about 19 %. The settle layer
alone reads 4.3× what the 99M chat did, because 80 flat sessions at ~100k
context each is not cheaper than one growing one; it is the same supervisor,
sharded. The pilot's 23M-for-13-runs figure scaled linearly.

**0.1.0 target, per day, same workload (about 40 worker runs):**

| Layer | Sessions | Context per call | Calls | Input read |
|---|---|---|---|---|
| Loop | 0 | — | — | 0 |
| Settle sessions (batched, 10-minute window, small brief) | ≈ 20 | ≈ 35–45k (54k floor minus the 11k memory start-up, plus an 8–12k brief) | ≈ 25 | ≈ 20–25M |
| Continue sessions after a decision or direction | ≈ 3 | same | ≈ 20 | ≈ 3M |
| Operator chats | 0 needed for supervision | | | 0 |
| **Coordination total** | | | | **≈ 25–30M**, from 666M |

Workers are unchanged by this spec; that they read 2.9B a day is a question
for the stage gate and the review cadence, not for the panel. What makes the
target checkable: the loop records `tokens_in`/`tokens_out` on every run and
session it opens (from the harness transcript's `usage`, in `contrib`, not the
core), so `org today --json` can carry `cost_today` and the header can show it
in 0.1.1. Today 1 of 117 runs has usage recorded.

Assumptions that would break the estimate: the settle brief growing back to
"read the whole org"; sessions that do not stop when they should (the 90-minute
guard catches these); more than one settle session at a time (the loop
forbids it by construction).

## 12. What 0.1.0 does not do

- No plan session, no audit session (M2 jobs 3 and 5). `org direct` plus a
  continue session is the whole planning surface. `path` is derived, not
  planned.
- No Beads, no web or phone view, no multi-project loop process.
- No natural-language action interpreter. The launch bar and `org direct` are
  the two typed inputs.
- No stopping, pausing or killing a session from the console.
- No change to how workers are dispatched, briefed or reviewed, and no change
  to bch-cloak's `scripts/lane` fork or to herdr-lanes.
- No claude-mem integration, and no removal of it from workers.
- No migration of the 30 existing `role: human` items; no removal of `org
  answer`.
- No fix for Herdr dropping `CLAUDE_CONFIG_DIR`; it is detected and alerted.
- No priority editing from the console.
- No token or spend enforcement; recording only.

## 13. Build plan: seven pieces, each landing alone

Every piece: a failing test first, `npm test` at the root without console
dependencies, the default configuration unchanged, no visible text with a
record code. Pieces 1–3 are core and contrib and can be built in parallel
with 4–6, which are console. Piece 7 is the operator's.

**1. Core: acceptance, stages, actor, alerts, sync fix** (section 9, items
1–3, 5, 7). Tests: a `done` report under explicit acceptance yields
`awaiting_review` and does not unblock dependents; `org accept` does; reviewer
auto-accepts; `org start` outside the open stage warns, refuses with
`enforce`, passes with `--force --note`; ingest parks proposals and stages the
ones that block open-stage items; `org alert`/`clear` fold; the sync fix with
two runs on one path; the fixture `test/fixtures/state-v0.mjs` folds
identically with no config. Acceptance: against a copy of `bastian/.org`,
`ORG_DIR=<copy> org today --json | jq .ladder.open_stage` is `"1"`,
`.path.total` is 35, `.path.done` is 9, and `.path.held[0].count` is 5 with
`by.id == "REV-54"`.

**2. Core: decisions** — 0.0.3 piece 1 as written, with its tests. Lands
warn-only.

**3. The loop and the launcher** (section 7): `contrib/lib/launch.mjs`,
`contrib/lib/dispatch.mjs` (0.0.3 piece 2, minus "arm the watcher"),
`contrib/loop.mjs`, `contrib/launchd/org-loop.plist.example`, `planTidy`
moved in. Tests: the rule table against fixtures for every rule in section 7
(a finished run is ingested with no session; two finished runs and one
working settle → no session; the same with no settle working → one session
naming both runs; a blocked agent → one `needs_you` alert, not two; a done
worker with a recorded report and a settle opened → tab closed; STOP → no
session and a recorded note; the cap → an alert and a session); the launcher
against fake `herdr`, `ai`, `cmem-domain` binaries: `ORG_ACTOR` set, account
verified, wrong account → alert and no prompt. Acceptance: one full day on
bch-cloak with no `settle-watch` process running, every report recorded within
one tick, and the ledger showing ≤ 30 settle sessions.

**4. Console: the read model and the screen** (section 4): `ladder`, `path`,
`sessions_expected`, session naming, SERVES, the four groups, idle collapse,
`/` stage scope, 80/100/140 frames. Tests: frame tests at the three widths
from a fixture built from the bch-cloak snapshot above (checked in as
`console/test/fixtures/bch-cloak-20260917.json`), naming rules for each
source, SERVES for a lane worker, a settle session, a standing-track run and
an unlinked agent, idle collapse and expansion, selection kept across a
refresh that moves a session from working to done.

**5. Console: waiting sessions, peek, reply, dialog keys, unsent draft**
(section 5; 0.0.3 piece 5 plus the draft case). Tests: as 0.0.3's list, plus:
a blocked session with prompt-box text shows it and offers send/clear; `send`
issues `send-keys enter` after confirmation and nothing before; a reply
records the org note; the UI state file round-trips the peeked set.

**6. Console: verbs and the launch bar** (section 6; 0.0.3 pieces 3 and 4).
Tests: `S` writes and removes STOP with confirmation and the header follows;
open-stage asks for confirmation naming the stage and runs `org set`;
park/revive require a reason; `d` records a direction note; the launch bar
against fake `org`, `lane`, `herdr`, one test per result kind, and the new
item lands in the open stage under the chosen goal.

**7. Protocol and cutover** (sections 2.2, 7, 8), done by the operator or a
continue session with the operator watching, not by the engineer: write
`project.json`; split `SETTLE.md` into `SETTLE.md` + `AUTHORITY.md` +
`CAUTIONS.md` under `.org/protocol/`; retire OPEN-STATE; set `acceptance`,
`stages.enforce`, `proposals.default_stage` and `decisions.check` in
`bastian/.org/config.json`; cut over to the loop; delete the old scripts;
bind `last_pane` and add the popup command in `~/.config/herdr/config.toml`;
turn on `[ui.toast] delivery = "system"`.

## 14. What happens to the earlier decisions

From `spec-waiting-on-you-0.0.3.md`:

| Decision | 0.1.0 |
|---|---|
| Reports are the inbox; a `role: human` proposal is a decision, not an item; ingest stops creating items for them | **survives** (piece 2) |
| Report gains `options`/`causes`/`recommend`/`category`/`memo`/`blocks` | **survives** |
| `org check` is the readiness gate, warn-only behind a flag | **survives** |
| `org ask` retires; the operator's answer is the only write | **survives** |
| Stages filter what is asked | **survives**, and stages now also filter what is dispatched (`org start`) and shape the screen |
| The peek popup, reply via `agent prompt`, session rows for `blocked` and `done` | **survives**, plus the unsent-draft case |
| `last_pane` and `type = "popup"` are config | **survives** |
| The console persists its UI state | **survives** |
| The screen: waiting, not-ready, later stages, then repository groups | **superseded** by section 4: goal and stage organize the screen; repository is a column |
| Five build pieces on one lane | **superseded** by section 13 |
| `contrib/lib/dispatch.mjs` arms the settle watcher as its last step | **dropped**; the loop watches every run with an agent |
| The launch bar first, in the same round | **demoted** to piece 6; the panel comes first because the operator's question is "what is it doing", not "start more" |

From `design-M2-supervisor-homes.md`:

| Proposal | 0.1.0 |
|---|---|
| One loop under launchd replaces per-run watchers | **built** (piece 3) |
| `ORG_ACTOR` for every session | **built**, first |
| Explicit acceptance, `org accept`, sync fix | **built** (piece 1) |
| Alerts, `org direct` | **built**, minimal |
| Session guard, notification policy and probe | **built** |
| Reservations inside the cap | **dropped**; the cap is an alert |
| Plan and audit sessions, `PLAN.md`, `AUDIT.md`, `brain.sh`, `BRAIN.md` | **deferred**; not needed to see the work, and the 2-hour brain-session guard is replaced by the honest measurement that chats cost 241M today |
| `org today` text screen with FOCUS from a plan note | **replaced** by `path`, which is derived |

From `spec-brain-console-0.0.2.md`: look, theme, columns, mouse, popup, history
and the launch-bar section all survive; the repository grouping and the
"WAITING ON YOU pinned first only when a question is open" rule are replaced.

## 15. Acceptance against the live installs

Checkable by the operator, in this order, without reading code:

1. Open the console on bch-cloak. The header says which stage is open and how
   many of its items are done. The first waiting row is a stuck session if one
   exists, with what it is stuck on; today that is the settle session at the
   auto-mode dialog with the browser answer unsent in it.
2. Every session that is working, blocked or done is one row, named in plain
   words, with tool and model, where it runs, how long, and **which goal and
   stage it serves**. The two review sessions running today read
   `the fix · stage 1` and `key safety · standing`.
3. THE FIX shows what is done, what is running, what is next and what holds
   the rest, and matches `stage.sh` for membership. Today: 9 of 35, two
   running, nine held by one review.
4. `Enter` on the stuck session shows its dialog; pressing the key for "Not
   now" dismisses it; the unsent reply is shown and `Enter` sends it; the
   session goes to working within two seconds; `Esc` returns to the same row.
5. `g` on a session goes there; `last_pane` returns. Run as a popup, closing
   it restores the layout with the selection intact.
6. Answering a decision writes one event; the row leaves; the loop opens a
   continue session within a minute; no `continue.sh` was run.
7. `S` shows `STOP` in the header within one tick and no session opens until
   `S` again.
8. With the loop running and no watcher process, a worker that finishes has
   its report recorded within one tick, appears under Finished, and its tab is
   closed once a settle session has it; two finished runs produce one settle
   session.
9. A `done` report under explicit acceptance leaves the item `awaiting
   review` and its dependents blocked; `org accept` releases them; no session
   wrote a "reopened after org ingest auto-closed it" note that day.
10. The ledger shows ≤ 30 settle sessions on a day with ≥ 30 worker runs, and
    `org today --json` `.cost_today` (0.1.1) or the transcript measurement in
    the report shows coordination under 50M input.
11. `npm test` passes at the root and in `console/`; the core has no
    dependency; no visible console text carries a record code; the ten
    questions filed the old way are still answerable.

## 16. Hazards

- **Main is live.** `~/.local/bin/org` is the main checkout. Every core change
  is flag-gated or warn-only, lands with a fold-equivalence test against
  `test/fixtures/state-v0.mjs`, and is promoted only when no settle session is
  working (check `herdr agent list` for a working `settle-*`).
- **Two loops on one org** would dispatch twice. The loop takes
  `.org/loop.lock` (pid) and refuses to start if a live pid holds it; the
  cutover in section 7 stops the watchers first.
- **The lane is behind main.** `lane-brain-console-v1` is 31 commits ahead and
  8 behind; main has org-map, tidy-tabs, the settle-watch buffer fix and the
  0.0.3 spec that the lane lacks. Rebase before piece 4.
- **Reports live in `archive/`** with 2,227 other files and report paths are
  chosen by sessions; two runs already share one. The loop's sync fix skips
  the collision; the dispatch chain chooses the path (`report_dir/<ID>-
  <topic>-<date>.md`) so a session cannot reuse one.
- **Never kill by pattern.** The cutover kills the two remaining `settle-watch`
  processes by pid.
