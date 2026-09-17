# Herdr Brain console v1: spec

Date: 2026-09-16, America/Chicago. Status: **approved by the operator for
implementation.** Read `north-star.md`, `pilot-M1-results-2026-09-16.md` and
`design-M2-supervisor-homes.md` for background. This spec replaces the
`org today` / `org decide` parts of the M2 design.

## Why

The operator can't see inside the operation today:

- They never see the instruction files agents start from.
- The reasons behind decisions are split between terse org notes full of codes
  and memo files buried in a 5,000-file archive.
- Session summaries scroll past in terminal tabs and are lost when the tabs
  close.

They can't open markdown files comfortably next to the Herdr console. They
don't read item codes such as `HUM-5`, `ENG-7` or `R-12`, or commit hashes, and
they don't have time to decode dense reports.

The operator wants to **approve every decision at first**. Later they will
relax the approval requirement by category, once the record shows the agents
decide well.

The console is a terminal app built with Ink. It runs in a Herdr pane next to
the agents, costs no model tokens, and answers four questions:

1. What is waiting on me?
2. What did the agents decide, and why?
3. What is running, and what finished?
4. Where can I read the whole thing?

It is the first visible piece of Herdr Brain.

## The screen

```text
bch-cloak · 17:12 · 22/30 sessions today · 1 alert                    ? help
WAITING ON YOU (3)
> Adopt the theft fix once its review passes?        design   recommend: yes
  Fund one Chipnet test transaction (≤3,000 sats)?   funds    recommend: yes
  Install storage tool v0.3 now?                     tooling  recommend: yes
DECIDED TODAY (9)
  16:10  Leave the 13 exposed test cells alone until the fix lands     agent
  16:09  Skip the theft proof run: an hour of heavy memory, no change   agent
RUNNING (3)
  Independent review of the theft fix          review    since 16:05  working
  Five-repository release map                  design    since 16:06  working
FINISHED TODAY (11)
  Storage-tool design review: needs work       16:14
SESSION NOTES (6)
  16:11  Recorded 3 results, started 2 tasks, wrote 8 memos
─ Adopt the theft fix once its review passes? ──── [1 Summary] 2 Document 3 Context
  Recommend: yes. O1 is the only option where the network itself refuses the
  theft. The independent review passed at 16:28.
  On yes: implementation and its review start. On no: the fix path stops and
  the freeze stays blocked.
  Unblocks: implementation of the fix, its review, the Chipnet relay test.
  y approve   n decline   o open memo   f go to agent   Tab reader   q quit
```

The screen has three parts:

- **A list** in five sections, in the order above. Each row is one plain line:
  a headline, then a short category or role, time and state. No IDs.
- **A reader pane** below the list for the selected row, with three tabs:
  - **Summary:** the plain explanation, the recommendation, and what happens on
    yes or no.
  - **Document:** the memo, report, brief or session summary, rendered from
    markdown so it is easy to read. It scrolls.
  - **Context:** IDs, file paths, run and agent names, timestamps, and what the
    item blocks or is blocked by. This is the only place codes appear.
- **A footer** showing the keys that work for the selected row.

Section contents:

| Section | Rows | Source |
|---|---|---|
| Waiting on you | Open approval questions (`role=human` items that aren't closed), ranked by how much prioritized work each one blocks, then by priority | org |
| Decided today | Questions answered today, whether by the operator or automatically under a relaxed category, plus agents' own decision notes from today | org |
| Running | Open runs (with their agent's live Herdr state) and live executive sessions (`settle-*`, `exec-*`, `plan-*`, `audit-*`) | org + `herdr agent list` |
| Finished today | Reports recorded today, headline first; plus items closed today | org |
| Session notes | Each executive session that ran today, with the plain first line of its final message | ledger + Claude transcripts |

Rules carried over from the herdr-lanes console design
(`herdr-lanes/docs/design/CONSOLE-UX.md`, copied to `docs/reference/herdr-lanes/`); read its sections on state,
density, width and keys:

- **Layout:** fit 80, 100 and 140 columns without horizontal scrolling. Show a
  resize hint below 80×20.
- **Selection:** it follows the row's identity, not its position, and rows
  never reorder under the cursor when data refreshes.
- **Color is never the only signal:** every state is also written as text, and
  `NO_COLOR` turns color off entirely.
- **Honest data:** a missing value says "not recorded" or "unknown", never a
  guess.
- **Keys:** text inputs own all typing. Escape closes the innermost thing and
  never quits; `q` quits only from the list.

### Keys

| Key | Action |
|---|---|
| ↑/↓, j/k, PgUp/PgDn, Home/End | Move within the list |
| Tab | Switch focus between the list and the reader; the reader scrolls with the same keys |
| 1 / 2 / 3 | Reader tab: Summary, Document, Context |
| Enter | Expand the reader to full height (toggle) |
| `y` | Approve the selected question. Two steps: the footer shows "Approve: <headline>? Enter to confirm, Esc to cancel". Nothing happens without Enter |
| `n` | Decline or overrule. Asks for a short reason (required, one line), then confirms |
| `o` | Open the selected document outside the console with `$VISUAL`, `$EDITOR` or macOS `open -t` (always a text editor, never the file's own app). Suspend Ink and restore it cleanly afterwards |
| `f` | Focus the agent's Herdr tab (`herdr agent focus <name>`). Refuse visibly if the agent is gone |
| `p` | Switch project when more than one is configured |
| `r` | Reload now |
| `?` | Help |
| `q` | Quit |

Approving or declining only records the answer. The next executive pass acts
on it. The console never starts, stops or messages agents; its only action on
agents is focusing a tab.

## Plain language

The console shows the operator's language, not the record's codes:

- **Question rows** use the item title, written as a plain yes/no question.
- **Decision rows** use the note's `summary` if present. Otherwise they use
  the note's first sentence with IDs and 7+ hex runs stripped, followed by
  `· no plain summary`, so the missing summary is visible.
- **Finished rows** use the report's `headline` if present. Otherwise they use
  the item title plus the outcome in words ("finished", "blocked", "needs a
  decision", "failed").
- **Running rows** use the item title and the role in words ("engineering",
  "review", "design", "research").
- **Session notes** use the first line of the session's final message.

## Records: org core additions

All additions follow `AGENTS.md`: status is derived, older folds ignore
unknown events, the core never calls a model, and nothing refuses work except
to keep the record consistent. The CLI stays dependency-free.

### Approval questions

An approval question is a `role=human` item with structured metadata. Using an
item keeps the dependency graph: the work a question blocks waits, and
unrelated work keeps moving.

```sh
org ask "<plain yes/no question>" --parent <ID> --category <category> \
    --recommend "<yes|no|short answer>" --why "<two plain sentences>" \
    [--on-yes "<what happens>"] [--on-no "<what happens>"] \
    [--memo <path>] [--blocks <ID>]... [--priority N]
# prints the new ID
```

`org ask` does the following in one transaction:

- adds the item (`role=human`), with `meta.category`, `meta.recommend`,
  `meta.memo`, `meta.on_yes` and `meta.on_no`;
- records a note holding `--why`;
- adds a blocking link for each `--blocks`.

Rules for arguments:

- The category must be one of the configured categories.
- `--memo` must point to an existing file.
- A missing `--recommend` is an error. The operator is never handed an open
  question.

```sh
org answer <ID> yes|no|"<text>" [--note "<why>"] [--overrule]
```

`org answer` does the following in one transaction:

- records a decision note (actor as usual; the operator's shell is `human`);
- stores the answer in `meta.answer`, plus `meta.answered_by`;
- closes the item as done.

Answer semantics:

- **A `no` must not release the work it blocked.** In `itemStatus`, a blocker
  closed with `meta.answer` equal to `no` counts as unresolved. Its dependents
  stay `blocked` with the reason `declined: <question>`, until an executive
  re-plans and removes the link (`org unblock`).
- **A text answer** releases the dependents, as `yes` does.
- **`--overrule`** is for a question that was answered automatically. It
  reopens and re-answers the question, and records `meta.overruled=true`.

### Categories and approval policy

`config.json` gains:

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

Each category is `ask` or `auto`. With `auto`, `org ask` immediately answers
the question with its recommendation, with the asking session as actor and
`meta.answered_by=auto`. The question appears under Decided today, where the
operator can still overrule it.

- **v1 ships the mechanism with every category set to `ask`.** The operator
  relaxes categories later by editing this file.
- **Unknown categories:** `org` refuses them, and lists the known ones.
- **Missing config:** use the defaults above.

Category meanings, so agents choose consistently. Use `other` sparingly.

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
| other | Anything else that needs the operator |

### Plain summaries and headlines

- **Decision notes:** `org note <ID> <text> --decision --summary "<one plain
  sentence>"` stores `summary` on the note event.
- **Reports:** the template gains `headline:` (one plain sentence for the
  operator), placed after `summary:`. `readReport` keeps it as an optional
  string field. `org check` warns when it is missing, and never errors.
- **Briefs:** `renderBrief` asks the worker for the headline in the "When you
  stop" section.

### Session identity

`contrib/settle-watch.mjs` passes `ORG_ACTOR=<session name>` to every session
it opens. Without this, org can't tell the operator's answers from a
session's (all 258 non-report events in the pilot org read `human`).

### `org today --json`: the read model

`org today --json` is the console's only view of org. It is deterministic
given (events, config, now), and any other front end (web, phone) can reuse
it. The document contains:

- **`project`:** org dir, `as_of`, and the local day boundaries used.
- **`waiting`:** one entry per open question, with `id`, `title`, `category`,
  `recommend`, `why`, `on_yes`, `on_no`, `memo`, `priority`,
  `created {at, by}`, `blocks` (IDs plus titles), and `unblocks_prioritized`,
  a count derived transitively over unresolved prioritized items.
- **`decided`:** entries for questions answered today (`answer`,
  `answered_by`, `overruled`, `note`) and for decision notes from today (`id`,
  `summary`, `text`, `at`, `by`), newest first.
- **`running`:** open runs, with `run`, `item`, `title`, `role`, `started`,
  `agent`, `lane`, `brief_path` and `report_path`.
- **`finished`:** reports ingested today (`run`, `item`, `title`, `outcome`,
  `headline`, `summary`, `report_file`), plus items closed today, newest first.
- **`approvals`:** the effective policy, and per-category counts over all
  answered questions:
  - `answered`
  - `answered_as_recommended`
  - `overruled`
  - `auto`
- **`attention`:** the existing advisory list.

`org today` without `--json` prints a compact text form of the same sections
(one line per entry, no IDs except in parentheses at the end). Live Herdr
state and session notes are **not** part of `org today`, because the core
never talks to Herdr. The console adds them.

## The console app

Location and packaging mirror herdr-lanes `board/`:

- `console/` is an isolated package with its own `package.json`: `ink`,
  `react`, and a terminal markdown renderer, for example `marked` with
  `marked-terminal`. If that doesn't work, write a small built-in renderer for
  headings, lists, emphasis, code blocks and tables. Pin versions and commit
  the lockfile.
- `console/app.mjs` is the Ink entry point. Keep logic in pure modules that
  tests can import without Ink:
  - a model that builds rows from `today`, Herdr and session data;
  - layout and width budgets;
  - the markdown-to-lines adapter behind an interface.
- `org console [--project NAME]` spawns `node console/app.mjs`. If the console
  dependencies aren't installed, it says how to install them
  (`npm --prefix console ci`). The core `bin/org.mjs` itself gains no
  dependency.
- `AGENTS.md` amendment, approved by the operator on 2026-09-16: "`console/`
  may depend on Ink, React and a markdown renderer. The core stays
  dependency-free. The console writes only through the `org` CLI (child
  process, argument arrays) and never appends to `events.jsonl` itself."

Configuration lives in `~/.config/herdr-org/console.json`. The console creates
a commented example on first run if the file is missing, and exits with
instructions.

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

Data acquisition:

- **org:** run `org today --json` with `ORG_DIR` set. Re-run it when
  `events.jsonl` changes (`fs.watch`, debounced) and every `refresh_seconds`
  as a fallback. Keep the last good document if a read fails, and show its age
  in the header.
- **Herdr:** run `herdr agent list` (JSON) on the same cadence. Join agents to
  runs by `run.meta.agent`, and list executive sessions by name prefix. If
  Herdr is unavailable, show "Herdr unavailable" in the header and keep org
  data.
- **Session notes:**
  1. Read today's ledger, `sessions-YYYY-MM-DD.log`. Its lines look like
     `HH:MM:SS name mode subject`.
  2. For each session name, find the transcript: a `*.jsonl` under
     `<config dir>/projects/<slug of cwd>/` that contains an `agent-name` entry
     whose `agentName` equals the name. The slug is the cwd with `/` replaced
     by `-`. Check every configured config dir, because Herdr currently starts
     sessions under `~/.claude`.
  3. The session note is the text of the **last assistant message**: join its
     `text` content blocks and ignore tool calls. Cache per file by modified
     time. Read only the files that are needed.
- **Session count:** the header shows today's ledger line count against
  `session_cap`, and whether the `STOP` file exists in `ledger_dir`.
- **Document paths:**
  - questions: `meta.memo`;
  - finished rows: the stored report copy in `.org/reports/`;
  - running rows: `brief_path`;
  - decision notes: the first absolute `.md` path in the note text;
  - session notes: the note itself.

  A missing file shows "file not found: <path>" in the Document tab.
- **Writes:** `org answer` only, through `execFile` with an argument array,
  `ORG_DIR` set and `ORG_ACTOR` unset (the operator). After a write, re-read
  immediately. On failure, show the CLI's error and change nothing locally.

## Tests

Tests run offline with `node --test`. Root `npm test` must keep passing
without the console dependencies installed.

- **Core tests (`test/`):**
  - `org ask` validation;
  - `org answer` yes, no and text;
  - a declined blocker keeps its dependents blocked, and `org unblock`
    releases them;
  - auto policy and overrule;
  - the note `summary` field;
  - the report `headline` field and its missing-headline warning;
  - `org today --json` sections, day boundaries (`ORG_NOW`, `TZ`) and
    transitive `unblocks_prioritized`;
  - older folds ignore the new fields.
- **Console model tests:** these import only pure modules. Put them under
  `console/test/`, runnable with `npm --prefix console test`, or in root
  `test/` if they need no dependencies. They cover:
  - row building and plain-language fallbacks (ID and hash stripping, the
    `· no plain summary` marker);
  - ranking;
  - selection kept by identity across refreshes;
  - width budgets at 80, 100 and 140 columns;
  - transcript lookup and last-message extraction, using fixture JSONL with
    `agent-name` entries and tool-use blocks;
  - ledger parsing;
  - document path resolution.
- **Every behavior change:** a test observed failing first.
- **Manual smoke:** run the console against a **temporary copy** of a real org
  (`cp -R`) and answer one question there. Never answer questions in a live
  org during development.

## Acceptance

1. All five sections and the three reader tabs work at 80×24, 100×30 and
   140×40. `NO_COLOR` works.
2. A memo, a report, a brief and a session note each render readably in the
   Document tab, and `o` opens the file outside the console with a clean
   return.
3. `y` and `n` need confirmation. `n` needs a reason. The answer appears
   under Decided today within one refresh, and a declined question keeps its
   dependents blocked.
4. No IDs or hashes appear outside the Context tab, except where the source
   record has no plain text. That case is marked `· no plain summary`.
5. `org today --json` is deterministic for a fixed `ORG_NOW`, and its schema
   is documented in `README.md`.
6. The core stays dependency-free, `npm test` passes, and the console model
   tests pass.
7. `README.md` documents: install, `org console`, console configuration,
   keys, `org ask`, `org answer`, categories and policy, and `headline` and
   `summary`.
8. `contrib/console-pane.sh [project]` opens a Herdr tab labelled `console`
   running `org console` in the project's workspace, without stealing focus.

## Out of scope for v1

- Launching tasks from the console (the herdr-lanes composer).
- The full herdr-lanes session board (`board-frame`), which comes later as the
  detail view for Running.
- The 24/7 loop, alerts, and plan and audit sessions (`design-M2-supervisor-homes.md`).
- Evaluating Beads as the state backend. Keeping `org today --json` as the only
  read seam is what makes that swap possible later.
- Web and phone views. The phone reaches sessions through Claude Remote
  Control, which is now on for every session.

## Cutover (after acceptance; the operator or an executive session does this, not the engineer)

First update every `org` on PATH (and every checkout an agent runs it from)
to this version before the first question is answered `no`. An older `org`
treats a question answered `no` as resolved and releases the work it blocked.

1. Run `npm --prefix console ci`, write `~/.config/herdr-org/console.json`,
   and run `contrib/console-pane.sh bch-cloak`.
2. Set `approvals` in `bastian/.org/config.json` (all categories `ask`).
3. Replace the operator section of `bch-cloak/.lane/supervisor/SETTLE.md`
   (§3), so every decision outside the orchestrator's own list becomes an
   approval question:

   > **Everything else is a question for the operator.** Research it first (the
   > code, the evidence, the roadmap in §1.5, history) and write a memo,
   > `archive/DECISION-<TOPIC>-<YYYYMMDD>.md`. Then run
   > `org ask "<plain yes/no question>" --parent <ID> --category <category> --recommend <answer> --why "<two plain sentences>" --on-yes … --on-no … --memo <path> --blocks <each item that must wait>`.
   > Never hand over an open question or a list of options. Keep all other
   > work moving. When a question is answered `no`, re-plan the work it
   > blocked, then `org unblock` it. Record your own decisions with
   > `org note <ID> --decision --summary "<one plain sentence>" "<detail>"`.
   > Every task brief starts with one plain sentence saying what the agent is
   > asked to do and why.

4. Convert the open `role=human` items in bch-cloak so they carry
   `meta.category` and `meta.recommend`. One executive pass can do this.
5. Relaxing later: set a category to `auto` in `config.json` once its
   `answered_as_recommended` count shows the agents decide well. That is an
   operator decision.
