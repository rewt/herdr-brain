# Waiting on you, made actionable (console 0.0.3)

Date: 2026-09-17, America/Chicago. Status: **drafted from the operator's 0.0.2
review**, decisions recorded below. Revision 2, after measuring where the
questions on the operator's screen actually come from. Extends
`spec-brain-console-0.0.2.md`; it replaces nothing else in it.

## Why

The operator reviewed the 0.0.2 console and said the Waiting on you section has
to be overhauled: *"I don't understand how I'm supposed to take any action on
these items, like licensing and visibility for the five proof note
repositories. What do I do about that? Does that go into the org setup? Is
there a pending session that I need to answer? We need to somehow connect the
waiting on you to actionable items that resolve the item with more than just
approve yes or no. There's a summary that doesn't include anything."*

Measured against the live bch-cloak organization on 2026-09-17:

1. **Parked work is shown as urgent.** The open stage is 1 (close the seal
   theft hole). Nine of the ten questions on the operator's screen are marked
   stage 4, the five-repo release — work the operator deliberately deferred.
   The licensing question is one of them. The top list should have held exactly
   one row.
2. **The questions cannot be acted on.** One of the ten carries a category, a
   recommendation, a memo and a written statement of what happens either way.
   The other nine carry none of those. The licensing question has a title and
   nothing else, which is why its summary is empty.
3. **Yes and no are the only verbs.** Four of the ten are not yes/no
   questions. One bundles four separate decisions behind a single title, so
   pressing `y` records one "yes" against four questions.
4. **Going to a session is a one-way trip.** `Enter` focuses the agent's Herdr
   tab and getting back means finding the workspace tab by hand.
5. Every question reports `unblocks_prioritized: 0`, so the ranking signal is
   dead and all ten rows look equally urgent.

## Where the questions come from, measured

This is the cause of 2, and it is not what it looks like. **Nobody files these
questions by hand.** `org ingest` already creates a work item from every
proposal in every report:

```js
for (const p of report.proposals) {
  events.push({ type: 'item.added', id, title: p.title, role: p.role ?? null,
                why: p.why ?? null, from_run: runId, meta: p.extra ?? {} });
}
```

Of the 28 `role: human` items in the org, **22 were born that way**,
automatically, from a session's own report. They carry a title and a `why` and
nothing else — because **the report format has nowhere to put anything else.**
`blockers` is a list of strings; a proposal has `role`, `title`, `why`,
`accept`. There is no field for a category, for the choices, for what each
choice causes, or for a recommendation.

Those fields have to be added afterwards, by hand, with `org set … meta.*`.
That pass has run **once in the org's history**: on HUM-26, four minutes after
ingest created it, `by: human`. That is the only reason HUM-26 is the one
answerable question on the screen.

Meanwhile the information is not missing. It is in the report, as prose. Run
R-111, which finished at 20:37 today, wrote:

- `outcome: needs_human`
- blocker 1: *"Route (B) changes the canonical batch package codec that
  BUILDER-SPEC defines and ENG-77 is blocked on implementing… the operator
  should say go/no-go before ENG-76 and ENG-77 are written against it."*
- blocker 2: *"If the operator prefers to keep the current carrier shape, the
  fallback (B-min) closes 3 of the 4 gap items with one local codec rule each;
  the role-label item would then stay open and must be stated as open at
  freeze, not implied closed."*
- a `role: human` proposal whose `why` begins *"Go/no-go on route (B). ENG-76
  and ENG-77 are both blocked on it, and both are freeze-window…"*

That is a question, two options, what each one causes, a recommendation and
what it holds up — written by the session at the moment it had the whole
problem in its head. It is on the operator's screen under **Finished today**,
labelled "needs a decision", which in 0.0.2 is not even on the main screen.

**So the fix is to give the report format somewhere to say it, and to read
reports as the inbox.** Six reports have said `needs_human`, two of them today.

## Operator decisions (2026-09-17)

- **A decision is not a work item.** A `role: human` proposal no longer becomes
  an item. The report event is the record; the console reads it and renders it
  verbatim. **The operator's answer is the only thing written.**
- **`org ask` is retired.** Everything that needs the operator arrives in a
  report or is a live session stuck at a prompt. One path, no exceptions.
- A question that cannot be acted on is **recorded, not refused**, and never
  counts as waiting on the operator.
- A waiting row offers four verbs: **pick one of N options**, **answer in my
  own words**, **work it up for me**, **show what it's holding up**.
- Looking at a session must not cost the operator their place in the console.

## The report format gains a decision

A proposal with `role: human` becomes a **decision**, and carries what a
decision needs:

```yaml
proposals:
  - role: human
    title: Decide whether the batch package carries a reduced settlement projection
    category: design
    why: |
      Go/no-go on route (B). ENG-76 and ENG-77 are both blocked on it and both
      are inside the freeze window. It does not change settlementProjection32's
      preimage, the relation, or any proof artifact.
    options:
      - answer: reduced
        label: Carry the reduced settlement projection (route B)
        causes: ENG-76 and ENG-77 are written against the new codec, and a codec change lands inside the freeze window.
      - answer: full
        label: Keep the current carrier shape (the B-min fallback)
        causes: Three of the four gap items close with one local codec rule each; the role-label item stays open and must be stated as open at freeze.
    recommend: reduced
    memo: archive/BATCH-PACKAGE-CARRIER-20260917.md
    blocks: [ENG-76, ENG-77]
```

- `options`: two to nine, each with `answer` (a short key), `label`, and
  `causes` — one sentence the operator can act on, not a summary of the code.
- `recommend`: one of the `answer` keys.
- `category`: one of the organization's approval categories.
- `memo`: a path, relative to the repository or absolute.
- `blocks`: item ids the decision holds up. Replaces what `org ask --blocks`
  did.
- `why` or `memo` is required; both is better.
- Yes/no is the two-option case: `answer: yes` and `answer: no`. A proposal
  that gives only `on_yes`/`on_no` strings is read as those two options, so
  every report written before this change still parses.

The old template line `proposals: []  # each entry becomes a new item` becomes
two lines, one for work and one for decisions, and the template shows a
commented decision example.

### `org check` is the readiness gate, at the right moment

`org check` already validates a report and already warns when `needs_human`
has no blockers. It gains, for every `role: human` proposal: `category`,
two or more `options` each with `causes`, `recommend` naming one of them, a
`why` or a `memo` whose file exists, and **one question only** — a `why`
containing more than one `Recommendation:` or more than one `?` is several
decisions and must be split into several proposals. That check is not a guess:
the four-in-one item has two recommendations and four question marks in its
reason, while the one worked-up question has one of each.

These are **errors in `org check`** — the session runs it itself and is right
there with the context — but only **not-ready marks in `org ingest`**, which
records the report regardless. A session that has already stopped must never
lose its report to a validation rule.

### `org ingest` stops creating items for decisions

```
for each proposal:
  role: human  →  no item. It is a decision, carried on the report event.
  otherwise    →  an item, exactly as today.
```

Everything else about ingest is unchanged, including links from blocking work
proposals. The report event already carries every proposal verbatim, so the
decision needs no new storage: it is durable, append-only, and already written.

## The core changes

### `org decisions [--json]`

Pending decisions, newest first. A decision is **pending** when its report has
been ingested and no `decision.made` event names it. Each one reports:

- `id`: `<run>.<n>`, the run and the proposal's position — `R-111.1`;
- `run`, `item`, and the item's `title` and `stage`;
- `title`, `category`, `why`, `memo`, `options`, `recommend`;
- `blocks`: from the proposal, with each item's title, status and stage;
- `ready` and `missing`: the `org check` rules, re-applied at read time, so a
  report written before this change is honestly marked rather than hidden;
- `asked`: the report's ingest time.

Ranked by what they hold up in the open stage, then by the report time.

### `org decide <run>.<n> <answer> [--note WHY] [--overrule]`

The only write. `<answer>` is an option's `answer` key, or free text, which is
always accepted and recorded as `answered_as: "text"`. Records one
`decision.made` event: the decision id, the answer, the note, who answered,
and whether it went against the recommendation. A decision answered against
the recommendation requires `--note`.

`org answer` stays, deprecated, for the 28 legacy `role: human` items. It is
not removed: the ten on the screen today are real and must still be closable.

### `org today --json`

- `waiting` becomes two kinds of row:
  - **decisions**, from `org decisions`, in the open stage and ready;
  - **sessions**, from Herdr: `agent_status: blocked` and `agent_status: done`
    (see "the sessions that are waiting on you" below).
- `not_ready` holds open-stage decisions that are not ready, each with
  `missing`.
- `later_stages`: one entry per stage beyond the open one,
  `{ stage, count, titles }`.
- `legacy_questions`: the surviving `role: human` items, so the existing ten
  stay reachable and answerable while they last.
- `finished` no longer labels a `needs_human` report "needs a decision" and
  leaves it there; its decisions are in `waiting` or `not_ready`, and the
  report row says how many decisions it raised.
- `unblocks_prioritized` counts blocked items **in the open stage**, whatever
  their own priority. This repairs the dead ranking signal.

### Stages

The stage convention already exists in the org (`G-1 meta.stage_now` is open,
each item carries `meta.stage`). 0.0.3 teaches the core to read it, so
`SETTLE.md` and the console agree. `.org/config.json` gains:

```json
"stages": { "open_from": "G-1", "field": "stage_now", "item_field": "stage" }
```

A decision inherits the stage of its run's item. With no `stages` block,
`open_stage` is `null`, nothing is filtered, and every other organization
behaves as before. **Filter order is stage first, then readiness**: a parked
stage-4 decision must not demand a work-up, because it is not the operator's
problem yet.

### What happens to the existing 28

Nothing is migrated. They are real items with real history; nine of the ten
open ones are stage 4 and parked anyway. They appear under
`legacy_questions`, are answerable with `org answer`, and the list drains as
stages open. New decisions arrive only through reports.

## The console screen

```text
 bch-cloak   14:52   18/100 sessions   4 waiting   0.0.3                                           ? help
╭ WAITING ON YOU · stage 1 ──────────────────────────────────────────────────────────────────────────────── 4 ╮
 > ⧗ R-110 superseded-profile review          blocked 12m · asks to run a command    Enter peek · a answer
   ✓ V1 fixture replay after seal v2 switch   finished 2h · nobody has read it        Enter peek
   ✓ REV-49 seal v2 profile id review         finished 1h · nobody has read it        Enter peek
   ! Decide whether the batch package carries a reduced settlement projection  design · from a session 15:37
       1  reduced   ENG-76 and ENG-77 are written against the new codec       ← recommended
       2  full      three of four gaps close; the role-label item stays open
     holds up 2 things in this stage · memo recorded
╭ NOT READY TO DECIDE ───────────────────────────────────────────────────────────────────────────────────── 0 ╮
     nothing
╭ LATER STAGES ──────────────────────────────────────────────────────────────────────────────────────────── 9 ╮
   9 decisions wait for stage 4, the five-repo release                                         / to see them
╭ herdr-org  ~/development/rewt/herdr-org ───────────────────────────────────────────────────────────────── 2 ╮
     …sessions as in 0.0.2…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  1-9 pick  a answer  w work it up  b what it holds up  p not now  Enter peek  g go there  s summary
```

Rules:

- A decision's **options are shown under the row, always**, one line each: the
  key, the label, what it causes, and `← recommended` on one. The operator can
  decide without opening anything. At 100 columns the "causes" text is cut at a
  word boundary; at 80 it moves to its own indented line.
- The third line says what it holds up and whether a memo exists, in words.
- A decision says where it came from in plain words — `from a session 15:37` —
  never a run code. The code lives in the Context tab.
- **Not ready to decide** is its own group, never counted in the header. Each
  row shows its `missing` phrases joined by `·`. A decision being worked up
  shows `being worked up · since HH:MM` and sorts last.
- **Later stages** is one collapsed row per stage. `/` scopes to a stage and
  expands it. Hidden entirely when no stages are configured.
- Empty groups show `nothing` rather than disappearing, so the screen does not
  jump as rows resolve.
- `legacy_questions` in the open stage appear in Waiting on you, marked
  `filed the old way`, with the 0.0.2 approve and decline behaviour.

### Verbs

| Key | On a ready decision | On a not-ready decision |
|---|---|---|
| `1`–`9` | pick that option, with confirmation | footer: no options recorded; `w` has them worked out |
| `y` / `n` | only when the options are yes and no | as above |
| `a` | answer in the operator's own words | answer in the operator's own words |
| `w` | work it up again (confirmation says it is ready) | work it up |
| `b` | what it holds up, as a popup | same |
| `p` | not now | not now |
| `s`, `Enter`, click | the summary popup | the summary popup |

On a **session** row: `Enter` or a click peeks, `g` focuses the real pane, `s`
opens the summary popup, `r` replies, `p` dismisses it for the day.

- **Pick an option** confirms in the footer with the option's label in the
  sentence, then runs `org decide`. Picking an option that is not the
  recommended one asks for a reason first, as declining does today.
- **Answer in my own words** suspends the console, opens `$EDITOR` (`$VISUAL`
  first, then `vi`) on a scratch file pre-filled with the question, its options
  and a commented instruction, restores the screen on exit, and records the
  first non-comment block. An empty file cancels. Suspend and restore reuse the
  `o` path, including turning mouse reporting off and on.
- **Work it up for me** runs `contrib/workup-question.mjs` and reports its
  one-line JSON result in the footer. The console never runs a step itself.
- **What it holds up** lists each blocked item: plain title, status in words,
  and `this stage` or `stage N`. It is what distinguishes the decision holding
  up two freeze-window items from one holding up nothing.
- **Not now** asks for a reason and records a `decision.deferred` event with
  it. The row leaves the list.

### The summary popup is never empty

A decision's tabs are **Decision**, **Memo**, **Holds up**, **Context**.

**Decision** always has content, in this order: the question in full; where it
came from, in words (`an engineering session, 15:37`); the options with what
each causes, and the recommendation with its reason; what it holds up. When the
decision is not ready, the options section is replaced by:

```
Nobody has worked out the choices yet.

  missing: options, what each one causes, a recommendation

Press w and a session will read this, and the work it holds up, and come
back with the real choices and what each one costs, and recommend one. It
will not decide it.
```

**Memo** shows the file or `no memo recorded`. **Holds up** is the same list as
`b`. **Context** keeps the 0.0.2 content and adds the run, the item, the stage
and the report path.

## Peeking into a session, and coming back

Herdr's CLI already carries everything this needs. Verified against the
installed `herdr` on 2026-09-17:

| Command | What it gives the console |
|---|---|
| `herdr agent read <t> --source visible\|recent\|recent-unwrapped --lines N --format text\|ansi` | the session's screen, as text or with colour |
| `herdr agent prompt <t> "<text>" [--wait --until <status>]` | send a message; **refused with `agent_blocked` before anything is sent** if the agent is stuck at a prompt |
| `herdr agent send-keys <t> <key>...` | answer a prompt the session is blocked at (`esc` is the canonical Escape name) |
| `herdr agent wait <t> --until <status>` | refresh when the session changes state |
| `herdr agent focus <t>` / `herdr tab focus <t>` | the one-way trip 0.0.2 already does |

### 1. The peek popup: don't leave at all

`Enter` on a session row **stops focusing the Herdr tab** and opens a **peek
popup**. 0.0.2's behaviour moves to `g`, which the footer names.

The peek is a centred popup at 90% of the screen, since it holds a terminal's
worth of text, showing a one-line head (the session name, who runs it, where,
how long, its state in words) and the session's screen from `herdr agent read
<name> --source recent-unwrapped --lines 400`, re-wrapped by the console to the
popup's width. `recent-unwrapped` and not `visible`, because the agent's pane
is a different width than the popup and `visible` arrives pre-wrapped to the
wrong one. Scroll keys, `G` for the end, and it opens at the end.

`--format text` by default. `--format ansi` is behind `console.json`
`"peek_colour": true`, off by default: captured output may carry cursor moves
and mouse-mode sequences that would corrupt the console's own screen, so the
ansi path must strip everything except SGR colour.

The peek refreshes on the console's normal tick, holding the operator's scroll
position unless they are at the end, in which case it follows.

### 2. Replying, and the sessions that are waiting on you

From inside the peek:

- `r` **reply** — the own-words editor, then `herdr agent prompt <name>
  "<text>"`. `prompt` refuses a blocked agent before sending anything, so this
  can never jam a session; the refusal is reported in plain words with the
  advice to answer its prompt first.
- On a **blocked** session, the peek shows the choice it is waiting on, read
  from its own screen, and the keys to answer: `1`–`9`, `y`, `n`, `esc`, each
  sent with `herdr agent send-keys`. Sending a key into someone else's session
  is confirmed first, naming the key and the session, because it cannot be
  taken back.

This exposes a gap 0.0.2 has. **Waiting on you means org questions only. It
should mean everything waiting on the operator.** Herdr reports
`agent_status` for every session, and two values are the operator's problem:

- `blocked` — stuck at a prompt, going nowhere until answered;
- `done` — finished a turn and nobody has read the result.

At 2026-09-17 15:45 there were no blocked sessions and **three `done`** ones,
one with an unsent draft sitting in its prompt box. None appeared in Waiting on
you.

Session rows sort `blocked` before `done`, oldest first inside each, above the
decisions, because a stuck session costs time right now while a decision waits
patiently. They are **not** filtered by stage: a stuck session is stuck
whatever stage it belongs to. A `done` session leaves the group once the
operator has peeked at it — recorded per session id in the console's own state
file, not in org — or once the settle watcher records its report. The header's
waiting count includes them. `p` dismisses one for the day without touching the
session.

### 3. Coming back when the operator does go there

The console cannot bring the operator back: once focus leaves its pane it
receives no keys. That return has to come from Herdr, and Herdr has it —
`last_pane`, which its own config calls a global back-and-forth and which ships
**unbound**. The README gains a required setup line:

```toml
# ~/.config/herdr/config.toml
[keys]
last_pane = "prefix+tab"   # console → session → console, one key each way
```

### 4. The console as a summoned popup (recommended)

Herdr custom commands support `type = "popup"`, *"a session-modal terminal
without changing the tab layout"*. That inverts the problem: the console stops
being a tab to navigate to and from, and becomes something summoned over
whatever the operator is looking at and dismissed back to it.

```toml
[[keys.command]]
key = "prefix+alt+c"
type = "popup"
command = "org console --project bch-cloak"
width = "90%"
height = "90%"
description = "Herdr Brain console"
```

One key opens it anywhere; closing it restores the layout exactly. This is the
recommended way to run the console, documented in the README beside the tab
method, which keeps working.

It costs one thing: a popup starts a fresh process, so a console holding its UI
state only in memory forgets everything between summons. **The console
persists its own UI state** — selected row identity, scope, view, peeked
sessions, and the launch-bar draft — to
`~/.local/state/herdr-org/console-<project>.json`, written on change
(debounced) and read at start. It holds no organizational state. A missing or
unreadable file is not an error: the console starts fresh.

### What this is not

Not a terminal emulator. The peek renders a snapshot of text; interactive
programs in that pane will not be usable through it. When the operator needs
the real thing, `g` goes and `last_pane` returns. The console still never
stops, closes or kills an agent.

## `contrib/workup-question.mjs`

With `org ask` retired, this is the **front door for anything nobody has
studied yet**, not a repair tool. A question can now only exist because a
session did the work to ask it — so when the operator (or a chat) notices
something that needs deciding, the answer is not to file a question, it is to
dispatch a study that will report one.

Dependency-free, takes `--org <dir> --question <run>.<n>|--about "<text>"
--repo <path> --route <name> [--dry-run]`, prints one JSON result, and shares
the dispatch chain with `contrib/launch-task.mjs`; whichever is built first
extracts `contrib/lib/dispatch.mjs`.

It opens a lane, writes a brief, starts an org run, dispatches, records
`meta.workup_of` on the run, and arms the settle watcher. The brief says, in
plain words:

1. Read this decision, the work it holds up, and any memo or document it names.
   With `--about`, read the topic and the repository instead.
2. Find the real choices: two or more, each a complete answer to the whole
   question. If it asks several things, write one `role: human` proposal per
   decision.
3. For each choice write `causes`: one sentence the operator can act on.
4. `recommend` one, and say why in the `why`.
5. Write a memo when the reasoning does not fit, and point `memo` at it.
6. Set `category` from the organization's approval categories.
7. **Do not decide it.** Do not answer, and do not start the work it holds up.
8. Run `org check` on the report before finishing; it must pass.

Result kinds follow the launch bar's list: refused before any change, lane
opened but not dispatched, delivery unknown, dispatched but not recorded,
success. No automatic retry.

### The licensing question, as an example

It has a title and nothing else because no session ever studied those five
repositories — it was filed by hand, the one path that produces empty
questions, and that path is now closed. Under 0.0.3 it is not a question at
all: it is `w` on a topic, which dispatches a study, which reports the real
licensing choices and what each one costs. The operator then decides in one
keypress.

## Tests

Offline, `node --test`, a failing test first for every behaviour change.

Report format and the core:

- a `role: human` proposal with `options`, `recommend`, `category`, `memo` and
  `blocks` round-trips through `org check` and `org ingest`;
- `org ingest` creates **no item** for a `role: human` proposal and still
  creates items, and links, for every other proposal;
- `org check` errors, one case per rule: no category, fewer than two options,
  an option with no `causes`, `recommend` naming nothing, no `why` and no
  memo, a memo whose file is missing, and the one-question rule — with the real
  four-in-one and worked-up reasons as fixtures;
- `org ingest` records a report that `org check` rejects, and marks the
  decision not ready rather than refusing the report;
- an old report with `on_yes`/`on_no` and no `options` is read as two options;
- `org decisions` lists pending ones only, excludes answered and deferred, and
  ranks by open-stage blocked items;
- `org decide` records the answer, an option key and free text, refuses an
  unknown key, and requires `--note` against the recommendation;
- stages: open stage 1 with nine stage-4 decisions gives `waiting` 1,
  `not_ready` 0, `later_stages` `[{ stage: 4, count: 9 }]`; no `stages` block
  filters nothing;
- `legacy_questions` holds the surviving items and `org answer` still closes
  them.

Console, with a fake `herdr` and fake `org` on `PATH`:

- frame tests at 80, 100 and 140 columns for all groups, the option lines, the
  cut of `causes`, and the empty-group `nothing`;
- session rows: `blocked` before `done`, oldest first, above decisions, not
  stage-filtered, counted in the header; a peeked `done` session is gone on the
  next tick and stays gone across a restart;
- the not-ready row's missing phrases, and the being-worked-up row last;
- the Decision tab has content for a decision with nothing but a title, and
  carries the work-up paragraph;
- `1`–`9` with no options warns and changes nothing; `y` when the options are
  not yes/no warns and names them; a non-recommended pick asks for a reason;
- the own-words editor: cancel on empty, comments stripped, the recorded
  command, mouse reporting off then on;
- the peek calls `agent read` with `recent-unwrapped` and re-wraps to the popup
  width; `Enter` peeks and never calls `agent focus`; `g` focuses and never
  reads;
- the peek opens at the end, follows while at the end, holds position when
  scrolled up;
- `peek_colour: false` strips every escape; `true` keeps SGR and still strips
  cursor moves and mouse-mode sequences (a fixture carries `\x1b[?1000h` and
  `\x1b[2J`);
- `r` on a blocked session reports the refusal and sends nothing; on an idle
  one it records the `agent prompt` call; a `send-keys` key is confirmed first
  and cancelling sends nothing;
- the UI state file round-trips; missing, empty or malformed starts fresh
  without an error;
- a session that disappears between the list and the read is reported in the
  footer and the peek closes;
- `w` calls `workup-question.mjs` with an argument array, one test per result
  kind.

## Acceptance

1. A session that finishes with a decision in its report appears in Waiting on
   you, with its options and what each causes visible without opening anything,
   and no item is created for it anywhere.
2. Answering it writes exactly one event, and it leaves the list; the decision
   and its reason are in today's history, and it never returns.
3. Against the live bch-cloak org the top list holds only stage-1 rows, and the
   nine stage-4 questions are one collapsed line.
4. `org check` refuses a report whose human proposal has no options, and names
   what is missing; `org ingest` records that same report anyway and marks the
   decision not ready.
5. Selecting a not-ready decision and pressing `s` shows a Decision tab that
   states the question, where it came from, what it holds up, what is missing,
   and how to have it worked up. It is never blank.
6. `w` dispatches a study; when that session reports, the decision carries
   options, consequences, a recommendation and a category, and is answerable in
   one keypress.
7. `a` records the operator's own words. `b` lists what a decision holds up.
8. `Enter` on a session row shows that session's screen inside the console,
   scrollable and following, and `Esc` returns with the same row selected.
9. A session at a prompt appears in Waiting on you and can be answered from the
   peek; a session that finished a turn nobody read appears there and leaves
   once peeked.
10. With `last_pane` bound, `g` and one keypress return to the console; run as
    a `type = "popup"` command, the console opens over any pane and closing it
    restores the layout, with the selection, scope and draft intact.
11. The ten questions filed the old way are still answerable.
12. The core stays dependency-free, no visible text carries a record code, and
    all tests pass.

## Build order

Four pieces on the same lane, each landing on its own:

1. **The report decision and the core** — the format, `org check`,
   `org ingest` no longer making items, `org decisions`, `org decide`, stages,
   the repaired ranking. Worth landing alone: it turns six reports' worth of
   real decisions into a readable list and shrinks the screen to the truth
   before any new key exists.
2. **The screen** — the groups, options under the row, the never-empty
   Decision tab, the four verbs, the UI state file.
3. **The peek** — peek popup, session rows, reply and send-keys, `g`, the two
   config lines in the README.
4. **The work-up** — `contrib/workup-question.mjs`.

## Out of scope

- Deciding any of the nine parked questions.
- Changing the stage order or opening stage 4.
- Migrating the 28 existing human items.
- Removing `org answer`.
- Stopping, closing or killing agents from the console. Replying is in scope;
  ending one is not.
- Running a session's terminal inside the console.

## What this deletes

Worth stating, because the first revision of this spec was longer:

- `org ask`, and the SETTLE.md rule that told settle sessions to use it.
- The separate `org set … meta.*` enrichment pass that has run once.
- The readiness gate as a console concern. It moves into `org check`, where
  the session that knows the answer is still running.
- 22 items' worth of clutter per the same period, and the depth-budget warnings
  they caused: `org today` currently reports 20-odd items over their depth
  budget, and decisions parented under work are part of that.
