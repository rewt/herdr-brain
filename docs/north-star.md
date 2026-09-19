# North star: durable brain, ephemeral heads

This file exists so a fresh session can re-anchor on the intent without
reconstructing it from conversation history. It records the *destination and the
reasoning*, not a milestone tree. If something here conflicts with an
implementation, the implementation is what is wrong.

Written 2026-09-15. Owner: operator. Status of each capability is tracked at the
bottom and is expected to change; the principles above it are not.

## The problem

The working R&D pattern today is a long-running day or shift supervisor that
dispatches engineers, researchers, architects and reviewers, interprets their
reports, and decides what happens next. Organizationally this works.

It is expensive for one reason: **the supervisor's context grows all day**, so every
later turn costs more than the one before it, and most of that spend buys
coordination — waiting, polling, handoffs, remembering who is doing what — rather
than reasoning. Splitting the day into shifts reduces the symptom without touching
the cause.

The redesign keeps the behavior and removes the resident LLM.

## Principles

> **Workers are ephemeral. The organization is durable.**

> **Reasoning should cost tokens. Coordination and continuity mostly should not.**

The economic goal is primary: eliminate the continuously growing supervisor context
while preserving autonomous R&D progress and organizational continuity. Sophistication
of the orchestration is not a goal and is usually evidence of a wrong turn.

## The architecture

Herdr Brain is not a process. It is durable organizational intelligence plus
short-lived reasoning sessions. **The brain is durable; the executive function is
ephemeral.** There is no resident head.

```text
                    DURABLE BRAIN

              organizational state
                     +
              project truth / evidence
                     +
              reports / decisions
                     +
              cognitive memory
                     │
                     ▼
          context / retrieval layer
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
 ephemeral workers        ephemeral brain / head
 ENG / ARCH / REV /       planning / reasoning /
 research / etc.          human conversation
          │                     │
          └──── writes durable outcomes ────┘
```

Four sources feed the durable brain, and no single one should be made responsible
for everything:

- **`org`** — operational knowledge: goals, work items, runs, reports, blockers,
  progress, decisions or decision references, priorities, what needs attention.
- **Git / specs / ADRs / evidence** — authoritative project truth: what code exists,
  accepted architecture, implementation state, tests and gates, accepted decisions
  and their rationale.
- **Cognitive memory (Claude Mem today)** — associative and historical knowledge:
  discoveries, failed approaches, subtle context, what agents learned while
  investigating, history around files and concepts, prior reasoning that is not
  itself authoritative. **Memory must never determine whether an item is active,
  complete or blocked.**
- **A context / retrieval layer** — possibly the most important piece. A fresh
  session receives a small, targeted cold start and pointers, never the
  organization's historical transcript, and retrieves depth only on demand.

Model and harness agnosticism is a requirement of the whole design: organizational
state must not depend on Claude-specific semantics, and cognitive memory eventually
needs a neutral retrieval boundary so a Codex, Gemini or Grok head benefits equally.
That interface does not need solving yet.

## The four capabilities

**1. Durable organizational state.** Important organizational knowledge lives
outside any LLM context.

**2. Cross-session execution continuity.** A worker does real work, reports,
disappears; a fresh worker continues without a resident supervisor mediating the
handoff — no `--resume`, no shared chat context, no human copy/paste. Workers
perform their own first-level decomposition wherever practical (an engineer that
hits architectural ambiguity reports `blocked`, explains why, and proposes the
architecture or research follow-up), because that is what removes
supervisor → triage → planner calls.

**3. Ephemeral executive / planning.** Something must periodically reason about what
the project is trying to accomplish, what happened recently, what agents learned,
what the priorities should be, what the next goals are, and what genuinely requires
the operator — then record that and exit. Goal creation may cost tokens once;
asking "what are today's goals?" afterwards must cost zero. The operator is not
going to hand-create every goal and work item forever.

**4. Disposable human-facing brain.** A zero-inference surface for today's goals,
progress, active work, blockers, needs-human and recent changes; and, when reasoning
is actually wanted, a fresh conversational session through any harness that
reconstructs the same organizational perspective, answers, and is then closed. Hours
later another fresh one gives essentially the same continuity.

## Constraints

**Do not turn the operator into the scheduler.** Removing the supervisor by making a
human do its job is not a solution. Within a reasonable authority envelope, agents
make ordinary reversible project decisions themselves and record the rationale;
they often hold more current project knowledge than the operator does.

**Escalate with substance, not as an approval queue.** When something genuinely
needs the operator, present the decision, the relevant context, viable options, the
agents' recommendation, and why operator authority is actually required.

**Do not build a control plane that inhibits R&D.** The organization layer exists to
remember, coordinate, recover, understand, resume and reduce token spend — not to
impose bureaucracy on experimentation. Research needs freedom to investigate,
discover unexpected lines of inquiry and change direction. Guardrails normally
provide **visibility and escalation**, not refusal. Reserve hard stops for explicit
human authority, shared-state correctness, irreversible operations and configured
hard resource limits. A useful research path must never die because a rule said
`max_children = 4`.

## How we judge it

Not by orchestration sophistication. By whether tokens fall while the useful
behavior survives:

- total tokens per useful work item;
- cold-start tokens for a fresh agent;
- tokens spent rediscovering prior work;
- coordination and model calls between productive reasoning sessions;
- idle and polling inference — ideally zero;
- planning tokens;
- share of tokens going to engineering, research and review versus supervision;
- whether fresh agents correctly continue prior work.

## What is not the destination

`org` is a deterministic substrate for *some* organizational state. It is not the
brain, and a passing test suite is not evidence of continuity. Do not treat storage
as the finished system: nothing is proven until real work has depended on it across
a real session boundary.

## Capability status

Deliberately conservative. "Exists" means built; "proven" means real work depended
on it across a real boundary.

Updated 2026-09-16 after the first bch-cloak pilot; evidence and numbers in
`pilot-M1-results-2026-09-16.md`.

| Capability | Exists | Proven |
| --- | --- | --- |
| 1. Durable organizational state | `org` M1, live for bch-cloak (goals, items, runs, reports, decisions, priorities); still 1 of the 4 sources | **Partly** — sessions continued real work from it all afternoon; no link yet to git/evidence or memory; org cannot yet say "done by worker, awaiting review" |
| 2. Cross-session execution continuity | Watchers (`contrib/settle-watch.mjs`) + fresh settle sessions under `SETTLE.md` | **Yes, for transitions** — 13 real runs handed off with no resident LLM, flat 54k–124k context per session; workers wrote valid reports and decomposed their own follow-ups |
| 3. Ephemeral executive / planning | `continue.sh` opens a fresh executive; decides within delegated authority | **No** — the day's plan (protocol release) was missing from org until the operator intervened and a long chat rebuilt it; no planning session exists |
| 4. Disposable human-facing brain | `org status` / `org snapshot`; no curated view; notifications off | **No** — the operator's window was a long-running chat that cost 99M input tokens, more than the supervisor it replaced |

2026-09-18: herdr-lanes was folded into `lanes/` as the dispatch layer for worktrees, dispatch, review and promotion.

**The supervisor is not gone until jobs 2–5 of the pilot write-up (exceptions,
planning, operator window, oversight) have homes that are not a live chat.**
Proposed homes: `design-M2-supervisor-homes.md`.
