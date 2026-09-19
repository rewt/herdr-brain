# Brief: design how goals and priority reach an agent's next task

Written 2026-09-19 by the operator's request. You are a designer and architect
on Codex (Astra). This is a design task with open questions to reason through,
not a spec to implement — the operator wants your own frontier knowledge
applied here, not a layout dictated in advance. Read this whole file, and the
files it points to, before touching anything.

## The one paragraph

The console (`herdr-brain`) is the operator's cockpit over a fleet of
autonomous coding agents working through `org`, `lane` and Herdr. The last
design round (ARCH-3, runs R-19 through R-23, now on `main`) fixed how the
operator reviews and decides: a scoped cascade (goals → tasks → open items)
above a sessions pane, one-line waiting rows, Enter for detail. That is done
and live in `console/proto/main.mjs` and
`docs/design/console-screens-2026-09-18.md` — read it, do not redesign it.
What it does not touch is the layer underneath: how a goal's priority actually
reaches an agent's choice of what to work on next, and how the operator sees
and adjusts that. That is this round.

## What is already decided (binding — design within this, do not relitigate it)

Read `docs/north-star.md` in full before anything else; it is the
organization's committed philosophy, written 2026-09-15 by the operator, and
nothing below may contradict it. The load-bearing lines:

- "Workers are ephemeral. The organization is durable." There is no resident
  supervisor; something periodically reasons about priority and what happens
  next, records the decision, and exits.
- "Do not turn the operator into the scheduler." Within a recorded authority
  envelope, agents make ordinary reversible project decisions themselves.
- "Escalate with substance, not as an approval queue." When the operator's
  input is genuinely required, present the decision, the context, the viable
  options and a recommendation — never a bare yes/no queue.
- Capability 3, "ephemeral executive / planning": something must periodically
  reason about priorities and what's next, then record that and exit; goal
  creation may cost tokens once, but asking "what are today's goals?"
  afterward must cost zero.

## Where this stands in the code today

- Priority exists as a bare number on org items (`priority`, lower first),
  used only to order the ready queue: `unblocksPrioritized` in `lib/today.mjs`
  and the priority-descending comparator in `lib/state.mjs`. The console shows
  it only inside a row's detail tab (`console/lib/model.mjs`); it has no
  presence in the cascade, and nothing in the console lets the operator set or
  adjust it.
- The only code that actually reads that priority order and autonomously
  opens and dispatches lanes today is `supervisor/SETTLE.md` section 7
  ("Continue mode"), armed by `contrib/settle-watch.mjs`: an LLM "executive"
  session that takes ready items in priority order and self-dispatches them,
  but only inside per-goal authority recorded as decision notes on the goal;
  anything outside that authority becomes an `org add --role human` question
  instead of a dispatch. This is a real, working instance of the north star's
  capability 3 — and also close to the resident-flavored watcher pattern the
  north star names as the thing being moved away from. Read that section and
  skim `contrib/settle-watch.mjs`.
- `org`, `lane` and `brain` are otherwise entirely human-driven: `lane open`
  and `lane dispatch` always take an explicit topic and brief from whoever
  calls them; `brain.mjs` only watches and triages finished or stuck sessions,
  it never selects work.
- None of this — priority, authority envelopes, what settle-watch decided and
  why — is visible anywhere in the console today.

## The questions (answer these; do not treat anything below as fixed)

Write field notes before you design, the same discipline as the last round's
tool survey, but pointed at a different field this time. That round already
covered terminal-UI precedent (K9s, lazygit, htop/btop, mutt/aerc, Magit,
Miller columns) — do not repeat it, cite it by reference if relevant. This
round's precedent is priority-driven scheduling and fleet-orchestration
surfaces: Kubernetes priority classes and preemption, CI/CD queue and pipeline
prioritization, the ranked-backlog UX of project-management tools, on-call and
paging escalation systems, and whatever you actually know of multi-agent
"factory" or fleet products and how they visualize a fleet working against
ranked goals. Say plainly where you are inferring versus where you know a
specific product's interface; do not invent detail about a tool you are not
sure of.

Then answer, with reasoning, and commit to a recommendation for each:

1. **What is priority, structurally?** A property of a goal, a task, or both —
   inherited down with an optional override, or set independently at each
   level? Is a bare number (today's shape) the right representation, or does a
   rank order, a small tier set, or something contextual (age, blocked time,
   budget remaining) serve the operator and the ephemeral executive better?

2. **Where should the "pick the next task" decision actually live**, given
   capability 3 already exists as settle-watch? Does the console need a way to
   trigger that reasoning (a "run the executive now" action), or should it
   only ever show the aftermath — what got picked, why, and what's still an
   open question? Should the operator be able to view or edit a goal's
   authority envelope — the pre-granted scope that lets an agent self-dispatch
   inside it — from the console, rather than only through `org note
   --decision`?

3. **What does trust look like at the moment of autonomy?** "Escalate with
   substance, not an approval queue" is binding. When an ephemeral executive
   session self-dispatches a lane, what does the operator see, and when —
   folded into the existing sessions pane, a distinct feed, both? Days later,
   how does the operator audit "why did an agent pick this" without reading a
   full transcript? The north star is explicit that cold-start budget matters;
   do not propose a design that requires reading history to understand a
   decision.

4. **Does priority need its own place in the console**, separate from the
   existing goals column — a ranking surface for "these goals matter most this
   week" — or does it belong as a visible attribute or sort inside the cascade
   that already shipped? If a distinct surface, how does the operator actually
   reorder things: is there a terminal-native equivalent to drag-to-reorder,
   and is one even needed, or does a numbered rank or a promote/demote
   keystroke do the job better in this medium?

5. **Given "do not turn the operator into the scheduler,"** is full autonomous
   pickup — an agent grabs the next ready item with no human touch — actually
   the right target to design toward now, or does the field suggest a middle
   state earns trust first: an agent proposes its next task and a single
   keystroke confirms it, with fuller autonomy following once that is proven?
   Say what you would recommend and why.

6. **What survives translation into this medium, and what doesn't?** This
   console is keyboard-first, mouse-aware, minimal, and runs inside a terminal
   multiplexer (Herdr) where the agents' own panes are already visible — it is
   not a standalone web dashboard. Whatever you know of polished multi-agent
   "factory" web products (the operator mentioned Warp's agent/factory
   surfaces as one data point, not a spec to copy), say specifically what
   concept transfers to Ink and what is web-only chrome that would fight the
   north star's own constraint against building "a control plane that
   inhibits R&D."

## Where things are

- Canonical checkout: `/Users/rewt/development/rewt/herdr-brain`. Read
  `docs/north-star.md`, `supervisor/SETTLE.md` (section 7),
  `contrib/settle-watch.mjs`, `lib/today.mjs`, `lib/state.mjs` (the priority
  comparator), `console/lib/model.mjs`, `docs/design/console-screens-2026-09-18.md`
  and `docs/reports/console-design.md` before anything else.
- Your worktree:
  `/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy`
  on branch `lane/console-autonomy`. Work only there. Run `npm --prefix
  console ci` first; a fresh worktree has no `node_modules`.
- Live, read-only: `env -u NO_COLOR node console/app.mjs --print 140x45
  --project herdr-brain` (and 100x40, 80x30) shows today's shipped screen.
  `node console/proto/main.mjs --print 140x45` shows the promoted
  design-round prototype on fixture data.
- Data, read-only: `ORG_DIR=/Users/rewt/development/rewt/.org node bin/org.mjs
  today --json` and `status --json`; `node brain/bin/brain.mjs queue --all
  --json`. Never run a command that writes to the organization (`add`,
  `note`, `set`, `answer`, `close`, `start`, `ingest`, `sync`, and brain's
  `send`, `key`, `later`, `never`, `answer`, `start`).
- Do not write anything under `~/.config`, `~/Library`, or outside your
  worktree.

## What to deliver

1. The field notes and your reasoned answers to all six questions, each with
   a clear recommendation.
2. A design document, `docs/design/console-goals-autonomy-2026-09-19.md`: the
   concept you recommend, exact mockups extending the existing cascade at
   80/100/140 columns only where priority or autonomy actually changes what's
   on screen (do not redraw what didn't change), and what changes in the
   keyboard and mouse map, if anything.
3. An extension of the existing prototype (`console/proto/`) that makes your
   recommendation concrete on fixture data, in the same style and test
   discipline as what's already there (`--print WxH`, interactive, `npm
   --prefix console test` and root `npm test` still pass, nothing under
   `console/lib/` changes, no new dependency without saying why it's needed).
4. If your design implies a change to `org`, `lane`, `brain` or `supervisor`
   conventions outside the console itself (a new field, a new note shape, a
   new read-only command), say so as a proposal — do not implement it. This
   round's product is the console's role in this; other layers are the
   operator's call.
5. `docs/reports/console-goals-autonomy.md`, same front matter shape as
   earlier rounds (`run`, `outcome`, `summary`, `headline`, `blockers`,
   `proposals: []`, `learnings`, `artifacts`), your recommendation in five
   sentences, and any question only the operator can answer, each with your
   recommended answer.

## Acceptance

- The design document states your position on all six questions with
  reasoning, not just a verdict.
- The prototype extension runs and demonstrates the recommendation; existing
  behavior from the promoted design (cascade, one-line rows, detail screens,
  global needs-you count) is unchanged.
- `npm test` and `npm --prefix console test` still pass; no organization was
  written to; nothing outside the worktree was touched.
- Nothing here contradicts `docs/north-star.md`; where a tempting design
  would (a control the operator must operate continuously, or a UI that
  requires reading history to trust a decision), the document says so and
  picks the north-star-compatible path instead.
