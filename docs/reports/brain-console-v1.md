---
run: R-1
outcome: done
summary: |
  Built everything in docs/spec-brain-console-v1.md from "The screen" through "Acceptance",
  except Cutover. The org core gained org ask, org answer (a "no" keeps the blocked work
  blocked), approval categories and policy, note --summary, report headline and
  org today [--json]. settle-watch now passes ORG_ACTOR. The console/ package is an Ink app
  over pure, tested modules, launched by org console, with contrib/console-pane.sh. README and
  AGENTS.md are updated. npm test went from 13 to 52 passing (51 plus 1 skipped without the
  console dependencies); npm --prefix console test passes 20. Ten negative controls each failed
  the suite. A manual smoke in a real pty against a temporary copy of the bastian org answered
  two questions there. Ready for review; nothing was pushed and no live organization was written.
headline: The Brain console is built and ready for review. It shows what is waiting on you and records your yes or no.
blockers: []
proposals:
  - role: reviewer
    title: Independent review of Herdr Brain console v1 (lane/brain-console-v1)
    why: The brief stops at ready for review; an independent reviewer and the operator decide on the cutover.
  - role: engineer
    title: Keep agent decision notes from burying Running and Session notes in the console
    why: On the pilot day, Decided today has 157 rows (most without a plain summary), so at 100x30 Running, Finished and Session notes are only reachable by scrolling. Grouping notes per item or collapsing notes without a summary would fix it.
  - role: engineer
    title: Check session-note lookup against one real Claude transcript
    why: The agent-name entry shape and the project-directory slug were taken from the spec and verified only against fixtures, because live transcripts were off limits. Needs an operator-approved read of one transcript.
learnings:
  - "Claude names a project directory by replacing every non-alphanumeric character of the cwd with '-' (this worktree's .worktrees became -worktrees), not only '/'. The console tries both forms."
  - Every pilot-org event before this change reads by=human, so today's pilot agent decisions show as "you" in the console. Only sessions opened after the settle-watch ORG_ACTOR change are told apart.
  - "Root node --test also discovers console/test/*.test.mjs. Those tests import only pure modules, so root npm test passes without console dependencies (the one launch test that needs Ink skips itself)."
  - A pty driver must waitpid in a loop after the child closes the pty. A single WNOHANG check races and misreports a cleanly exited console as still running.
  - The pilot's open role=human items have no category or recommendation (the console shows "no recommendation"). Cutover step 4 is needed before the console is useful for them.
artifacts:
  - "branch lane/brain-console-v1: 1832679 b92fc62 3bf7c95 551889c 4ecc91f defb30c 1816600 a784ab9 884cbe9 ba955b1 (plus the report commit)"
  - lib/today.mjs, lib/state.mjs (isDeclined, releases), lib/report.mjs (headline), bin/org.mjs (ask, answer, today, console)
  - contrib/settle-watch.mjs (ORG_ACTOR), contrib/console-pane.sh
  - console/app.mjs, console/lib/{model,frame,controller,sources,markdown,text,session,cli,config}.mjs, console/package-lock.json
  - test/approvals.test.mjs, test/today.test.mjs, test/settle-watch.test.mjs, test/console-pane.test.mjs, test/console-launch.test.mjs, console/test/model.test.mjs, console/test/session.test.mjs
  - "npm test; npm --prefix console ci && npm --prefix console test; node console/app.mjs --config FILE --print 100x30"
---

# Herdr Brain console v1: report

## What I built

**Org core** (still dependency-free; status still derived; older folds ignore every new field):

- `org ask "<question>" --parent --category --recommend --why [--on-yes --on-no --memo --blocks… --priority]`
  records a `role=human` item, a `why` note and its blocking links in one transaction.
  - It refuses a missing recommendation, an unknown category (and lists the known ones), a
    missing memo file and unknown IDs.
  - With an `auto` category it answers at once (`answered_by=auto`, the asking session as actor).
- `org answer <ID> yes|no|text [--note] [--overrule]` records a decision note, then
  `meta.answer`/`answered_by`, then closes the question.
  - `isDeclined()`/`releases()` in `lib/state.mjs` keep a question answered "no" unresolved for
    its dependents. `org status` shows `declined: <question>`, and `org unblock` releases them.
  - A second answer needs `--overrule`, which records `overruled=true`.
- `config.json` `approvals` (all eleven categories `ask`, merged over defaults).
- `org note --decision --summary`.
- Report `headline:` in the template, parsed as optional, warned about when missing (never an error).
  `renderBrief` asks for it.
- `org today [--json]` (`lib/today.mjs`): the read model in the spec, with the local day taken
  from `TZ`, a transitive `unblocks_prioritized`, approval counts and attention. Its schema is in
  README.
- `org console [--project]` spawns `console/app.mjs`, or says to run `npm --prefix console ci`.

**settle-watch** passes `ORG_ACTOR=<session name>` in the tab env of every session it opens.

**console/** (Ink 6.8.0 and React 19.3.0 pinned, lockfile committed; `npm ci` verified):

- Pure modules:
  - `model` (rows, plain-language fallbacks, stable order, selection by identity, Summary and
    Context content);
  - `frame` (the whole screen as lines; width and height budgets);
  - `controller` (keys as a reducer that returns effects);
  - `sources` (ledger, transcript lookup with an mtime cache, `herdr agent list` parsing);
  - `markdown` (built-in renderer);
  - `text` (cell width, wrap, code stripping).
- Impure modules:
  - `session` (refresh loop: `fs.watch` debounced, plus the interval; keeps the last good data;
    effects);
  - `cli` (org and herdr via `execFile` argument arrays; `ORG_ACTOR` removed);
  - `config` (writes an example on first run and refuses to run until the example flag is removed).
- `app.mjs` only draws the frame's lines with Ink.
  - It uses the alternate screen.
  - `NO_COLOR` drops color and inverse.
  - `o` suspends Ink for `$VISUAL`/`$EDITOR` and remounts.
  - `--print COLSxROWS` renders one frame as text.

**contrib/console-pane.sh [project]** finds the workspace whose canonical checkout is the
project's `cwd`. It opens an unfocused tab labelled `console` there and runs `org console`, unless
that workspace already has a console tab.

**Docs:** README covers everything listed in acceptance 7, and AGENTS.md carries the amendment
word for word.

## Tests

- **Before:** `npm test` passed 13 of 13.
- **After:** `npm test` passes 52 of 52 with the console dependencies installed. With
  `console/node_modules` moved away it passes 51 and skips 1 (the launch test that needs Ink);
  `org console` then prints the install hint.
- **Console only:** `npm --prefix console test` passes 20 of 20.
- **New core tests:** ask validation; yes, no and text answers; a declined answer keeps work
  blocked until unblock; auto policy and overrule; note summary; headline and its warning;
  `org today` sections, TZ day boundaries, determinism and transitive ranking; the frozen c6d7c4d
  fold (`test/fixtures/state-v0.mjs`) reading the new events; the settle-watch dry run with a fake
  Herdr; console-pane with a fake Herdr; the launcher.
- **New console tests:**
  - row building and fallbacks (ID and hash stripping, `· no plain summary`), ranking, and
    selection and order across refreshes;
  - 80/100/140 budgets for every tab, expanded or not;
  - no codes outside Context;
  - fixture transcripts (two config dirs, tool_use blocks, a sidechain entry, a torn last line)
    and the mtime cache;
  - ledger, Herdr and document-path parsing; markdown;
  - key rules: y confirm, n reason, Esc never quits, q only from the list;
  - an end-to-end session against a real temporary org: approve, decline with a reason, a
    declined dependent stays blocked, answers are recorded as `human` even with `ORG_ACTOR` set,
    a CLI refusal changes nothing, a gone agent is refused, Herdr is unavailable, and a failed read
    keeps the last data with its age.
- **Failing first:** the core tests, the settle-watch test, the console-pane test and the launcher
  override test all failed before their code existed. Most console model tests were written
  alongside the new modules, so the negative controls below stand in for "failed first" there.
  Three console fixes were test-first:
  - the reader-title off-by-one (controlled by reverting it);
  - leftover "(, …)" after stripping;
  - footer key priority.
  Two further fixes had a failing test first as well: executive sessions from other projects, and
  the doubled "??" in the prompt.

## Negative controls

Each mutation was applied alone and `npm test` was run (the script is in the session scratchpad).
Every one failed the suite:

| Mutation | Failing tests |
|---|---|
| a declined question releases its work | 3 |
| `org ask` accepts no recommendation | 1 |
| `y` records without confirmation | 2 |
| `n` accepts an empty reason | 2 |
| Escape quits | 1 |
| console passes `ORG_ACTOR` on | 1 |
| codes not stripped | 2 |
| rows reorder on refresh | 1 |
| settle-watch drops `ORG_ACTOR` | 1 |
| `org today` uses the UTC day | 2 |

After each mutation the tree was restored, and the suite then passed 52 of 52.

## Manual smoke (temporary org copy only)

- **Setup:** `cp -R /Users/rewt/development/bastian/.org` into the session scratchpad (667
  events). A scratch `console.json` (via `--config`) pointed `ledger_dir` and
  `claude_config_dirs` at fixture copies; no live transcripts were read. `herdr agent list` was
  read live (read-only).
- **Driver:** a Python pty at 100×30 ran the real Ink app.
- **Answers recorded in the copy:**
  - Selected the 11th question, pressed `y` and saw the prompt "Approve: …", then pressed Enter.
    The copy recorded HUM-3 `answer=yes, answered_by=human`, and the status line said
    "Recorded yes for …".
  - Pressed `n`, then Enter with no reason, and got "A reason is required". Typed "Not now",
    pressed Enter twice, and the copy recorded HUM-9 `answer=no` with the note.
  - Both answers appeared under Decided today on the next frame.
- **Key behaviour:** `q` in the reader says "q quits from the list; press Esc first", and `?`
  shows the help.
- **Opening documents:** End selected the last session note. `2` rendered it, and Enter/Esc
  expanded and shrank the reader. `o` with `EDITOR=<logging script>` suspended Ink, ran the editor
  on a temp .md of the note and remounted (alternate screen entered twice). `j` then `q` quit with
  exit 0.
- **Sizes and color:** 80×24 with `NO_COLOR=1` emitted 0 color or inverse sequences and exit 0.
  140×40 exit 0. The terminal was restored each time.
- **Document tab:** it rendered all four kinds.
  - A memo: I added HUM-14 with `--memo` to the copy, because the pilot's questions have none.
  - A report: the R-27 report, with its front matter as key/value lines.
  - A brief: the R-33 brief, at 80×24 (below).
  - A session note: the fixture note, with a markdown heading and a list.

Capture at 100×30 (29 lines; the app leaves one row free so Ink never clears the screen),
against the copy, with the added question selected:

```text
bch-cloak (copy) · 18:32 · 2/30 sessions today · 35 alerts                                    ? help
WAITING ON YOU (10)
  D1: where the package-retention obligation binds for the… no category            no recommendation
  Decide whether label-derived synthetic witness material…  no category            no recommendation
> Adopt the theft fix once its review passes?               design                    recommend: yes
  Decide whether to re-title freeze criterion 8 now that O… no category            no recommendation
  Decide the five-repo placement questions the release map… no category            no recommendation
  Authorize L3 execution: M4 funding br… · no plain summary no category            no recommendation
  backup question: may the two v2 pk.bi… · no plain summary no category            no recommendation
  Decide whether the v1/v1dev key-era refs stay COMPLETED…  no category            no recommendation
  Licensing and visibility for the five Proofnote reposito… no category            no recommendation
  Decide handling of seal cells under t… · no plain summary no category            no recommendation
DECIDED TODAY (157)
  Decide handling of the exposed v0-lin… · no plain summary no category              18:24  no · you
  Authorize one memory-gated aggregate… · no plain summary  no category             18:24  yes · you
  settle-r-27: blocked by (matchers fir… · no plain summary decision                      17:50  you
  settle-r-27: now also blocked by (the… · no plain summary decision                      17:50  you
  settle-r-27: blocked by — it edits FR… · no plain summary decision                      17:50  you
↓ settle-r-27: dispatch now on lane sou… · no plain summary decision                      17:50  you
─ Adopt the theft fix once its review passes? ───────────────────── [1 Summary] 2 Document 3 Context
  Adopt the theft fix once its review passes?
  Recommend: yes. O1 is the only option where the network itself refuses the theft. The independent
  review passed at 16:28.
  On yes: Implementation and its review start.
  On no: The fix path stops and the freeze stays blocked.
  Unblocks: Successor v1 freeze (tasks 9.1-9.3).
  Category: design. Asked at 18:30.

y approve   n decline   o open   Tab reader   ? help   q quit   Enter expand   1-3 tabs   p project
```

80×24, a running review selected, Document tab (its brief):

```text
bch-cloak (copy) · 18:31 · 2/30 sessions today · 35 alerts                ? help
↑ Settle decision (continue… · no plain summary decision              13:02  you
  Settle decision (continue… · no plain summary decision              13:02  you
  Context: the only unexecu… · no plain summary decision              13:02  you
  Context: L3 needs an M4 f… · no plain summary decision              13:02  you
  Context: verified that th… · no plain summary decision              13:02  you
  Stored as role=human (was… · no plain summary decision              13:02  you
  Settle decision (continue… · no plain summary decision              13:02  you
  Settle decision: no promo… · no plain summary decision              13:00  you
  Settle decision: freeze a… · no plain summary decision              12:50  you
  Settle decision: nothing… · no plain summary  decision              12:50  you
RUNNING (7)
> Independent review of lan… · no plain summary review        since 17:40 · done
─ Independent review of lane/success… ─ 1-7/121 1 Summary [2 Document] 3 Context
  BRIEF: RUN R-33 ON REV-18
  You are a fresh session. What earlier sessions established is summarized below
  and recorded in the organization; you do not need any earlier conversation. Do
  the work, then write one report when you stop.

  WORK ITEM
  • REV-18 Independent review of lane/successor-wording-family

f go to agent   o open   Tab reader   ? help   q quit   Enter expand   1-3 tabs
```

## Deviations from the spec, and why

1. **Markdown:** a small built-in renderer (headings, lists, emphasis, quotes, code, tables with a
   narrow fallback, front matter) instead of marked or marked-terminal. The spec allows this as the
   fallback. ANSI output from marked-terminal would break the cell-width budgets and NO_COLOR, and
   a built-in renderer keeps the model tests dependency-free.
2. **`org ask` requires `--parent` and `--why`.** The spec's synopsis does not bracket them.
   `org answer` refuses items that are not `role=human` and refuses a second answer without
   `--overrule`. `--overrule` works on any answered question; the console offers it only for
   answers the operator did not give.
3. **Code stripping** applies to every visible list and Summary text (question, run and report
   titles too), not only decision notes, so acceptance 4 holds for pilot titles like
   "(ENG-6)". The Document tab shows source files verbatim, codes included.
   - A hash is 7+ hex characters containing at least one digit and one a–f letter, so words like
     "defaced" and long decimal numbers survive.
   - A clipped headline keeps its `· no plain summary` mark.
4. **Transcript lookup:**
   - Both the spec's slug and Claude's actual slug are tried.
   - Only transcripts modified since local midnight are read.
   - Sidechain (subagent) messages are ignored.
5. **Stable order:** rows already on screen keep their relative order across refreshes, and new
   rows take their natural place. `r` re-ranks.
6. **Running:** lists only `settle-/exec-/plan-/audit-` agents whose Herdr cwd is inside the
   project's `cwd`. Without this filter, other projects' sessions appeared.
7. **Header:** says "no session ledger configured" when `ledger_dir` is absent, instead of
   "0/30".
8. **Example config:** JSON has no comments, so the example carries a `"//"` array and
   `"example": true`. The console refuses to run until that line is deleted.
9. **Additions for testing and captures:** `--print` and `--config`, and the environment overrides
   `HERDR_ORG_CONSOLE_CONFIG`, `HERDR_ORG_CONSOLE_DIR` and `HERDR_ORG_BIN`. `org today --json`
   also carries a few extra fields: `status`, `seq`, `kind`, the `why`/`memo`/`blocks` of decided
   questions, `events` and `day.tz`.
10. **`org today` text form:** record titles that contain codes (many pilot titles do) are printed
    as recorded. Only the codes the view adds are confined to the trailing parentheses.

## Not verified

- **`contrib/console-pane.sh`:** tested only against a fake `herdr`. Running it for real opens a
  tab in the live Herdr, which is a cutover step.
- **`f` (focus):** exercised with stubs only; a real `herdr agent focus` would move the
  operator's focus.
- **The `open` fallback** (macOS `open` when neither `$VISUAL` nor `$EDITOR` is set) was not run.
- **Real Claude transcripts:** the `agent-name`/`agentName` entry shape comes from the spec; see
  the proposal.
- **Live resizing** of a running console was not driven. Each size was checked in a separate
  run, and the frame is recomputed on the terminal's resize event.
- **Pilot misattribution:** pilot-day decisions display as "you" because the pilot recorded
  everything as `human` (see learnings).

Cutover was not done, as the brief asked. No live organization, `~/.config`, Claude settings or
anything outside the worktree was written. Nothing was pushed.
