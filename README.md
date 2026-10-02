# Herdr Monitor

Durable organizational state for agent-driven R&D, so that no LLM session has to stay alive to
remember what the organization is doing.

It records goals and work items, runs (attempts) against them, and the reports those runs produce.
Status, briefs and snapshots are derived from that record deterministically: they cost zero
inference tokens, and a completely fresh session of any harness can continue from them.

- Durability replaces conversational context; it does not add bureaucracy around it.
- Reasoning costs tokens. Coordination mostly should not.

Node ≥ 20, no core dependencies (the optional `console/` and `mcp/` have their own). `npm link` installs
`record` and its permanent `org` alias. Without npm, symlink `bin/org.mjs` onto your PATH as
`record`; do not copy it away from its sibling `lib/` directory.

The public module name is **record**. Existing automation keeps working unchanged: `org` runs
the same implementation and prints the same output, while `.org/`, `ORG_DIR`, `ORG_ACTOR`, the
`org` project-config key, and existing absolute paths to `bin/org.mjs` keep their names and
meaning. A fresh `record init` also creates `.org/`; using one directory avoids two records that
look like one project.

## Where things live

| Piece | What lives there |
|---|---|
| `bin/org.mjs` | The shared CLI implementation; installation exposes it as both `record` and the permanent `org` compatibility name. |
| `lib/` | The dependency-free core: event storage, state folding, reports and views. |
| `brain/` | Captures stopped session screens for the operator queue and provides commands that start or answer sessions. |
| `console/` | The operator's terminal screen for sessions, questions and the Brain queue. |
| `mcp/` | [Foreground stdio MCP adapter](mcp/README.md) over the record CLI for agents without a shell wrapper. |
| `promote/` | [Ordered promotion queue](promote/README.md), detached drain, scoped cleanup and supervisor outcomes. |
| `lanes/` | Worktree open, dispatch, review, promotion and close; to become Brain's dispatch layer. |
| `watch/` | Waits without inference, validates a run report and delivers it to the supervisor. |
| `supervisor/` | The settle prompt, explicit settle/continue session launchers, watcher wrapper and tab housekeeping. |
| `contrib/settle-watch.mjs` | Temporary compatibility entrypoint kept unchanged for bch-cloak's canonical-checkout caller; remove only after its release-gated switch. |
| `.lane/` | Ignored runtime state, including session ledgers and the emergency `STOP` file. |
| `~/.config/herdr-org/console.json` | The operator's local console project and Brain-path configuration. |
| `~/Library/LaunchAgents/com.rewt.herdr-brain.plist` | The operator's local service definition for the always-on Brain watcher. |

## The loop (you are the scheduler)

```sh
record init                                     # creates ./.org
record add --goal "Rate limiting shipped"       # → G-1
record add "Persist rate-limit state" --parent G-1 --role engineer --capability deep \
    --accept "survives restart"              # → ENG-1
record start ENG-1 --route engineer
# R-1 started on ENG-1 "Persist rate-limit state" [codex · configured-model · configured-effort]
#   brief   /…/.org/runs/R-1/brief.md  (1830 chars ≈ 458 tokens)
#   report  /…/.org/runs/R-1/report.md
#   prompt  Read /…/.org/runs/R-1/brief.md and follow it.
```

Launch any harness (in a Herdr pane or anywhere) and give it that prompt. The worker writes one
report when it stops: done, blocked, needs a human, or failed. No progress updates. Then:

`--route` reads the project route table used by `lane dispatch`; it records the
declared harness, model, and effort plus the route name. The record never infers
effort from harness arguments: declare `effort` in the route or `dispatch` defaults.
`--harness`, `--model`, and
`--effort` remain available for unrouted or legacy callers, but cannot be mixed with
`--route`. Use `--route-config FILE` only when selecting an explicit standalone route
file; otherwise discovery follows the canonical checkout's parent and repository
`.lane.json` files, including from linked worktrees. Outside Git, it reads the
nearest `.lane.json` at or above the working directory.

```sh
record sync      # record reports waiting at open runs' report paths
record status    # one screen, no inference
```

Kill every session whenever you like. `record status` rebuilds the picture from `.org/` alone, and
`record snapshot` prints markdown meant to be handed to a fresh Claude, Codex, Gemini or other
session ("Read the output of `record snapshot`, then …").

## Reports

The brief ends with this template:

```markdown
---
run: R-1
outcome:            # done | blocked | needs_human | failed
summary: |
  (what you did and where things stand, in a few sentences)
headline:           # one plain sentence for the operator, e.g. "The storage tool review needs work"
blockers: []        # if blocked or needs_human: what exactly is in the way
proposals: []       # follow-on or unblocking work; each entry becomes a new item, e.g.
#  - role: architect
#    title: Decide the storage backend
#    why: what this unblocks or why it matters
learnings: []       # facts a future session should not have to rediscover
artifacts: []       # commits, branches, files, commands that show the work
---

(free-form details: evidence, dead ends, anything worth keeping)
```

- Only `outcome` and `summary` are required. Unknown fields are kept.
- `headline` is the one plain sentence the operator reads in the console: no item codes or
  hashes. It is optional; `record check` and `record ingest` warn when it is missing and never refuse.
- **Workers decompose their own blockers.** Each proposal becomes a child item of the reporting
  item. When the outcome is `blocked`, proposals also block it (override per proposal with
  `blocking: true|false`), so it becomes ready again when they are done. No triage session needed.
- `learnings`, summaries and decisions flow into later briefs and the snapshot.
- `record check <file>` validates a report without recording it.

## Questions for the operator

Agents never hand the operator an open question or a list of options. They research, recommend,
and ask one plain yes/no question:

```sh
record ask "Adopt the theft fix once its review passes?" --parent G-1 --category design \
    --recommend yes --why "O1 is the only option where the network refuses the theft. The review passed." \
    --on-yes "Implementation and its review start." --on-no "The fix path stops." \
    --memo archive/DECISION-THEFT-FIX-20260916.md --blocks ENG-7 --blocks REV-3 [--priority 80]
# → HUM-5
```

- The question is an ordinary `role=human` item, so the work it `--blocks` waits and unrelated work
  keeps moving. `meta` holds `category`, `recommend`, `memo`, `on_yes` and `on_no`; a note holds
  `--why`. Everything is recorded in one transaction.
- `--parent`, `--category`, `--recommend` and `--why` are required. `--memo` must be an existing
  regular file (it is stored as an absolute path; directories and app bundles are refused). Unknown categories are refused with the list of known ones.

```sh
record answer HUM-5 yes|no|"<short text>" [--note "why"] [--overrule]
```

- Records a decision note, sets `meta.answer` and `meta.answered_by` (the actor: `human` unless
  `ORG_ACTOR` is set), and closes the question as done.
- **`no` does not release the work.** A question closed with `meta.answer=no` counts as unresolved
  for the items it blocks: they stay `blocked` (status shows `declined: <question>`) until someone
  re-plans them and runs `record unblock <ID> --by HUM-5`. `yes` and text answers release them.
  A `no` does not stop a dependent that is already running, nor reopen one that is already
  closed; `record answer` and the console Summary say so for each of them.
- A reply whose first word is `yes` or `no` is that answer: `"No."` and `"no, not yet"` decline,
  and whatever follows the word is kept in front of the `--note`. Other replies are text answers.
  `record ask --recommend` takes the same word alone (`"Yes."` is fine; `"yes, after review"` is
  refused: the rest belongs in `--why`).
- A second answer is refused. `--overrule` re-answers an answered question (typically one answered
  automatically) and records `meta.overruled=true`; it is refused when the answer would not change.
- `record show` and run briefs list a declined blocker as `declined (answered no)`, not `done`.

### Categories and approval policy

`.org/config.json` can hold:

```json
"approvals": {
  "default": "ask",
  "categories": {
    "design": "ask", "security": "ask", "funds-and-chain": "ask", "prover": "ask",
    "publish": "ask", "licensing": "ask", "delete-data": "ask", "priorities": "ask",
    "goals": "ask", "tooling": "ask", "other": "ask"
  }
}
```

Missing entries fall back to these defaults, and configured categories are added to them. A
category set to `auto` is answered with its recommendation as soon as it is asked
(`meta.answered_by=auto`, the asking session as actor); it shows in the console's history (`h`), where
the operator can still overrule it. Everything ships as `ask`. Relax a category only when its
`answered_as_recommended` count in `record today --json` shows the agents decide it well.

Choose the category by the action, using the ordered checklist in `record ask --help`
and every generated report template. Handling keys or trust pins is security even
when the work is called a tooling change; pushing a design is publish. If unsure,
pause the dependent action and use `record ask ... --wait --blocks ID` with a
recommendation and the reason for uncertainty. Include that question's id in the report.

At `ask` and report ingest, a dependency-free lexical check flags auto-routed text
mentioning keys/credentials, pins, push, publish/deploy/release, broadcast,
vulnerabilities or deletion/removal. It scans question prose (including the memo's
contents) and categorized `decisions`/`questions` in report front matter, including
their rationale and consequences. It never scans the free-form report body or
infers a category for uncategorized entries. A question explicitly using `--wait`
already waits and needs no auto-routing flag. `record check` previews report flags.

Flags are advisory `category.flagged` events: ingestion and automatic answers
still succeed. `record status`/`today` show them in attention, the classic console
shows Category review, and the modern console shows them on the project overview
and Needs you page. They remain visible after completion as review evidence;
there is no dismissal command yet. Matches are deliberately conservative (even
negated mentions can flag), not proof of a wrong category or permission to act.
Report decisions/questions retain the existing lenient envelope behavior; use
`record ask` to create an operator question and its blocking links.

| Category | Covers |
|---|---|
| design | Local implementation, architecture, design or spec after the higher-risk action checks |
| security | Keys, credentials, trust pins, cryptography, security boundaries, vulnerabilities, exposure or disclosure |
| funds-and-chain | Funding, signing, broadcasting, any chain contact beyond read-only |
| prover | Running a prover or Setup |
| publish | Publishing, pushing, releasing, making anything public |
| licensing | Licenses and repository visibility |
| delete-data | Deleting or overwriting keys, secrets, proof artifacts, evidence |
| priorities | Changing operator-set priorities |
| goals | Creating or changing a goal |
| tooling | Installing or upgrading tools the project depends on |
| other | Anything else that needs the operator (use sparingly) |

### Plain summaries

Agents record their own decisions with one plain sentence for the operator:

```sh
record note ENG-7 --decision --summary "Leave the exposed test cells alone until the fix lands" \
    "Per archive/DECISION-CELLS-20260916.md: …"
```

The console shows the summary. A decision without one is shown as its first sentence with codes
removed, marked `· no plain summary`.

Sessions opened by `supervisor/open-session.mjs` get `ORG_ACTOR=<session name>`, so the record tells
their answers and notes apart from the operator's.

## `record today`: the operator's read model

`record today` prints what waits on the operator, what was decided, what runs and what finished
today, one line each, codes only in parentheses at the end. `record today --json` is the console's
only view of the organization. It is deterministic for a fixed record, config, `ORG_NOW` and `TZ`
("today" is the local day of `TZ`).

```jsonc
{
  "project": { "org": "/…/.org", "as_of": "ISO time", "events": 667,
               "item_prefixes": ["ENG", "G", "HUM"],   // item-id prefixes in use; the console strips only these codes
               "day": { "date": "2026-09-16", "start": "ISO", "end": "ISO", "tz": "America/Chicago" } },
  "waiting": [{                       // open role=human items, ranked (see below)
    "id": "HUM-5", "title": "…?", "status": "ready|blocked|…",
    "category": "design|null", "recommend": "yes|null", "why": "…|null",
    "on_yes": "…|null", "on_no": "…|null", "memo": "/abs/path|null", "priority": 80,
    "created": { "at": "ISO", "by": "actor" },
    "blocks": [{ "id": "ENG-7", "title": "…" }],
    "unblocks_prioritized": 3         // unresolved items with a priority that wait on it, transitively
  }],
  "decided": [                        // newest first
    { "kind": "question", "id", "seq", "title", "category", "recommend", "answer",
      "answered_by": "human|auto|<session>", "overruled": false, "note", "why", "memo",
      "blocks": [{ "id", "title", "status", "open_runs": ["R-9"] }], "at", "by" },
    { "kind": "note", "id", "seq", "title", "summary": "…|null", "text", "at", "by" }
  ],
  "running": [{ "run", "item", "title", "role", "started", "agent", "lane",
                "harness", "model", "effort", "workspace", "round",   // round: 1 for an item's first run
                "brief_path", "report_path" }],
  "agent_runs": [ … ],               // same fields: the latest finished run of each agent name, newest first (at most 50)
  "finished": [                       // newest first
    { "kind": "report", "run", "item", "seq", "title", "role", "outcome", "headline", "summary",
      "report_file": "/abs/.org/reports/R-n.md", "late", "at" },
    { "kind": "closed", "item", "seq", "title", "role", "as": "done|dropped", "note", "at", "by" }
  ],
  "approvals": {
    "policy": { "default": "ask", "categories": { "design": "ask", … } },
    "counts": { "design": { "answered": 4, "answered_as_recommended": 3, "overruled": 0, "auto": 0 } }
  },
  "attention": [{ "id", "kind": "budget|parallel|stale", "text" }]
}
```

- *Waiting* is ranked by `unblocks_prioritized`, then priority, then age.
- *Decided* holds questions answered today and today's decision notes (answer notes excluded).
- *Finished* holds reports recorded today and items closed today (answered questions excluded).
- Live Herdr state and session notes are not part of `record today`: the core never talks to Herdr.

## `record recap`: one work block, top down

`record recap [--back N] [--json]` derives the latest work block from the log (`--back 1` is
the one before). A block is a stretch of activity with no gap over two hours; one longer
than eight hours is cut at 06:00, 12:00, 18:00 and 22:00 local, and a piece under an hour
and a half joins its neighbour, so an overnight run reads as one block. For the block it
gives: the items its threads grew from; the open questions (the same list as `record today`);
each thread (an item worked or created in the block whose parent was not) with its runs,
the items it spawned and which are still open, its questions and decisions; every
question asked or answered and every decision note; the sessions (the actors that started
runs, and each worker agent with its runs); what is pending; and the older open work
folded by goal and parent, with how much of it is untouched for two days. Deterministic
for a fixed record, `ORG_NOW` and `TZ`.

A write with neither `ORG_ACTOR` nor a terminal is still recorded as `human`, carries
`"unattributed": true`, and the CLI prints how to name the session. Nothing is refused
for it. Agent sessions set `ORG_ACTOR` to their session name (`supervisor/open-session.mjs` and `brain start`
do); the console writes as `ORG_ACTOR=human`.

## The console

`record console --modern` opens Herdr Monitor's project screen. It costs no model tokens and
shows current sessions, item-linked work, questions that need the operator, and recent item
activity. The operator can open or type into a session, answer a recorded question, add a task,
or start a chat. All record writes go through the `record` CLI. The Herdr plugin opens this
screen directly beside the supervisor chat.

### Install and run

```sh
npm --prefix console ci          # Ink and React, pinned by console/package-lock.json
record console --modern [--project NAME]
node console/app.mjs --modern --print 140x40 [--keys 'a']   # one frame as text, no terminal needed
```

The core stays dependency-free: optional `console/` and `mcp/` have their own dependencies, and root `npm test` passes
without them. `npm --prefix console test` runs the console tests alone.

### Legacy compatibility console

Plain `record console [--project NAME]` still opens the older console for compatibility. The
Font, Configuration, Screen, and Keys sections below describe that legacy screen; the modern
project screen above is the operator-facing console used by the Herdr plugin.

#### Font

The terminal owns the font, so set Herdr's font to a **Nerd Font**: Maple Mono NF for a rounded
look, or JetBrains Mono Nerd Font. The header and footer are powerline segments and the group
headers have rounded caps; without a Nerd Font those glyphs show as boxes. If you cannot change
the font, set `"glyphs": "plain"` in `console.json`: every powerline and icon glyph becomes ASCII
(`>`, `<`, `|`) and the state dots go (each state is a word anyway). `NO_COLOR` implies `plain`
and turns colour off; the `>` selection mark and every state word stay.

The screen is painted black (`#000000`) on every row. Colours are true colour; Ink falls back to
the nearest 256 colour on a terminal without it.

#### Configuration

`~/.config/herdr-org/console.json` (or `$HERDR_ORG_CONSOLE_CONFIG`). On first run the console
writes an example there and exits; edit it and delete its `"example"` line.

```json
{
  "projects": [
    {
      "name": "bch-cloak",
      "org": "/Users/rewt/development/bastian/.org",
      "cwd": "/Users/rewt/development/bastian/bch-cloak",
      "ledger_dir": "/Users/rewt/development/bastian/bch-cloak/.lane/supervisor",
      "claude_config_dirs": ["/Users/rewt/.claude", "/Users/rewt/.claude-personal"],
      "session_cap": 30
    }
  ],
  "refresh_seconds": 5,
  "brain_bin": "/Users/rewt/development/rewt/herdr-brain/brain/bin/brain.mjs",
  "glyphs": "nerd"
}
```

- `org`: the retained project-config key for the record directory; read with `record today --json`, again whenever `events.jsonl` changes and every
  `refresh_seconds`. If a read fails, the last good data stays and the header shows its age.
- `ledger_dir`: `sessions-YYYY-MM-DD.log` (the count against `session_cap`) and the `STOP` file.
- `claude_config_dirs` (of every project): where Claude session transcripts are found, by the
  session id Herdr reports (in the folder named after the session's `cwd`, else in any project
  folder), or by `agent-name` when Herdr gives no id. A transcript is read once and then only
  its new lines.
- `brain_bin`: the folded-in Brain CLI; its queue and service controls join the console. When the
  console was started with `--config FILE`, it passes that exact file to `brain queue`, so both
  processes use the same project names and checkout roots.
- `glyphs`: `nerd` (default) or `plain`.
- Herdr: `herdr agent list` and `herdr tab list` on the same cadence.

#### Screen

From the top:

1. **Header** segments: project, clock, sessions today against the cap, questions waiting (orange
   when any), alerts, `STOP`, Herdr unavailable or stale record data, the scope when one is set, and
   the version. `? help` on the right.
2. **Waiting on you**, only when a question is open: the plain question, its category, the
   recommendation and when it was asked, ranked as `record today` ranks them.
3. **Sessions**: every Herdr agent, grouped by repository (a worktree belongs to its main
   repository; git's common directory decides), groups ordered by their most urgent session
   (blocked, working, idle, done), then by name. A record run whose agent has gone stays for an
   hour as `gone`. For a lane agent, the console also reads the optional herdr-lanes session
   registry in the canonical checkout (`.lane/sessions.json` and live records in
   `.lane/sessions.json.d/`) read-only; malformed and completed records are ignored.
4. **Launch bar**, resting (next round).
5. **Footer**: the mode, then the keys that work now, or a message, or the answer prompt.

| Column | Shows | From |
|---|---|---|
| SESSION | `lane <topic> r<round>` from a record run; else `review <topic>` or `lane <topic>` from the lane session registry; else `lane <topic>` from an unnamed or generated-name lane worktree; else the agent's name, then the tab label (`tab 1` for a bare number) | record run `lane`/`round` (the agent's open run, else the latest finished run with its name); read-only `.lane/sessions.json.d/` matched by Herdr name or transcript session id; Herdr `cwd`, agent and tab |
| WHO | tool and model in words, plus effort: `Claude Opus 5 · high`, `Codex Astra · xhigh`; `Claude · unknown` without a model | record run `harness`/`model`/`effort`; else Herdr's `agent` and the transcript's last model. An alias recorded in the record (`opus`) gives way to the exact model in the transcript. |
| WHERE | the checkout folder | Herdr `cwd` (record `workspace` for a gone run) |
| UP | `9m`, `2h`, `3d` or `unknown` | record run `started`, else the transcript's first entry |
| STATE | `working`, `idle`, `blocked`, `done`, `gone`, `unknown` | Herdr `agent_status` |
| DOING | at most ten words | Herdr's terminal title (unless it only repeats the agent's name), else the first sentence of the brief's work (what follows its Work item heading; the fixed opening every record brief has is skipped), else the record item title, else `no description` |

Model IDs are turned into words by a table in `console/lib/names.mjs`; an ID not in it is shown
as it is. Codes (`ENG-7`, `R-12`, commit hashes) are stripped from SESSION and DOING; a title left
with fewer than two words falls through to the next source. At 100 columns WHERE goes; at 80,
WHERE and UP go and DOING takes a second line under each session. At 180 columns and wider a
22-column scope rail sits on the left. Below 80×20 the console only asks for more room. The
session list scrolls (`↑`/`↓` in the left edge say there is more); the header, launch bar and
footer stay put. Selection follows the row, not its position, and rows and groups do not reorder
under the cursor when data refreshes (`r` re-ranks).

Organization question titles also hide record codes. If removing a possessive code would leave
broken text, the list and history show
`Question title depends on a record code · no plain summary`; the untouched title remains
available in the Context tab. Brain result titles are session text, so they are shown unchanged;
their original asked text is also available in Context.

There is no reader pane and no Decided or Finished list on the main screen: the **summary popup**
(`s`) and the **history view** (`h`) show them. The popup's tabs are **Message** (the session's
last assistant message), **Brief** and **Context** for a session; **Summary**, **Memo** and
**Context** for a question; **Summary**, **Document** and **Context** in the history. Context is
the only place codes appear.

#### Keys and mouse

Waiting on you is a work queue, written the way the operator reads work: the item's id, a quoted
gist of what is at stake, a few plain sentences on why it matters (all of them on the selected
row, two on the others), then the actions, one line each, with what each causes and
`← recommended`. At the top: what stopped sessions left behind (from the brain queue, when
`brain_bin` is set), read by brain's digest. Brain derives each result's project by matching its
session folder to a configured checkout or that checkout's supported worktree layouts; unmatched
folders are named `other`. Each project tab shows its own results plus `other` (so unmatched work
is always reachable), and one line counts results waiting in the other configured projects. Use
`p` to switch project tabs. Under the Brain results, record questions for the stage the project is
working on now (`G-1 meta.stage_now`), each read once by `brain explain` (one small model call per
question, cached by its content; `"explain": false` in `console.json` turns it off). Items saved
for later, and record questions that are parked or belong to a later stage, fold into one line each;
Enter opens a fold. The project's newest instruction from the operator sits above the list.

| Key | Action |
|---|---|
| ↑/↓, j/k, PgUp/PgDn, Home/End | Move in the list (or scroll the open popup) |
| Enter, left click | On a session, or a result whose session is still in Herdr: **peek**, the session's own screen inside the console (`herdr agent read --source recent-unwrapped`), re-read every 1.5 s and following the end. Esc comes back with the same row selected. On a question or a gone session: the summary. On a fold: open or close it. |
| g | Go to the session in Herdr (`herdr agent focus`). Back: `last_pane`, bound below. Run as a popup, the console closes itself after going. |
| 1–9, click a choice | Pick that choice. A session stuck at a prompt gets that key pressed (`brain key`); a finished session gets the choice's words sent as a reply (`brain send`). Always confirmed first; on a sent reply, `e` edits it before sending. |
| y | On a result: send Claude's draft (`y` shows it, Enter sends, `e` edits), else pick the recommended choice. On a question: approve. |
| n | On a result: pick the one choice that says no. On a question: decline (a one-line reason is required). In the history: overrule. |
| r | Reply to the session in your own words (`brain send`, or `herdr agent prompt` for a plain session). Herdr refuses a session stuck at a prompt before sending anything; the footer says so. |
| l | Save a result for later: it leaves the list and waits under the *saved for later* fold. |
| x | Drop a result for good (`brain never`), or clear a finished report you have read (`brain dismiss`). Confirmed first. |
| i | Give the whole project an instruction in your own words. It is recorded as an operator decision note on the project's top goal (`OPERATOR DIRECTION <date time>: …`), which its sessions read first, newest first, before deciding anything. Nothing is sent into a running session. |
| L | Turn the brain loop off or on (`brain service stop|start`), after a confirmation. The header says `loop ok`, `loop stalled`, `loop down` or `loop off`. |
| 1–9 on a record question | When the question has been read, its worked-out answers are choices too: the number records that answer with `record answer`, after a confirmation. |
| d | On a record question: start a session that works it out (`brain start`: a new Herdr tab in the project's checkout, on the folder's Claude account, with a brief that asks for the real choices and a recommendation and forbids deciding). When it stops, its choices come back to Waiting on you. The question gets a record note naming the session. |
| s | Summary popup: 1/2/3 tabs, j/k and page keys scroll, `o` opens the file, Enter peeks, Esc closes |
| m, right click | Row menu with the verbs the row offers. Arrows and Enter pick; Esc closes. |
| Tab | New task (next round) |
| h | Today's history, newest first: answers, decisions and finished work. `h` or Esc returns. |
| / | Scope: all repositories, one repository, *needs you*, *working*, or the history. A repository (a click on the rail, too) narrows the sessions and Waiting on you alike: brain results whose session ran in that repository or one of its worktrees, and record questions when it is the project's own checkout. *working* hides Waiting on you |
| ! / w | Show only what needs you / only working sessions (again to show all) |
| wheel | Scroll the list, or the open popup |
| o | Open the brief, memo, report or message with `$VISUAL`, `$EDITOR` (the console suspends and returns) or macOS `open -t` (the default text editor) |
| p | Next project, when more than one is configured |
| R | Reload now |
| ? | Help |
| Esc | Close the innermost thing. In its own pane it never quits; run as a Herdr popup, Esc on the list closes the popup. |
| q | Quit (from the list or the history) |

#### Getting in and out of sessions

Herdr's `last_pane` jumps back to the pane you came from and ships unbound. Bind it, and summon
the console as a popup over whatever you are looking at:

```toml
# ~/.config/herdr/config.toml
[keys]
last_pane = ["prefix+backtick", "ctrl+alt+b"]   # back to where you were, one chord

[[keys.command]]
key = "ctrl+alt+c"
type = "popup"
command = "node /path/to/herdr-org/bin/org.mjs console"
width = "100%"
height = "100%"
description = "Herdr Monitor"
```

As a popup (no `HERDR_PANE_ID`, `HERDR_ACTIVE_PANE_ID` set, or `HERDR_CONSOLE_POPUP=1`) the
console closes itself when you go to a session, and Esc on the list closes it. Ctrl+Alt+C brings
it back. Esc is never the way back from inside a session: Claude Code uses it to interrupt.

The console turns on the terminal's mouse reporting (SGR mode) while it runs and turns it off
when it quits, when it suspends for an editor, and when it crashes. Herdr keeps right clicks for
its own pane menu unless the pane asks for them, so inside Herdr (where `HERDR_PANE_ID` is set)
the console runs `herdr pane input --right-click pane $HERDR_PANE_ID` when it starts and
`--right-click herdr` when it quits, suspends for an editor or crashes. While the console runs,
Herdr's own pane menu is not available in that pane. Without `HERDR_PANE_ID`, or if that call
fails, right clicks stay Herdr's; `m` opens the same menu. The keyboard does everything the mouse
does.

The console records answers only through `record answer` (a child process with an argument array,
`ORG_ACTOR=human`, so the answer is the operator's; the reason goes as `--note=<reason>`) and
re-reads at once. Everything agents wrote is shown with terminal escape sequences and control
characters removed. A text document opened with `o` is written to a private temporary folder and
removed when the editor returns (or, for macOS `open -t`, when the console quits). It never appends to
`events.jsonl` directly, and never stops or closes an agent. It reaches into a session only when the
operator has confirmed it: a reply (`r`, or a choice sent as words), a key pressed in a prompt the
session is stuck at (a choice), or a new session started to work out a question (`d`). Its other
Herdr actions are reading the agent and tab lists, reading a session's screen for the peek,
focusing a tab or agent, and routing right clicks in its own pane.

## Releases and the Herdr plugin

Projects run a release, never this working tree, so a merge to main changes nothing until a
release is activated. `herdr/release.sh` manages them:

```sh
herdr/release.sh build v0.1.1      # copy the tag into ~/.local/share/herdr-monitor/releases/v0.1.1 (read-only) and run its build step
herdr/release.sh activate v0.1.1   # point current at it; manage record, org and lane, remembering each launcher the first time it is managed
herdr/release.sh rollback          # back to the release before
herdr/release.sh restore           # each launcher back to before it was first managed; the Brain service back to before the first activation
herdr/release.sh dev <worktree>    # a second plugin, rewt.herdr-monitor-dev, running a worktree beside the release
herdr/release.sh status
```

`herdr-plugin.toml` makes the repository a Herdr plugin (`rewt.herdr-monitor`): a console pane
that opens as a split beside a chat, an action to open it, and a build step that installs the
console's dependencies. Herdr resolves the path it is given, so the plugin is bound to one
release directory; `activate` and `rollback` re-link it whenever the release changes. A GitHub install (`herdr plugin install`) would use the same
manifest and build step.
## Item activity

The modern console's Activity view (`a`) reads the last 36 hours from `record log`: item creation,
run starts, reports, decisions and closes. Agent-created items carry their recorded reason, and an
item page says who or which run proposed it. The screen's existing Tasks, Needs you and Sessions
views remain the current-state frame; Activity is the chronology. The retired standalone items
pane is no longer installed or documented as a second console.

## Guardrails are advisory

`max_runs`, `max_children`, `max_depth` and `escalation_budget` default from `.org/config.json`
and can be set per item (`--budget max_children=8`, `record set ID budget.max_runs=5`); descendants
inherit them. Exceeding one is shown under ATTENTION and never stops work.

The CLI refuses only what would make the record inconsistent: unknown ids, blocking or parent
cycles, a second, different report for the same run, a report whose run contradicts `--run`, and
reports it cannot parse.

## Status

Derived, never stored, checked in this order:

1. `done` or `dropped` if closed;
2. `active` if a run is open;
3. `blocked` if a blocker item is unresolved;
4. otherwise from the latest report: `done`, `needs_human`, `blocked` (nothing linked yet), or
   `ready` (blockers resolved, last run failed, or nothing reported yet).

Goals roll up their descendants. An abandoned run frees its item; `record sync` and `record ingest` skip
any report that arrives later, and `record abandon` says that late reports will not be ingested.

## Measuring cost

- `record start` prints each brief's size and `record snapshot` prints its size on stderr: these are the
  cold-start context the organization adds.
- Record usage when a harness shows it: `record set R-3 tokens_in=48210 tokens_out=5120 cost=0.42`,
  or add a `usage:` block to the report. `record status` and `record show <item>` total it.

## Storage

```
.org/
  events.jsonl     append-only record; current state is a fold over it
  config.json      default budgets and approval policy
  runs/R-n/        brief.md (what the run was given), report.md (where it writes)
  reports/R-n.md   immutable copy of each recorded report
```

Only the CLI writes `events.jsonl`, under a lock. It is plain JSONL, so `jq`, `grep` and
`git diff` work on it. Whether to commit `.org/` is your call. A sandboxed harness that cannot
write outside its workspace can be started with `record start ID --report <path-in-workspace>`.

## Not in this version

Automatic dispatch, harness adapters, Herdr plugin integration, leases, memory integration,
planning, model routing and token or quota enforcement. They get added when dogfooding shows
they are needed.
