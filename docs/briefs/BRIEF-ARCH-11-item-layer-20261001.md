# Brief: ARCH-11, what should hold the work items

Org item **ARCH-11**, under Phase 2 (ARCH-7) of the platform roadmap (G-3). Read
`docs/north-star.md` first, then `docs/roadmap.md`. They are the context; this brief is
only the ask.

## The outcome

A recommendation the operator can act on: should Herdr's platform keep its own record
for work items, adopt an existing agent tracker's format, or something else? Back it with
a short hands-on trial, not just reading.

## Why it matters, and to whom

The platform is meant to be adopted by any Herdr user on any project. The operator asked
whether a standard for tracking agent work already exists, so that we don't build our
own, and so that a project's work stays portable to other tools. The answer shapes the
Phase 2 restructure (repo layout, naming, the record's format). It is cheap to decide now
and expensive after bch-cloak's record (about 10,500 events) has been moved onto
whatever we choose.

The people who live with the answer:
- the operator, who reads the work in the console;
- the agents, who write it through the CLI or MCP;
- a future Herdr user, who adopts it with no history in this repo.

## How the result will be judged

- It answers "what should hold the work items" with a clear position, and says how sure
  it is.
- For each candidate it says what it covers among the things our cycle needs:
  - items and dependencies, and "what is ready";
  - runs: who worked on what, with which harness, model and effort;
  - structured reports;
  - questions with a category and a recommendation;
  - decisions;
  - priorities;
  - derived status.
- Claims come from trying things, not only from reading their docs. At minimum, run a
  candidate against a copy of herdr-brain's record (95 items, 25 runs). Claims taken from
  docs alone are marked as such.
- The MCP Tasks extension is checked against its specification, not a blog post.
- It states what moving bch-cloak's record would cost, and what the operator would see
  change in the console.

## Premises to test

Each was said by the operator or by the agent in a chat. Test each one: confirm what
holds, correct what doesn't, and say when you can't tell. Give the evidence either way.

1. "A standard tracker makes us portable." Portability may come from an interface (MCP,
   import/export) rather than from the storage format.
2. "Our record's runs, reports, questions and decisions are what make the cycle work,
   and no tracker covers them." Check whether one does, or could with its extension
   points.
3. "Beads is the closest match." Check, and consider anything else this brief doesn't
   name.
4. "Adopt or build" is the right framing. There may be a better third option.
5. "Decide this before the restructure." It may not need deciding at all yet.

If the evidence says the question itself is wrong, say so. That is a valid outcome.

## Already decided (don't reopen without new evidence)

- The operating model: agents decide, the record captures, the console shows, the human
  steers (`docs/north-star.md`).
- The core never calls a model, budgets are advisory, status is derived, and older code
  ignores newer event types (`AGENTS.md`).
- bch-cloak must not be disrupted. Its record is at `/Users/rewt/development/bastian/.org`.

## Boundaries

- Read-only for both live records. Copy a record before trying anything on it, and work
  under `/private/tmp/arch-11-*/`.
- Never write `/Users/rewt/development/bastian/.org`, and change nothing in bch-cloak.
- Install candidates only into the scratch directory; nothing global, nothing that
  outlives the trial.
- No push, publish or account sign-up. If a candidate needs one to evaluate it, say so
  and stop there.

## Where you are free

How you evaluate, which candidates you add or drop, how deep you go into each, and what
you recommend, including recommending none of them. If you see a better question than
the one asked, answer that one too.

## Reply

Write the report as an org report (template below) at
`docs/reports/ARCH-11-item-layer-20261001.md` on this lane, and run `org check` on it
until it passes.

The three fields after `artifacts` are new and are kept as given:
- `decisions` are the choices you made yourself;
- `questions` are what you could not decide;
- `challenges` gives your verdict on each premise above (holds, partly, wrong or can't
  tell), plus anything else you found wrong, with the evidence.

```markdown
---
run: R-RUN
outcome:            # done | blocked | needs_human | failed
headline:           # one plain sentence for the operator
summary: |
  (your recommendation, how sure you are, and why)
blockers: []
proposals: []       # follow-on work this recommendation implies
learnings: []
artifacts: []       # scratch paths, commands run, files read
decisions: []       #  - decision: …   why: …
questions: []       #  - question: …  recommend: …  why: …  category: design|tooling|other
challenges: []      #  - premise: …   verdict: holds|partly|wrong|unknown   evidence: …
---

(the comparison, the trial's evidence, and the cost of moving bch-cloak's record)
```
