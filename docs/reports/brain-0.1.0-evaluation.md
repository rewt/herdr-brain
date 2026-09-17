---
run: R-7
outcome: done
summary: |
  Read the org core, the console lane, Herdr, herdr-lanes, claude-mem and both live
  organizations; measured the bastian org, the Herdr session and today's Claude
  transcripts; wrote docs/spec-brain-0.1.0.md as the build-ready spec. The central
  finding: the operator cannot see the theft-hole work because its plan is prose a
  session rewrites every pass, the panel groups sessions by repository instead of by
  goal, and the operator's own answer today went into a stuck session's prompt box
  instead of into org. Coordination now costs more than the chat it replaced: 80
  settle sessions read 425M tokens today. The spec makes a project one file, one
  loop, one read model and one panel, turns the mechanical 60 percent of SETTLE.md
  into code, keeps claude-mem beside the brain rather than inside it, and lands in
  seven flag-gated pieces so the live loop is never broken.
headline: The days-long fix is invisible because nothing shows its plan or which session serves it, and the coordination layer now costs four times the chat it replaced; the spec fixes both.
blockers: []
proposals:
  - role: human
    title: Approve the Herdr Brain 0.1.0 spec and its seven-piece build order
    why: Nothing in the spec is built until the operator says so. The first two pieces change the org core that the live 24/7 loop runs, flag-gated, and the last piece is the operator's own cutover of bch-cloak.
  - role: engineer
    title: Build core acceptance, stages, actor, alerts and the sync fix behind config flags
    why: Spec section 9 and piece 1. Ends the worker-done-equals-accepted defect that caused 51 reopens in 28 hours, and gives every screen the ladder and the derived path of the open stage.
  - role: engineer
    title: Build the report decision format, org decisions and org decide, warn-only
    why: Spec piece 2, unchanged from the waiting-on-you 0.0.3 spec. Six reports already contain real decisions the operator cannot see.
  - role: architect
    title: Re-scope the existing 24/7 loop item and the launch-bar item to the 0.1.0 spec
    why: Both items exist in this organization with acceptance written before today's measurements. The loop must batch settles and record reports without a session; the launch bar moves to the last console piece.
  - role: engineer
    title: Build the console read model and the goal-and-stage screen at 80, 100 and 140 columns
    why: Spec piece 4. The operator's question is what each session serves and where the open stage stands; today's screen answers neither.
  - role: engineer
    title: Build waiting session rows, the peek, replies, dialog keys and the unsent-draft case
    why: Spec piece 5. A settle session is stuck at a dialog right now with the operator's answer typed and unsent in it, and the panel shows nothing.
  - role: researcher
    title: Measure whether workers' claude-mem retrievals change what they do
    why: 3,850 observations from 273 sessions in the bastian domain and no measurement of use. The decision to deepen or drop it for workers waits on this; the spec keeps it beside the brain either way.
  - role: engineer
    title: Reproduce and report Herdr dropping the Claude config directory for started agents
    why: The stuck settle session carries AI_PERSONA=personal and no CLAUDE_CONFIG_DIR, so it runs on the wrong account and hits first-run dialogs. The loop will detect this within a tick; only Herdr can stop it happening.
learnings:
  - Today's Claude transcripts for bch-cloak show 80 settle sessions reading 425M input tokens (median 4.1M and 44 calls each, peak context 114k) against 88 worker sessions reading 2,883M; flat sessions at 100k context are the old supervisor sharded, not removed.
  - 2,012 of 2,346 bastian org events are attributed to human because ORG_ACTOR is never set by the watchers on main; the lane has the fix and a test for it.
  - The 49 open items with no stage all carry a worker done report and were never closed or accepted; they are not dispatchable, so the gap is acceptance, not the stage gate.
  - A settle session on the wrong account shows the Teach-auto-mode first-run dialog and blocks; Herdr reports it as blocked within seconds, but nothing reads that state into the panel.
  - The two done sessions nobody read were settled by a combined settle session; a watcher that finds its run settled elsewhere exits without closing the worker tab.
  - The daily session cap went 12 to 30 to 100 within a day; arm-watch.sh passes 100 today.
  - The lane brain-console-v1 is 31 commits ahead of main and 8 behind; main has org-map, tidy-tabs, the settle-watch buffer fix and the 0.0.3 spec that the lane lacks.
  - org today text and JSON both work against bastian in under two seconds with 2,346 events; performance is not the constraint.
artifacts:
  - /Users/rewt/development/rewt/herdr-org/docs/spec-brain-0.1.0.md
  - /Users/rewt/development/rewt/herdr-org/docs/reports/brain-0.1.0-evaluation.md
  - "measurement: node over ~/.claude*/projects/-Users-rewt-development-bastian-bch-cloak and -Users-rewt--herdr-worktrees-bch-cloak-* summing message.usage per transcript modified 2026-09-17"
  - "measurement: ORG_DIR=/Users/rewt/development/bastian/.org org status --json folded by stage, status, role, depth and day"
  - "measurement: herdr agent list, herdr tab list, herdr agent read settle-r-115-1628 --source visible, herdr pane process-info --pane wFN:p74"
---

# Evaluation: why the operator cannot see the work, and what 0.1.0 does about it

Everything below was measured on 2026-09-17 between 16:35 and 16:50 CDT against the
live installs. Numbers are exact where they say so and rounded where they say
"about". The spec this report produced is `docs/spec-brain-0.1.0.md`; this report
argues, the spec instructs.

## 1. Why the operator cannot tell what the days-long work is doing

The work is stage 1, "close the theft hole": the finding of 09-16 morning that a
batch can spend another party's seal cells, and the fix (owner co-signatures,
seal v2). Here is what a careful reader can reconstruct from the record, and what
the operator's screen showed of it at 16:41.

**What the record says.** Stage 1 has 35 items, created from 09-16 14:09 CDT
onward. Nine are closed. Of the 26 open: 2 active (the aggregator-verification
run being settled, and the review of the freeze-document revision), 13 blocked,
9 ready and untouched, 2 waiting on the operator. Nine of the thirteen blocked
items trace to one thing: the review of commit 4c4ff90d that started at 16:33.
One more (the circuit-size measurement) waits on the operator quitting two
browsers. The chain to finish the stage is written, in prose, in
`OPEN-STATE.md`: aggregator verification and the freeze document in parallel,
one review of each, then the assembler, then the circuit measurement alone, then
the replays, then the seed, then the profile switch, then one review of the
whole fix. Two of those eight steps are accepted. That is a days-long path and
the record is honest about it.

**What the operator's screen showed.** The console at 140×40 on bch-cloak:
thirteen "waiting on you" rows, ten of them stage-4 questions with no category
and no recommendation; then thirteen sessions grouped under the repository, two
of them `no description`, none saying which goal or stage it served; a blocked
settle session shown as `no description`. Nothing on the screen says "stage 1",
"9 of 35", "held by one review", or "your reply is unsent".

**The concrete causes, each verified:**

1. **The plan is not a record.** The critical path exists only as paragraphs in
   `OPEN-STATE.md` (20.9 KB, rewritten by every settle session, header says so)
   and in 50 notes on G-1. Org has blocking links and priorities from which the
   same path can be derived deterministically (`contrib/org-map.mjs`, written
   today, is the first thing that does), but no view renders it.
2. **Sessions are not joined to goals anywhere the operator looks.** Herdr knows
   `lane-freeze-policy-cod-213357` in tab `agent:freeze-policy-codec` with the
   title "R-117 freeze-document review". Org knows R-117 → REV-54 → parent
   ARCH-51 → ancestors … → G-1, and REV-54's `meta.stage = 1`. The join key
   (`run.meta.agent`) exists; no screen walks it to a stage.
3. **The operator's answer went to the wrong place.** `settle-r-115-1628` is
   `blocked` (Herdr, tab `wFN:t74`). Its screen shows Claude's "Teach auto mode
   about your environment?" first-run dialog, and in the prompt box beneath it,
   unsent: `ok browsers are quit, go ahead`. That is the answer to the one
   stage-1 question that unblocks eight items (HUM-28), typed into a session
   instead of recorded in org, stuck behind a dialog. The session's process
   carries `AI_PERSONA=personal` and **no `CLAUDE_CONFIG_DIR`**, so it runs on
   `~/.claude`, the account that has not dismissed that dialog. This is the
   pilot's incident 1 and incident 2 happening together, 27 hours later, and
   the console shows it as `■ blocked no description`.
4. **Two finished sessions nobody read** (`V1 fixture replay`, done 11:48; the
   REV-49 review) sit as `done` five hours later. Their runs were settled by a
   combined session (`settle-r-103-104-105-1424`); `settle-watch.mjs` on
   finding its run "settled elsewhere" calls `finish()` without
   `closeWorkerTab()`. Four `watch R-n` tabs for runs reported hours ago are
   still open for the same reason.
5. **Activity is shown instead of progress.** 276 items created and 100 closed
   in 28 hours; 81 runs and 56 settle sessions today; 832 notes, 273 of them
   "decisions today" with no plain summary. The operator sees a screen that
   changes every few minutes and cannot tell whether the fix moved.
6. **Nothing says what anything costs.** One of 117 runs has tokens recorded.

The honest answer to "what is it doing" is: *two steps of eight are accepted, two
are being reviewed, nine items are held by one of those reviews, and one
measurement is held by you.* Every part of that sentence is derivable from org
today at zero inference. Spec section 3 (`path`) and section 4 (THE FIX) make it
the second group on the screen.

## 2. The seams, and which are load-bearing

| Seam | Load-bearing? | Evidence | Verdict |
|---|---|---|---|
| org ↔ Herdr via `run.meta.agent` | **yes** | the only join between a run and a live session; `settle-watch`, `org-map` and the console all use it | keep; make it the basis of SERVES |
| org ↔ lanes via `run.meta.lane` and `workspace` | yes | the only way to find the worktree a run writes | keep |
| SETTLE.md ↔ org CLI | yes, and too heavy | 80 sessions/day re-read 11.8 KB of tool instructions; 7 notes today of sessions fighting `org ingest`'s auto-close | split: 60 % becomes code (spec §8) |
| watchers ↔ sessions (`arm-watch.sh`, per-run process, ledger, take-turns lock) | accidental | born from "one watcher per run"; explains the dead watch tabs, the unclosed done sessions, the cap raised three times | replace with one loop (spec §7) |
| console.json ↔ project (`org`, `cwd`, `ledger_dir`, `claude_config_dirs`, `session_cap`) | accidental | duplicates paths that `arm-watch.sh`, `.lane.json` and `domains.conf` also hold; `session_cap` 100 here, 30 in the M2 doc | replace with `.org/project.json` and discovery |
| lanes session registry (`.lane/sessions.json.d`, `lane board`) ↔ panel | accidental | `lane board --json` in herdr-org lists a live session as `offline` with goal "Brief: run R-4 on ENG-1" | the panel never reads it |
| console ↔ Claude transcripts (session notes, model name) | half | the model name has no other source; session notes were dropped in 0.0.2 | keep the model lookup, bounded; nothing else |
| claude-mem ↔ everything | parallel | opt-in per launch via `--plugin-dir` adapter; scoped by identity folder; ~11k cold-start context per session; suspected in the HUM-17 leak | stays beside the brain (spec §10) |
| identity folder ↔ project | accidental as a project notion | `~/bin/ai` maps the folder to an account; `domains.conf` maps it to a memory domain; `.lane.json` there sets routes; `.org` there serves one repository | keep it as the account boundary only |

What is deleted or merged is listed in spec §2.4.

## 3. The right model of a project

Today one project is six or seven things (spec §1 item 4; the identity folder,
`bastian/.org`, `~/.herdr/worktrees/bch-cloak/lane-*` for bch-cloak but
`rewt/.worktrees/herdr-org/lane-*` for herdr-org, a Herdr workspace per
checkout and per worktree, a `console.json` entry, `bch-cloak/.lane/supervisor`
with bastian's paths hard-coded in three scripts, plus the dead
`.lane-supervisor/<version>` folders at the identity level).

**A project is a repository checkout that has an `.org`.** One file,
`.org/project.json`, names the checkout, the lane tool and worktree root, the
protocol directory, the launcher, the routes and the limits. The console
discovers projects by scanning configured roots for it; the loop is started
with it; the core ignores it. The identity folder keeps exactly its current
job, the account boundary, and nothing new. The protocol folder moves into the
`.org`. The two worktree roots stay two in 0.1.0, named rather than guessed.

I did not merge the identity folder into the project because the account
boundary is real (two Claude logins, two GitHub configs) and the launcher
already resolves it from the path correctly; the defect is that Herdr drops
what the launcher resolved, which is Herdr's to fix and the loop's to detect.

## 4. The instrument panel

Spec §4 has the mocks at 140×40 and 80×24, drawn from the live data at 16:41.
The changes from 0.0.2a that matter:

- The header carries the open stage, its name and `done/total`.
- Waiting on you gains session rows for `blocked` and `done` agents, above
  decisions, with what the session is stuck on and whether its prompt box holds
  unsent text.
- THE FIX (the open stage's `path`): done, now, next, held. Derived.
- Sessions get a SERVES column (`the fix · stage 1`, `key safety · standing`)
  and plain names (`review of the freeze document`, `settling: aggregator
  run`). Idle sessions collapse: 26 of 33 agents were idle at measurement time
  and buried the four that mattered.
- Later is one line per closed stage.

Everything the operator asked for is a column: what it is (SESSION), harness and
model (WHO), where (WHERE), how long (UP), what it is doing (DOING), which goal
and stage (SERVES).

## 5. The round trip

Spec §5. Peek (`Enter`) stays in the console; `g` goes and `last_pane` returns;
run as a `type = "popup"` command the console overlays any pane. The two cases
the live install showed are specified concretely: a blocked session's dialog is
answered from the peek with `send-keys`, and if the prompt box holds text the
peek shows it and offers to send it; a done-unread session leaves the waiting
group once peeked, and the loop closes its tab once its report is recorded and
a settle session has it.

## 6. Redirecting work

Spec §6: nine direct verbs, each writing one thing. `S` toggles the existing
STOP file. Open a stage, park and revive an item, answer a decision, reply to a
session, answer its dialog, give one or two sentences of direction (`org
direct`, read by one continue session), start a task (the launch bar). No
interpreter. Priority editing, pausing and killing sessions are out.

## 7. SETTLE.md: protocol or code

Split it. Measured: the file is 11.8 KB; about 60 % by line count tells a
session how to operate `org`, `stage.sh`, the lane tool and the watcher; today
that instruction set was executed about 56 times by sessions costing a median
4.1M input tokens each. Seven decision notes today say a session reopened an
item because `org ingest` closed it, exactly as the protocol told it to; 51
reopen events in the log. A rule that 80 sessions a day must remember is
cheaper, and more reliable, as a line in `itemStatus` and a flag in `org
start`. The 40 % that is judgement (verify before accepting, the authority
lists, how to write a brief, the plain-language summary) stays as words, is
read by fewer sessions with a smaller brief, and the operator keeps owning it.
Spec §8 has the line-by-line disposition.

## 8. The cost model

From today's transcripts (all context read per call, about 96 % cache reads):
workers 88 sessions / 2,883M; settle 80 sessions / 425M (median 4.1M, 44 calls,
peak context 114k); design and review chats in the rewt workspace 6 sessions /
241M. Coordination is 666M of 3.55B, 19 %. The settle layer alone reads 4.3×
what the 99M chat did. The pilot's thesis held for the first 13 runs and then
scaled linearly, because a flat 100k session repeated 80 times is the same
supervisor sharded.

Target (spec §11): the loop at zero; about 20 batched settle sessions on a
35–45k cold start and ~25 calls, plus ~3 continue sessions, for about 25–30M a
day of coordination; the operator's supervision chats at zero because the panel
answers their questions. The loop records usage on every run and session so the
number is checkable, not asserted.

## 9. What 0.1.0 does not do

Spec §12. No plan or audit sessions, no Beads, no web or phone, no interpreter,
no session control beyond reply and dialog keys, no lanes or worker changes, no
claude-mem integration or removal, no migration of the 30 legacy questions, no
fix for the Herdr account drop (detection only), no priority editing, no spend
enforcement.

## Decisions overturned or changed, and what changed them

- **The daily cap is no longer a brake.** It was raised 12 → 30 → 100 within a
  day and stopped useful work once; STOP and a worker limit are the brakes, the
  count is an alert.
- **The screen is organized by goal and stage, not repository.** The
  repository grouping (0.0.2, kept in 0.0.3) put a stuck settle session ninth
  in a group of thirteen under `bch-cloak`.
- **The launch bar moves last.** 0.0.3 folded it in as pieces 2 and 4; the
  operator's stated problem is not being able to see, so the panel and the
  waiting sessions come first.
- **The dispatch chain no longer arms a watcher**; the loop watches every run
  with an agent.
- **Plan and audit sessions are deferred**, not because they are wrong but
  because the path can be derived and the chats they were meant to replace are
  measured at 241M today; the honest first step is to make them unnecessary.
- **Reservations inside the cap** go with the cap.

## Verification of the measurements handed to me

All confirmed against the live org at 16:39, with these corrections: the human
items are now 30 (13 open), 23 born from reports, not 28/22; the 49 no-stage
open items all carry a worker `done` report and are not dispatchable, so
"invisible to the gate rule" is true but harmless, and the real defect is that
nobody accepted them; the ten questions on the screen are thirteen now, eleven
of them without a category. Everything else matched: open stage 1, 65 budget
warnings, 232 created against 123 resolved in the first 30 hours (the operator's
own reset note says so), 6 `needs_human` reports, three sessions nobody read
(now one blocked and two done), the symlink, SETTLE.md line 129.

## Dead ends

- I looked for a way to make Herdr carry the account into `agent start`; the
  watcher already passes `CLAUDE_CONFIG_DIR` in the caller's environment and
  the started process still lacks it. That is inside Herdr 0.8.2; proposed as
  a repro, not designed around.
- I considered making the loop open no settle sessions at all by templating
  review briefs from a done report's artifacts. The SHA and scope are usually
  there, but the judgement about what the review should attack (see the R-115
  settle summary) is real work; it stays a session, batched.
