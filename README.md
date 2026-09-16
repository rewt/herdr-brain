# herdr-org

Durable organizational state for agent-driven R&D, so that no LLM session has to stay alive to
remember what the organization is doing.

It records goals and work items, runs (attempts) against them, and the reports those runs produce.
Status, briefs and snapshots are derived from that record deterministically: they cost zero
inference tokens, and a completely fresh session of any harness can continue from them.

- Durability replaces conversational context; it does not add bureaucracy around it.
- Reasoning costs tokens. Coordination mostly should not.

Node ≥ 20, no dependencies. Put `bin/org.mjs` on your PATH as `org` (`npm link`, or
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
- **Workers decompose their own blockers.** Each proposal becomes a child item of the reporting
  item. When the outcome is `blocked`, proposals also block it (override per proposal with
  `blocking: true|false`), so it becomes ready again when they are done. No triage session needed.
- `learnings`, summaries and decisions flow into later briefs and the snapshot.
- `org check <file>` validates a report without recording it.

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
  config.json      default budgets
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
