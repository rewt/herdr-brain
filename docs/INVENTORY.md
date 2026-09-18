# Inventory of the nine design documents

Written 2026-09-18, as a reconciliation pass, not a decision. It grounds every
claim in a file and line. Where something could not be verified it says
"unverified" rather than guessing. It proposes nothing about which document
should win.

## 1. One-line summary per document

| Document | What it actually is |
|---|---|
| `docs/pilot-M1.md` | The test plan for the first dogfood of the `org` command-line tool: where to put its data, what to measure, when to stop. |
| `docs/north-star.md` | The standing statement of intent: replace an all-day supervisor conversation with durable records plus short-lived reasoning sessions. No build details. |
| `docs/pilot-M1-results-2026-09-16.md` | What actually happened on the first full day of running that way: routing work between sessions worked and was cheap; everything else the supervisor used to do still happened in one long, expensive chat. |
| `docs/design-M2-supervisor-homes.md` | A proposal for where those other supervisor jobs (handling problems, planning, showing the operator what's going on, quality checks) should live instead of that chat — mostly a background watcher process plus short sessions it opens. Not built. |
| `docs/spec-brain-console-v1.md` | The first concrete spec for a terminal screen (built with the Ink library) where the operator approves or declines agents' questions. Approved, then built, then the operator tried it and rejected it the same day. |
| `docs/spec-brain-console-0.0.2.md` | A full redo of that screen's look and layout after the v1 rejection: sessions grouped by which code repository they're in, plus a bar for typing up new tasks. |
| `docs/spec-waiting-on-you-0.0.3.md` | A rework of just the "waiting on you" part of the 0.0.2 screen, after the operator found it showed low-priority questions as urgent and unanswerable ones with no way to act on them. Moves decisions out of the item-tracking system and into the session reports that raise them. |
| `docs/spec-brain-0.1.0.md` | The newest and largest document: a full re-architecture, not just a screen change. Renames the whole effort "Herdr Brain," makes one file describe a project, proposes one background watcher process per project, and reorganizes the screen around progress toward a goal instead of around repositories. Nothing in it is built. |
| `docs/reports/brain-0.1.0-evaluation.md` | The measurement session's write-up that argues for the 0.1.0 spec: it measured the live operation on 2026-09-17 and found the operator couldn't tell what was happening and that coordination now cost more than the chat it was meant to replace. |

## 2. Chronology

All nine files live under one git history; `git log --oneline -- docs/` (and, for
the newest, `docs/reports/`) gives the order. The first three documents were all
added in one commit (`17839da`, "Add org M1, the settle watcher, and the first
pilot's results," Sep 16 14:58) even though `pilot-M1.md` and `north-star.md`
carry an internal date of Sep 15 — the tool had no commits yet on Sep 15
(`pilot-M1.md:62-63` says so about itself).

| Date (as written) | Document | What changed |
|---|---|---|
| Sep 15 | `pilot-M1.md` | Sets up the dogfood test. |
| Sep 15 | `north-star.md` | States the goal and coins "Herdr Brain" as an architecture (durable state + short sessions), not a tool. |
| Sep 16 | `pilot-M1-results-2026-09-16.md` | Reports the pilot: transitions between sessions worked; four other jobs still lived in one 99M-token chat. |
| Sep 16 | `design-M2-supervisor-homes.md` | Proposes homes for those four jobs: a zero-inference loop plus short triggered sessions. Ends with operator decisions that put the console first and the loop second. |
| Sep 16 (same day) | `spec-brain-console-v1.md` | First console spec: five-section list, a reader pane, `org ask`/`org answer`. Approved, built, rejected by the operator the same day. |
| Sep 16 (same day) | `spec-brain-console-0.0.2.md` | States plainly that v1 "was tried by the operator and is not usable" (`spec-brain-console-0.0.2.md:5-6`). Replaces the whole screen. |
| Sep 17 | `spec-waiting-on-you-0.0.3.md` | Measures 0.0.2 against the live organization, finds "Waiting on you" nearly useless, retires `org ask`, moves decisions into report data. |
| Sep 17 | `spec-brain-0.1.0.md` | **The pivot.** Renamed from "console" to "Herdr Brain," and reframed from "a screen bolted onto scripts" to one project file, one loop, one read model, one panel (`spec-brain-0.1.0.md:1,8-11,20-26`). It explicitly says what it absorbs, supersedes, and drops (§14). |
| Sep 17 (same commit) | `reports/brain-0.1.0-evaluation.md` | The measurement session behind that pivot: found the operator's own unsent answer stuck in a dialog box, and coordination costing 4× the chat it replaced. |

The Sep 17 pivot is real and is squarely `spec-brain-0.1.0.md`. It replaces
"the console" as a standalone approval UI riding on ad hoc watcher scripts with
"the brain" as the whole system — project file, loop, read model and panel
together — and it names, section by section (§14), exactly which earlier
decisions survive, are superseded, or are dropped.

## 3. Contradictions

Not resolved here, only quoted.

**A. Is a decision an org item, or never one?**
- `spec-brain-console-v1.md:145,157,159`: "An approval question is a
  `role=human` item with structured metadata... `org ask` does the
  following... adds the item (`role=human`)..."
- `spec-waiting-on-you-0.0.3.md:88-92`: "A decision is not a work item. A
  `role: human` proposal no longer becomes an item... `org ask` is retired."

**B. Does the console ever write into or message an agent's session?**
- `spec-brain-console-v1.md:119-120`: "The console never starts, stops or
  messages agents; its only action on agents is focusing a tab."
- `spec-waiting-on-you-0.0.3.md:386-391`: "`r` **reply** — the own-words
  editor, then `herdr agent prompt <name> "<text>"`... On a **blocked**
  session, the peek shows the choice it is waiting on... and the keys to
  answer... each sent with `herdr agent send-keys`."

**C. Is the screen organized by repository, or by goal and stage?**
- `spec-brain-console-0.0.2.md:103-107`: "**Sessions**, one group per
  repository, with the repository name and its path... in the group header."
- `spec-brain-0.1.0.md:233-234`: "The **screen changes**: it is organized by
  what the project is trying to do, not by repository."

**D. Is the daily session cap a brake, or only an alert?**
- `design-M2-supervisor-homes.md:120-121`: "The daily cap stays at 12 (the
  operator's choice), with **reservations**: one slot for plan and one for
  audit."
- `spec-brain-0.1.0.md:130-132`: "The daily session **cap as a brake**. It
  stopped work on day one at 14:33 and was raised from 12 to 30 to 100 within
  a day; a brake that is raised whenever it fires is not a brake. It becomes
  an alert."

**E. Does the console read Claude transcripts for session notes?**
- `spec-brain-console-v1.md:84`: "Session notes | Each executive session that
  ran today, with the plain first line of its final message | ledger + Claude
  transcripts"
- `spec-brain-0.1.0.md:138-139`: "The console reading Claude transcripts for
  **session notes**. [deleted] The model name lookup (WHO) stays, bounded to
  one file per named agent as it is now."

**F. Is a project one shared record spanning several repositories, or one
record per repository checkout?**
- `pilot-M1.md:74-76`: "It is also the placement the tool is actually for:
  goals that span `herdr-lanes`, `coach` and `herdr-org` rather than **eleven
  per-project ledgers**." (argues for one `.org` at the workspace root, shared)
- `spec-brain-0.1.0.md:15` and `:56` (§2.2, "A project is one file," heading at
  line 66): "A **project** is a repository checkout that has an `.org`." /
  "**project** | a repository checkout with an `.org` | `.org/project.json`"
  (defines the org as belonging to one repository)

## 4. Spec vs. reality

Checked against `bin/org.mjs`, `lib/*.mjs`, `contrib/*.mjs`, `package.json`,
`test/` on `main` (HEAD `feaa888`), and against the separate, unmerged branch
`lane/brain-console-v1`, which is where any console code actually lives.

**The core CLI (`bin/org.mjs:556-559`) has not changed since the very first
commit.** `git log --oneline -- bin/org.mjs lib/` shows exactly one commit,
`17839da`. Its command table is `init, add, block, unblock, note, set, close,
reopen, start, check, ingest, sync, abandon, brief, status, snapshot, show,
log` — that's all of it.

| Spec claim | Where claimed | Status | Evidence |
|---|---|---|---|
| `org ask` / `org answer` commands | `spec-brain-console-v1.md:149-181` | **Does not exist** | absent from `bin/org.mjs:556-559`'s command table |
| `org decide` / `org decisions` commands | `spec-waiting-on-you-0.0.3.md:186-211` | **Does not exist** | same table |
| `org accept`, explicit acceptance / `awaiting_review` status | `design-M2-supervisor-homes.md:140`; `spec-brain-0.1.0.md:537-544` | **Does not exist** | no match for "acceptance" or "awaiting_review" anywhere in `lib/state.mjs` or `lib/store.mjs` |
| `org alert`, `org clear`, `org direct` | `design-M2-supervisor-homes.md:136`; `spec-brain-0.1.0.md:487-491` | **Does not exist** | absent from command table |
| `org today [--json]`, the one read model every spec depends on | all four console specs | **Does not exist on `main`.** Exists only on the unmerged `lane/brain-console-v1` branch as `lib/today.mjs` (referenced by that branch's `test/today.test.mjs` and by review file `.lane/reviews/brain-console-v1/d682e4c-r5.md`) | `main` has only `org status`, `snapshot`, `show`, `log` (`bin/org.mjs:497-554`) |
| Report gains `headline`, and a `role: human` proposal gains `options`/`causes`/`recommend`/`category`/`memo`/`blocks` | `spec-brain-console-v1.md:236-240`; `spec-waiting-on-you-0.0.3.md:104-136` | **Does not exist.** The parser's recognized proposal keys are `title, name, role, capability, why, reason, rationale, accept, acceptance, blocking` (`lib/report.mjs:121`); anything else, including these fields, is silently bucketed into an unread `extra` object (`lib/report.mjs:145`) | confirmed by reading `normalizeProposal` |
| "`org ingest` stops creating items for decisions" (0.0.3's central change, said to "survive" in 0.1.0 §14) | `spec-waiting-on-you-0.0.3.md:172-182`; `spec-brain-0.1.0.md:734` | **Does not exist; contradicted by running code.** `bin/org.mjs:372-382` creates a work item for *every* proposal in a report, with no special case for `role: human` | read directly in `ingestFile` |
| Stages, `meta.stage`, `org today` fields `ladder`/`path` | `spec-waiting-on-you-0.0.3.md:230-244`; `spec-brain-0.1.0.md §3` | **Partially exists**, and only as a bolt-on. `contrib/org-map.mjs` (real, on `main`, `bf03886`/`afdaae6`) computes an equivalent "ladder" and open-stage view — but entirely outside the core, by shelling out to `org status --json` and `herdr agent list`. `org start` does not know about stages and cannot refuse dispatch outside the open one; there is no `org today` to carry these fields | `contrib/org-map.mjs:37-167` |
| That same stage/decision script still reads decisions as `role=human` **items** with `meta.category`/`meta.recommend`/`meta.on_yes` | — | **Internally stale.** `contrib/org-map.mjs:161-166` implements the *v1/0.0.2* decision model, which `spec-waiting-on-you-0.0.3.md` (the very spec it cites in its own header comment, line 10) declared obsolete five commits earlier | `contrib/org-map.mjs:10,161-166` |
| The Ink terminal console itself (all four console specs) | — | **Does not exist on `main` at all** — not even as an untracked directory (`find . -iname console` returns nothing). **Exists only on the unmerged `lane/brain-console-v1` branch**, at `console/package.json` version `"0.0.2"`, implementing the repository-grouped 0.0.2a screen (`console/lib/repos.mjs` groups by git repo). Its last independent review, `.lane/reviews/brain-console-v1/d682e4c-r5.md`, passed round 4 of the **0.0.2a** correction cycle on Sep 16 21:49. Six further commits (Sep 17 19:15–21:32) add pieces of 0.0.3 (a "work queue," a peek popup) and one piece of 0.1.0 (a loop-alive indicator) with **no review on record** for any of them. `spec-brain-0.1.0.md:811-813` itself notes the lane is "31 commits ahead and 8 behind" `main` and needs a rebase | `git ls-tree lane/brain-console-v1`, `git log lane/brain-console-v1`, `.lane/reviews/brain-console-v1/*.md` |
| `contrib/loop.mjs`, the one zero-inference watcher process (M2 and 0.1.0 §7) | `design-M2-supervisor-homes.md §"Shared machinery"`; `spec-brain-0.1.0.md §7` | **Does not exist anywhere** — absent from `contrib/` on both `main` and the lane branch | directory listing of both |
| `contrib/lib/dispatch.mjs`, `contrib/lib/launch.mjs`, `contrib/workup-question.mjs`, `contrib/launch-task.mjs` | `spec-waiting-on-you-0.0.3.md §5 pieces`; `spec-brain-0.1.0.md §7,§9` | **Do not exist anywhere** | same |
| `.org/project.json`, the "one file" a project is | `spec-brain-0.1.0.md §2.2` | **Does not exist** — no such file, no reader for it | `find` and code search, both empty |
| `ORG_ACTOR` session-identity support | `design-M2-supervisor-homes.md:92-96`; `spec-brain-0.1.0.md:533-536` (both frame this as work to build) | **Already exists in the core**, unchanged since M1 — `mutate()` already reads `process.env.ORG_ACTOR \|\| 'human'` | `bin/org.mjs:90`. What is actually missing is a caller setting it: `contrib/settle-watch.mjs` never sets `ORG_ACTOR` when it launches a session (no match in that file) |
| "The loop... after start verifies the account" (proposed as new, `spec-brain-0.1.0.md:479-485`) | — | **Overlaps existing code.** `contrib/settle-watch.mjs:221-229,297,312-319` already checks for `CLAUDE_CONFIG_DIR`/`AI_PERSONA` and refuses to start on an unresolved account | read directly |

## 5. Reference graph

Verified with `grep` across `docs/`, `.lane/`, and `contrib/`.

- `pilot-M1.md` — referenced by nothing else in `docs/`. An orphan; superseded in practice by the results document, never linked forward.
- `north-star.md` — read-first pointer from `pilot-M1-results-2026-09-16.md:3`, `design-M2-supervisor-homes.md:4`, and `pilot-M1-results-2026-09-16.md:132` (as part of a "disposable brain" cold start).
- `pilot-M1-results-2026-09-16.md` — referenced by `design-M2-supervisor-homes.md:4` and by its own forward pointer from `north-star.md:159`.
- `design-M2-supervisor-homes.md` — referenced by `pilot-M1-results-2026-09-16.md:119`, by `spec-brain-console-v1.md:5,417`, and by `spec-brain-0.1.0.md:9,747` (which tables out what survives from it). **Confirmed, not just by other docs**: `.lane/supervisor/SETTLE.md` implements none of M2's loop/alert machinery — that document is still the pre-M2, watcher-and-chat protocol.
- `spec-brain-console-v1.md` — referenced by `spec-brain-console-0.0.2.md:5` (as the version it replaces), by `docs/briefs/BRIEF-brain-console-v1-20260916.md:9`, and by `.lane/supervisor/SETTLE.md:23` (as a placeholder example, not a live pointer). **Also the only spec actually pointed at by code that ran**: the built lane is literally named `brain-console-v1` and its brief names this spec.
- `spec-brain-console-0.0.2.md` — referenced by `spec-waiting-on-you-0.0.3.md:7,604`, and by `spec-brain-0.1.0.md:760`.
- `spec-waiting-on-you-0.0.3.md` — referenced by `spec-brain-0.1.0.md:8,730`, and by `contrib/org-map.mjs:10` (the one place a running script, not another document, points at a spec — though as noted in §4, that script implements an older data model than the spec it cites).
- `spec-brain-0.1.0.md` — referenced by nothing except `docs/reports/brain-0.1.0-evaluation.md:64` (the report that argues for it). No other document, and no code anywhere, points at it.
- `docs/reports/brain-0.1.0-evaluation.md` — referenced by `spec-brain-0.1.0.md:6` (mutual pointer: spec says "read the evaluation for why," evaluation says "the spec this report produced is...").

**The one document actually wired into a running process** is
`spec-brain-console-v1.md`, indirectly, via the lane name and its brief — and
even that lane has drifted onto later, unreviewed work that no single spec
describes. Every other document is pointed at only by other documents.
