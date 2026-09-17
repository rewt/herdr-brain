# Waiting on you, made actionable (console 0.0.3)

Date: 2026-09-17, America/Chicago. Status: **drafted from the operator's 0.0.2
review**, decisions recorded below. Extends `spec-brain-console-0.0.2.md`; it
replaces nothing else in it.

## Why

The operator reviewed the 0.0.2 console and said the Waiting on you section has
to be overhauled: *"I don't understand how I'm supposed to take any action on
these items, like licensing and visibility for the five proof note
repositories. What do I do about that? Does that go into the org setup? Is
there a pending session that I need to answer? We need to somehow connect the
waiting on you to actionable items that resolve the item with more than just
approve yes or no. There's a summary that doesn't include anything."*

Every part of that is right, and the cause is not the layout. Measured against
the live bch-cloak organization at 2026-09-17 14:52:

1. **Parked work is shown as urgent.** The open stage is 1 (close the seal
   theft hole). Nine of the ten questions on the operator's screen are marked
   stage 4, the five-repo release — work the operator deliberately deferred on
   2026-09-17. The licensing question is one of them. The top list should have
   held exactly one row: the stage-1 zero-conf gate question.
2. **Questions arrive undecidable.** One of the ten carries a category, a
   recommendation, a memo and a written statement of what happens on yes and on
   no. The other nine carry none of those. The licensing question has a title
   and nothing else — no body text at all — which is why its summary popup is
   empty. There is no correct action the operator can take on it, because
   nobody has worked out what the choices are.
3. **Yes and no are the only verbs.** Four of the ten are not yes/no
   questions. One bundles four separate decisions (protocol slug, gate module
   placement, test suites, development keys) behind a single title; pressing
   `y` records one "yes" against four questions. One is pick-A-or-B where A
   means publishing a file containing an operator home path.

A fourth, smaller cause: every question reports `unblocks_prioritized: 0`, so
the ranking signal is dead and all ten rows look equally urgent.

A fifth cause, raised by the operator on the same review: **going to a session
is a one-way trip.** `Enter` focuses the agent's Herdr tab, and getting back to
the console means finding the workspace tab by hand. The operator wants to
peek at a session, and possibly reply to it, without leaving the console —
"a portal into Herdr". See "Peeking into a session" below; it is possible, and
it also fixes something else that is missing.

## Operator decisions (2026-09-17)

- A question that cannot be acted on is **filed, not refused**. It lands in its
  own group and never counts as waiting on the operator.
- A waiting row offers four verbs: **pick one of N options**, **answer in my
  own words**, **work it up for me**, **show what it's holding up**.
- Looking at a session must not cost the operator their place in the console.

## Readiness: when a question may ask for the operator's time

A question is **ready to decide** only when all of these hold:

| Requirement | Field |
|---|---|
| It has a category the organization approves by | `meta.category`, one of `approvals.categories` |
| It offers a choice | `meta.on_yes` **and** `meta.on_no`, or two or more `meta.option.<n>` |
| Each choice states what it causes | the text after `|` in each option; `on_yes`/`on_no` are that text |
| It says why, in one place the operator can read | a `why` note **or** `meta.memo` pointing at a file that exists |
| It recommends one of its own answers | `meta.recommend` ∈ `{yes, no}` or an option key |
| It asks one thing | see below |

**One thing.** A reason containing more than one `Recommendation:` line, or
more than one `?`, is several decisions in one question. That is not a
heuristic guess: the four-in-one item has two recommendations and four question
marks in its reason, while the one fully worked-up question has one of each.
Such an item is not ready, and its work-up splits it.

`org today --json` reports, per question, `ready: true|false` and `missing: []`
— a list of plain phrases, never codes: `no category`, `no options`,
`no consequences recorded`, `no reason recorded`, `no recommendation`,
`several decisions in one question`, `memo file is missing`.

Nothing is refused. `org ask` accepts a bare title as it does today, prints
what the question is missing, and says it will not appear in Waiting on you
until it has options and a recommendation.

## Stages: the open stage decides what is asked

The stage convention exists in the bch-cloak organization already (`G-1
meta.stage_now` is the open stage; every open item carries `meta.stage`).
0.0.3 teaches the core to read it, so `SETTLE.md` and the console agree.

`.org/config.json` gains an optional block:

```json
"stages": { "open_from": "G-1", "field": "stage_now", "item_field": "stage" }
```

`org today --json` then reports `project.open_stage` and each question's
`stage`. With no `stages` block, `open_stage` is `null`, every `stage` is
`null`, and nothing is filtered — the behaviour of every other organization
does not change.

**Filter order is stage first, then readiness.** A parked stage-4 question must
not demand a work-up session; it is not the operator's problem yet. So today's
screen shows one ready question, no not-ready questions, and one collapsed line
for the nine that wait for stage 4. When the operator opens stage 4, those nine
appear as not-ready and each offers a work-up.

## The core changes

### `org ask`

```
org ask "<question>" --parent ID --category C --recommend yes|no|<n> --why TEXT
        [--option "<label> | <what it causes>"]...   (repeatable, 2..9)
        [--on-yes T] [--on-no T] [--memo PATH] [--blocks ID]... [--priority N]
```

- `--option` is stored as `meta.option.1` … `meta.option.9`, value
  `label | what it causes`, in the order given. Flat keys keep `org set`
  able to edit them.
- `--on-yes`/`--on-no` stay as the two-option shorthand and are unchanged for
  every existing caller.
- `--option` together with `--on-yes`/`--on-no` is refused: pick one shape.
- After filing, `org ask` prints the item id, `ready` or `not ready to decide`,
  and the `missing` list.

### `org answer`

```
org answer <ID> yes|no|<n>|"<text>" [--note WHY] [--overrule]
```

- `<n>` picks `meta.option.<n>`; the recorded answer is the option's label, and
  `answered_as: "option"` with `option: <n>` is recorded alongside it.
- Free text is always accepted, on a ready question and on a not-ready one, and
  records `answered_as: "text"`. This is the operator's escape hatch: they may
  simply know the answer.
- `yes`/`no` on a question that declares options is refused, naming the options.

### `org today --json`

- `waiting` holds only questions that are in the open stage **and** ready.
  Ranked as today, but with the ranking signal repaired: `unblocks_prioritized`
  counts blocked items in the open stage, whatever their own priority.
- `not_ready` is a new array, same fields plus `missing` and `workup`, holding
  open-stage questions that are not ready.
- `later_stages` is a new array, one entry per stage beyond the open one:
  `{ stage, count, titles: [...] }`.
- Every question gains `stage`, `ready`, `missing`, `options`
  (`[{ key, label, causes }]`), `holds_up` (`blocks`, plus each blocked item's
  status and whether it is in the open stage), and `workup`
  (`{ run, since }` or `null`).
- `renderToday` prints the three groups with the same wording as the console.

### Marking a work-up

`meta.workup_run=<R-n>` on the question. While that run is open the question
shows `being worked up · since HH:MM` and offers no answering verbs. When the
run's report lands, the mark is cleared by `org sync` as it records the report.

## The console screen

```text
 bch-cloak   14:52   18/100 sessions   1 waiting   0.0.3                                          ? help
╭ WAITING ON YOU · stage 1 ──────────────────────────────────────────────────────────────────────────────── 1 ╮
 > ! Confirm the zero-conf gate reading: batch B is built only after A settles     design · asked 09:41
       1  yes   one clarifying sentence in the freeze checklist          ← recommended
       2  no    allows batch B on an unconfirmed A, against the spec
     holds up 1 thing in this stage · memo recorded
╭ NOT READY TO DECIDE ───────────────────────────────────────────────────────────────────────────────────── 0 ╮
     nothing
╭ LATER STAGES ──────────────────────────────────────────────────────────────────────────────────────────── 9 ╮
   9 decisions wait for stage 4, the five-repo release                                        / to see them
╭ herdr-org  ~/development/rewt/herdr-org ───────────────────────────────────────────────────────────────── 2 ╮
     …sessions as in 0.0.2…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  1-9 pick  a answer  w work it up  b what it holds up  p not now  Enter peek  g go there  s summary
```

Rules:

- **Waiting on you** shows its stage in the group header when stages are
  configured. A ready question's options are shown **under the row, always**,
  one line each: key, label, what it causes, and `← recommended` on the
  recommended one. The operator can decide without opening anything. At 100
  columns the "what it causes" text is cut at a word boundary; at 80 it moves
  to its own indented line.
- The third line of a ready row says what it holds up and whether a memo
  exists, in words.
- **Not ready to decide** is a group of its own, never counted in the header's
  waiting segment. Each row shows the question, then its `missing` phrases
  joined by `·`, then what it holds up. A question being worked up shows
  `being worked up · since HH:MM` instead of its missing list, and sorts last.
- **Later stages** is one row per stage, collapsed, with the stage number and
  its name from the goal's notes when recorded. `/` scopes to a stage and
  expands it; the rows then behave as not-ready rows.
- Groups with nothing in them are shown with `nothing` rather than hidden, so
  the screen does not jump as items resolve. **Later stages** is hidden
  entirely when no stages are configured.

### Verbs

| Key | On a ready question | On a not-ready question |
|---|---|---|
| `1`–`9` | pick that option, with confirmation | footer: no options recorded yet; `w` has them worked out |
| `y` / `n` | the yes/no case only; footer names the options otherwise | same as above |
| `a` | answer in the operator's own words | answer in the operator's own words |
| `w` | work it up again (confirmation says it is already ready) | work it up |
| `b` | what it holds up, as a popup | same |
| `p` | not now | not now |
| `s`, `Enter`, click | the summary popup | the summary popup |

On a **session** row, in Waiting on you or in its repository group: `Enter` or a
click opens the peek popup, `g` focuses the real Herdr pane, `s` opens the
summary popup as in 0.0.2, `r` replies, `p` dismisses it for the day.

- **Pick an option** confirms in the footer as approve does today, with the
  option's label in the sentence. Picking an option that is not the
  recommended one asks for a reason first, as declining does today.
- **Answer in my own words** suspends the console, opens `$EDITOR` (`$VISUAL`
  first, then `vi`) on a scratch file pre-filled with the question, its options
  and a commented instruction, restores the screen on exit, and records the
  first non-comment block with `org answer <ID> "<text>"`. An empty file
  cancels. Suspend and restore reuse the `o` path, including turning mouse
  reporting off and on.
- **Work it up for me** confirms, then calls
  `contrib/workup-question.mjs` (below) and reports its one-line JSON result in
  the footer, with the same result kinds the launch bar uses. The console never
  runs the steps itself.
- **What it holds up** is a popup listing each blocked item: its plain title,
  its status in words, and `this stage` or `stage N`. It is the answer to "why
  should I care about this one", and it is what tells the operator that one
  question holds up four things while another holds up nothing.
- **Not now** asks for a reason, then records `meta.stage=parked` and a note
  carrying the reason. The row leaves the list.

### The summary popup is never empty

Question tabs become **Decision**, **Memo**, **Holds up**, **Context**.

The **Decision** tab always has content, in this order: the question in full;
who asked it and when (`an engineering session, 14:12` — never a run code); the
options with what each causes, and the recommendation with its reason; what it
holds up. When the question is not ready, the options section is replaced by:

```
Nobody has worked out the choices yet.

  missing: options, what each one causes, a recommendation

Press w and a session will read this item and the work it holds up, come
back with the real choices and what each one costs, and recommend one. It
will not decide it.
```

That paragraph is the answer to the operator's question. **Memo** shows the
file or `no memo recorded`. **Holds up** is the same list as `b`. **Context**
keeps the 0.0.2 content and adds the stage and the work-up run.

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

So there are three answers, and 0.0.3 takes all three. They solve different
halves of the problem.

### 1. The peek popup: don't leave at all

`Enter` on a session row **stops focusing the Herdr tab** and opens a **peek
popup** instead. 0.0.2's behaviour moves to `g` ("go there for real"), which the
footer names.

The peek is a large centred popup — 90% of the screen, since it holds a
terminal's worth of text — showing:

- a one-line head: the session name, who runs it, where, how long, and its
  state in words;
- the session's screen, from `herdr agent read <name> --source recent-unwrapped
  --lines 400`, re-wrapped by the console to the popup's width. `recent-unwrapped`
  and not `visible`, because the agent's pane is a different width than the
  popup and `visible` would arrive pre-wrapped to the wrong one;
- scroll keys, `G` for the end, and the end is where it opens.

`--format text` by default. `--format ansi` is behind `console.json`
`"peek_colour": true`, off by default: the captured output may carry cursor
moves and mouse-mode sequences that would corrupt the console's own screen, so
the ansi path must strip everything except SGR colour before rendering.

The peek refreshes on the console's normal tick while it is open, and keeps the
operator's scroll position unless they are at the end, in which case it follows.

### 2. Replying from the peek, and the sessions that are waiting on you

From inside the peek:

- `r` **reply** — opens the same own-words editor the `a` verb uses, then
  `herdr agent prompt <name> "<text>"`. `prompt` refuses a blocked agent before
  sending anything, so this can never jam a session; the refusal is reported in
  the footer in plain words, with the advice to answer its prompt first.
- On a **blocked** session, the peek shows the choice the session is waiting on,
  read from its own screen, and the keys to answer it: `1`–`9` for a numbered
  choice, `y`, `n`, `esc`, each sent with `herdr agent send-keys`. Sending a key
  into someone else's session is confirmed in the footer first, naming the key
  and the session, because it cannot be taken back.

This is what the operator was asking about when they said *"Is there a pending
session that I need to answer?"* — and it exposes a gap 0.0.2 has:

**Waiting on you means org questions only. It should mean everything waiting on
the operator.** Herdr reports `agent_status` for every session, and two of its
values are the operator's problem:

- `blocked` — the session is stuck at a prompt and cannot move until answered;
- `done` — the session finished its turn and nobody has read the result.

At 2026-09-17 15:45 there were no blocked sessions and **three `done`** ones,
including one with an unsent draft sitting in its prompt box. None of them
appeared in Waiting on you.

So the group gains a second kind of row, above the decisions because a stuck
session is costing time right now:

```text
╭ WAITING ON YOU · stage 1 ──────────────────────────────────────────────────────────────────────────────── 4 ╮
 > ⧗ R-110 superseded-profile review          blocked 12m · asks to run a command   Enter peek · a answer
   ✓ V1 fixture replay after seal v2 switch   finished 2h · nobody has read it       Enter peek
   ✓ REV-49 seal v2 profile id review         finished 1h · nobody has read it       Enter peek
   ! Confirm the zero-conf gate reading: batch B is built only after A settles       design · asked 09:41
       1  yes   one clarifying sentence in the freeze checklist          ← recommended
       2  no    allows batch B on an unconfirmed A, against the spec
     holds up 1 thing in this stage · memo recorded
```

Session rows are ordered `blocked` before `done`, oldest first inside each, and
they are **not** filtered by stage — a stuck session is stuck whatever stage it
belongs to. A `done` session leaves the group once the operator has peeked at
it (recorded per session id in the console's own state file, not in org) or
once the settle watcher records its report. The header's waiting count includes
them. `p` ("not now") on a session row dismisses it from the group for the day
without touching the session.

### 3. Coming back when the operator does go there

The console cannot bring the operator back: once focus leaves its pane it
receives no keys. That return has to come from Herdr, and Herdr has it —
`last_pane`, which its own config calls a global back-and-forth and which is
**unset by default**. The README gains a required setup line:

```toml
# ~/.config/herdr/config.toml
[keys]
last_pane = "prefix+tab"   # console → session → console, one key each way
```

With that bound, `g` and the return are symmetric and the console needs no code
for it.

### 4. The console as a summoned popup (recommended)

Herdr custom commands support `type = "popup"`, *"a session-modal terminal
without changing the tab layout"*. That inverts the operator's problem: the
console stops being a tab to navigate to and from, and becomes a thing summoned
over whatever they are looking at and dismissed back to it.

```toml
[[keys.command]]
key = "prefix+alt+c"
type = "popup"
command = "org console --project bch-cloak"
width = "90%"
height = "90%"
description = "Herdr Brain console"
```

One key opens it anywhere; closing it returns the operator exactly where they
were, layout untouched. This is the recommended way to run the console, and the
README documents it beside the tab method, which keeps working.

It costs one thing: a popup starts a fresh process each time, so a console that
keeps its UI state only in memory forgets the selection, the scope and any
launch-bar draft between summons. **The console therefore persists its own UI
state** — selected row identity, scope, history-or-sessions view, peeked
sessions, and the launch-bar draft — to
`~/.local/state/herdr-org/console-<project>.json`, written on change (debounced)
and read at start. It holds no organizational state; org remains the only record
of anything that matters. A missing or unreadable file is not an error: the
console starts fresh.

### What this is not

Not a terminal emulator. The peek renders a snapshot of text; it does not run
the session's terminal inside the console, and interactive programs in that
pane will not be usable through it. When the operator needs the real thing, `g`
takes them there and `last_pane` brings them back. The console still never
stops, closes or kills an agent.

## `contrib/workup-question.mjs`

Dependency-free, takes `--org <dir> --question <ID> --repo <path> --route
<name> [--dry-run]`, prints one JSON result, and shares the dispatch chain with
`contrib/launch-task.mjs`; whichever is built first extracts
`contrib/lib/dispatch.mjs` and the second one uses it.

It opens a lane named `workup-<id-in-lowercase>`, writes a brief, starts an org
run against the question item, dispatches, records `meta.workup_run`, and arms
the settle watcher. The brief says, in plain words:

1. Read this question, the items it holds up, and any memo or archive document
   it names.
2. Find the real choices. Two or more, each a complete answer to the whole
   question. If the question actually asks several things, file one question
   per decision with `org ask` and close this one as superseded.
3. For each choice, write what it causes, in one sentence the operator can act
   on — not a summary of the code.
4. Recommend one, and say why in a sentence.
5. Write a memo when the reasoning does not fit in a sentence, and point
   `--memo` at it.
6. Set the category from the organization's approval categories.
7. **Do not decide it.** Do not answer the question, and do not start the work
   it holds up.
8. Report as usual; the report's headline says whether the question is now
   ready.

Result kinds follow the launch bar's list: refused before any change, lane
opened but not dispatched, delivery unknown, dispatched but not recorded,
success. No automatic retry.

## Tests

Offline, `node --test`, a failing test first for every behaviour change.

Core:

- a readiness table: one case per missing field, and one fully ready question;
- the one-thing check: two `Recommendation:` lines, or two `?`, is not ready;
  the real four-in-one and fully-worked-up reasons are fixtures;
- `meta.memo` pointing at a missing file is `memo file is missing`;
- stages: open stage 1 with nine stage-4 questions gives `waiting` 1,
  `not_ready` 0, `later_stages` `[{ stage: 4, count: 9 }]`; no `stages` block
  filters nothing;
- `unblocks_prioritized` counts open-stage blocked items regardless of their
  own priority;
- `--option` parsing, order, the 2..9 bound, the `|` split, and the refusal
  when mixed with `--on-yes`;
- `org answer <ID> 3` records the label and the option key; `yes` on an
  option question is refused and names the options; free text records
  `answered_as: "text"` on a ready and on a not-ready question;
- `org sync` clears `meta.workup_run` when the work-up run's report lands.

Console:

- frame tests at 80, 100 and 140 columns for all three groups, including the
  option lines, the cut of "what it causes", and the empty-group `nothing`;
- the not-ready row's missing phrases, and the being-worked-up row sorting
  last;
- the Decision tab has content for a question with nothing but a title, and
  contains the work-up paragraph;
- `1`–`9` on a question with no options warns and changes nothing;
- `y` on an option question warns and names the options;
- a non-recommended pick asks for a reason before confirming;
- the own-words editor path: cancel on an empty file, comments stripped, the
  recorded command, and mouse reporting off then on;
- `w` calls `workup-question.mjs` with an argument array and never runs a step
  itself; one test per result kind against fake `org`, `lane` and `herdr`
  binaries on `PATH`.

The peek and the portal, all against a fake `herdr` on `PATH`:

- the peek calls `agent read` with `recent-unwrapped`, and re-wraps to the
  popup width: a fixture line longer than the popup wraps at a word boundary;
- `Enter` on a session row peeks and does **not** call `agent focus`; `g`
  calls `agent focus` and not `agent read`;
- the peek opens at the end of the output, follows new output while at the end,
  and holds position when scrolled up;
- `peek_colour: false` strips every escape sequence; `true` keeps SGR colour
  and still strips cursor moves and mouse-mode sequences (a fixture carries
  `\x1b[?1000h` and `\x1b[2J`);
- `r` on a blocked session reports the `agent_blocked` refusal in plain words
  and sends nothing;
- `r` on an idle session records the `agent prompt` call with the editor's text;
- a key sent with `send-keys` is confirmed first, and cancelling sends nothing;
- session rows in Waiting on you: `blocked` before `done`, oldest first, not
  filtered by stage, counted in the header, and a peeked `done` session is gone
  from the group on the next tick and stays gone across a restart;
- the UI state file round-trips selection, scope, view, peeked sessions and the
  launch draft; a missing, empty, or malformed file starts the console fresh
  without an error;
- a session that has gone away between the list and the read reports it in the
  footer and closes the peek.

## Acceptance

1. Against the live bch-cloak organization the top list holds only the
   stage-1 question, with its two options and their consequences visible
   without opening anything, and the nine stage-4 questions are one collapsed
   line.
2. Selecting the licensing question and pressing `s` shows a Decision tab that
   states the question, who asked it, what it holds up, exactly what it is
   missing, and how to have it worked up. It is never blank.
3. `w` on it opens a lane, dispatches a session, and the row becomes
   `being worked up`. When that session reports, the question carries options,
   consequences, a recommendation and a category, and appears in the top list
   the next time its stage is open.
4. `a` on any question records the operator's own words as the answer.
5. `b` on the zero-conf question lists the one thing it holds up; on the
   four-in-one it lists four, each with its stage.
6. An organization with no `stages` block behaves exactly as 0.0.2 did, except
   for readiness and the new verbs.
7. `Enter` on a session row shows that session's recent screen inside the
   console, scrollable and following new output, and `Esc` returns to the list
   with the same row selected. The operator never leaves the console.
8. A session sitting at a prompt appears in Waiting on you with the choice it
   is waiting on, and can be answered from the peek. A session that has
   finished a turn nobody has read appears there too, and leaves once peeked.
9. `r` in the peek sends a reply to an idle session; on a blocked session it
   refuses in plain words and sends nothing.
10. With `last_pane` bound, `g` and one keypress return the operator to the
    console; run as a `type = "popup"` custom command, the console opens over
    any pane and closing it restores the layout, with the selection, scope and
    launch draft the operator left behind.
11. The core stays dependency-free, no visible text carries a record code, and
    all tests pass.

## Build order

Four pieces on the same lane, in this order, each landing on its own:

1. **Core** — stages, readiness, options, answers, the repaired ranking. Worth
   landing alone: it stops parked work reaching the operator and shrinks the
   screen to the truth before any new key exists.
2. **The screen** — the three groups, options under the row, the never-empty
   Decision tab, the four verbs, the UI state file.
3. **The peek** — peek popup, session rows in Waiting on you, reply and
   send-keys, `g`, the config lines in the README.
4. **The work-up** — `contrib/workup-question.mjs`.

## Out of scope

- Deciding any of the nine parked questions.
- Changing the stage order or opening stage 4.
- Making `SETTLE.md` require the new fields — a separate change, once `org ask`
  prints what is missing.
- Stopping, closing or killing agents from the console. Replying to one is now
  in scope; ending one is not.
- Running a session's terminal inside the console. The peek is a snapshot of
  text.
