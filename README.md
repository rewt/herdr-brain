# herdr-org

Durable organizational state for agent-driven R&D, so that no LLM session has to stay alive to
remember what the organization is doing.

It records goals and work items, runs (attempts) against them, and the reports those runs produce.
Status, briefs and snapshots are derived from that record deterministically: they cost zero
inference tokens, and a completely fresh session of any harness can continue from them.

- Durability replaces conversational context; it does not add bureaucracy around it.
- Reasoning costs tokens. Coordination mostly should not.

Node ≥ 20, no dependencies (the optional `console/` has its own). Put `bin/org.mjs` on your PATH as `org` (`npm link`, or
`alias org="node /path/to/herdr-org/bin/org.mjs"`).

## The loop (you are the scheduler)

```sh
org init                                     # creates ./.org
org add --goal "Rate limiting shipped"       # → G-1
org add "Persist rate-limit state" --parent G-1 --role engineer --capability deep \
    --accept "survives restart"              # → ENG-1
org start ENG-1 --harness claude-code --model opus
# R-1 started on ENG-1 "Persist rate-limit state" [claude-code · opus]
#   brief   /…/.org/runs/R-1/brief.md  (1830 chars ≈ 458 tokens)
#   report  /…/.org/runs/R-1/report.md
#   prompt  Read /…/.org/runs/R-1/brief.md and follow it.
```

Launch any harness (in a Herdr pane or anywhere) and give it that prompt. The worker writes one
report when it stops: done, blocked, needs a human, or failed. No progress updates. Then:

```sh
org sync      # record reports waiting at open runs' report paths
org status    # one screen, no inference
```

Kill every session whenever you like. `org status` rebuilds the picture from `.org/` alone, and
`org snapshot` prints markdown meant to be handed to a fresh Claude, Codex, Gemini or other
session ("Read the output of `org snapshot`, then …").

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
  hashes. It is optional; `org check` and `org ingest` warn when it is missing and never refuse.
- **Workers decompose their own blockers.** Each proposal becomes a child item of the reporting
  item. When the outcome is `blocked`, proposals also block it (override per proposal with
  `blocking: true|false`), so it becomes ready again when they are done. No triage session needed.
- `learnings`, summaries and decisions flow into later briefs and the snapshot.
- `org check <file>` validates a report without recording it.

## Questions for the operator

Agents never hand the operator an open question or a list of options. They research, recommend,
and ask one plain yes/no question:

```sh
org ask "Adopt the theft fix once its review passes?" --parent G-1 --category design \
    --recommend yes --why "O1 is the only option where the network refuses the theft. The review passed." \
    --on-yes "Implementation and its review start." --on-no "The fix path stops." \
    --memo archive/DECISION-THEFT-FIX-20260916.md --blocks ENG-7 --blocks REV-3 [--priority 80]
# → HUM-5
```

- The question is an ordinary `role=human` item, so the work it `--blocks` waits and unrelated work
  keeps moving. `meta` holds `category`, `recommend`, `memo`, `on_yes` and `on_no`; a note holds
  `--why`. Everything is recorded in one transaction.
- `--parent`, `--category`, `--recommend` and `--why` are required. `--memo` must exist (it is
  stored as an absolute path). Unknown categories are refused with the list of known ones.

```sh
org answer HUM-5 yes|no|"<short text>" [--note "why"] [--overrule]
```

- Records a decision note, sets `meta.answer` and `meta.answered_by` (the actor: `human` unless
  `ORG_ACTOR` is set), and closes the question as done.
- **`no` does not release the work.** A question closed with `meta.answer=no` counts as unresolved
  for the items it blocks: they stay `blocked` (status shows `declined: <question>`) until someone
  re-plans them and runs `org unblock <ID> --by HUM-5`. `yes` and text answers release them.
- A second answer is refused. `--overrule` re-answers an answered question (typically one answered
  automatically) and records `meta.overruled=true`.

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
(`meta.answered_by=auto`, the asking session as actor); it shows under *Decided today*, where the
operator can still overrule it. Everything ships as `ask`. Relax a category only when its
`answered_as_recommended` count in `org today --json` shows the agents decide it well.

| Category | Covers |
|---|---|
| design | Adopting or changing a design, spec, protocol, relation or cryptography |
| security | Handling a vulnerability, exposure or disclosure |
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
org note ENG-7 --decision --summary "Leave the exposed test cells alone until the fix lands" \
    "Per archive/DECISION-CELLS-20260916.md: …"
```

The console shows the summary. A decision without one is shown as its first sentence with codes
removed, marked `· no plain summary`.

Sessions opened by `contrib/settle-watch.mjs` get `ORG_ACTOR=<session name>`, so the record tells
their answers and notes apart from the operator's.

## `org today`: the operator's read model

`org today` prints what waits on the operator, what was decided, what runs and what finished
today, one line each, codes only in parentheses at the end. `org today --json` is the console's
only view of the organization. It is deterministic for a fixed record, config, `ORG_NOW` and `TZ`
("today" is the local day of `TZ`).

```jsonc
{
  "project": { "org": "/…/.org", "as_of": "ISO time", "events": 667,
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
      "blocks": [{ "id", "title" }], "at", "by" },
    { "kind": "note", "id", "seq", "title", "summary": "…|null", "text", "at", "by" }
  ],
  "running": [{ "run", "item", "title", "role", "started", "agent", "lane", "brief_path", "report_path" }],
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
- Live Herdr state and session notes are not part of `org today`: the core never talks to Herdr.

## The console

`org console` is a terminal app for a Herdr pane next to the agents. It costs no model tokens and
answers four questions: what is waiting on me, what did the agents decide and why, what is
running and what finished, and where can I read the whole thing.

```text
bch-cloak · 17:12 · 22/30 sessions today · 1 alert                                        ? help
WAITING ON YOU (3)
> Adopt the theft fix once its review passes?           design                    recommend: yes
…
─ Adopt the theft fix once its review passes? ─────────────── [1 Summary] 2 Document 3 Context
  Recommend: yes. O1 is the only option where the network itself refuses the theft.
y approve   n decline   o open   Tab reader   Enter expand   1-3 tabs   r reload   ? help   q quit
```

### Install and run

```sh
npm --prefix console ci          # Ink and React, pinned by console/package-lock.json
org console [--project NAME]     # or: node console/app.mjs [--project NAME] [--config FILE]
contrib/console-pane.sh [NAME]   # an unfocused Herdr tab labelled "console" in the project's workspace
node console/app.mjs --print 100x30 [--select N] [--tab 1|2|3]   # one frame as text, no terminal needed
```

The core stays dependency-free: only `console/` has dependencies, and root `npm test` passes
without them. `npm --prefix console test` runs the console tests alone.

### Configuration

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
  "refresh_seconds": 5
}
```

- `org`: read with `org today --json`, again whenever `events.jsonl` changes and every
  `refresh_seconds`. If a read fails, the last good data stays and the header shows its age.
- `ledger_dir`: `sessions-YYYY-MM-DD.log` (session notes, and the count against `session_cap`) and
  the `STOP` file.
- `cwd` and `claude_config_dirs`: where session transcripts are found. A session note is the last
  assistant message of the transcript whose `agent-name` entry names the session; only transcripts
  modified today are read, and each is cached by modification time.
- Herdr: `herdr agent list` on the same cadence. Runs are joined to agents by `meta.agent`; live
  `settle-*`, `exec-*`, `plan-*` and `audit-*` agents are listed as executive sessions. Without
  Herdr the header says "Herdr unavailable" and states read "unknown".

### Screen

Five sections: *Waiting on you*, *Decided today*, *Running*, *Finished today*, *Session notes*.
Each row is one plain line: headline, category or role, then time and state. The reader below
has three tabs: **Summary** (the explanation, recommendation and what happens on yes or no),
**Document** (the memo, report, brief or session note, rendered from markdown) and **Context**
(IDs, paths, agents, timestamps, links: the only place codes appear). Rows that have no plain text
are shown with codes removed and marked `· no plain summary`.

Selection follows the row, not its position, and rows do not reorder under the cursor when data
refreshes (`r` re-ranks). The layout fits 80, 100 and 140 columns; below 80×20 it shows a resize
hint. Every state is written as text; `NO_COLOR` turns color off entirely.

### Keys

| Key | Action |
|---|---|
| ↑/↓, j/k, PgUp/PgDn, Home/End | Move in the list (or scroll the reader when it has focus) |
| Tab | Switch focus between the list and the reader |
| 1 / 2 / 3 | Reader tab: Summary, Document, Context |
| Enter | Expand the reader to full height, or shrink it |
| y | Approve the selected question; Enter confirms, Esc cancels |
| n | Decline a question, or overrule an automatic answer: a one-line reason is required, then Enter confirms |
| o | Open the document with `$VISUAL`, `$EDITOR` (the console suspends and returns) or macOS `open` |
| f | Go to the agent's Herdr tab; refused visibly if the agent is gone |
| p | Next project, when more than one is configured |
| r | Reload now |
| ? | Help |
| Esc | Close the innermost thing; never quits |
| q | Quit (only from the list) |

The console records answers only through `org answer` (a child process with an argument array,
`ORG_ACTOR` removed, so the answer is the operator's) and re-reads at once. It never appends to
`events.jsonl`, and never starts, stops or messages agents; its only action on agents is focusing
a tab. Answers are acted on by the next executive pass.

## Guardrails are advisory

`max_runs`, `max_children`, `max_depth` and `escalation_budget` default from `.org/config.json`
and can be set per item (`--budget max_children=8`, `org set ID budget.max_runs=5`); descendants
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

Goals roll up their descendants. An abandoned run frees its item; a report that arrives later is
still recorded and marked late.

## Measuring cost

- `org start` prints each brief's size and `org snapshot` prints its size on stderr: these are the
  cold-start context the organization adds.
- Record usage when a harness shows it: `org set R-3 tokens_in=48210 tokens_out=5120 cost=0.42`,
  or add a `usage:` block to the report. `org status` and `org show <item>` total it.

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
write outside its workspace can be started with `org start ID --report <path-in-workspace>`.

## Not in this version

Automatic dispatch, harness adapters, Herdr plugin integration, leases, memory integration,
planning, model routing and token or quota enforcement. They get added when dogfooding shows
they are needed.
