---
run: R-26
outcome: done
headline: Keep our own record for work items and make it portable through an export and an MCP server; no existing tracker or standard holds what our cycle needs, and moving bch-cloak onto Beads would lose about a quarter of its blocking links.
summary: |
  Recommendation: keep the event-log record as the source of truth and get portability from
  interfaces instead of the storage format: a versioned export (Beads JSONL first, since its
  importer took herdr-brain's and bch-cloak's records in this trial) and a thin MCP server over the
  org CLI. Borrow vocabulary where a real standard exists (OpenTelemetry gen_ai.* names for run
  metadata). Do not migrate bch-cloak. Confidence: high (about 85%) that adopting a tracker format
  is wrong for now; medium on the order of the two follow-ons.

  Why: there is no de facto standard to be portable to. Beads is the closest match and holds items,
  dependencies, ready work, runs (as a custom type with metadata), questions and decisions. On a
  copy of bch-cloak's record it dropped 308 of 1,157 blocking links while reporting a successful import, because it treats
  parent-child as a dependency edge and refuses links that run up or down a branch. It stores
  status, so the 441 items whose status our record derives from reports and runs come out wrong
  unless every writer is rewritten to set status. Its "ready" also differs by design: goals show up
  as ready work, and children of a blocked parent are held back. Backlog.md drops unknown
  front-matter fields the first time its CLI edits a task, accepts one ID prefix per project, and
  its ready list ignores status. MCP Tasks, checked against the 2026-07-28 spec and the ext-tasks
  repository, is an async handle for one tools/call and not a work item. The restructure does not
  depend on this choice, because the console and bch-cloak's kit reach the record only through the
  org CLI.
blockers: []
proposals:
  - role: engineer
    title: "Add a versioned export of the record: org export --format beads (JSONL) plus a documented neutral JSON snapshot, with runs, reports, questions and decisions carried in metadata"
    why: Portability by interface. The trial converter (/private/tmp/arch-11-trial/convert/to-beads.mjs, about 60 lines) already round-trips into bd 1.3.1; making it a supported command lets any Herdr user view or leave with their work without changing our storage.
  - role: architect
    title: Design a thin MCP server over the org CLI (ready work, show, add, ask, answer, check a report; the snapshot as a resource), outside the dependency-free core
    why: Agents on harnesses without a shell wrapper could then read and write the record. Keep it out of the core so the core stays dependency-free and never runs in the background. MCP Tasks only fits long-running calls such as dispatch, not the item model.
learnings:
  - "MCP Tasks moved out of core into the official extension io.modelcontextprotocol/tasks in spec 2026-07-28 (changelog item 6, SEP-2663). It applies to tools/call only, removes tasks/list, and the spec calls a task an asynchronous task handle for one request. There is no title, dependency, priority or assignee field."
  - "Beads 1.3.1 (npm @beads/bd, now gastownhall/beads) is Dolt-only: a 144 MB Go binary with an embedded engine. bd import accepts arbitrary metadata and mixed ID prefixes; types.custom adds types (run, question); metadata survives bd update; 8 concurrent creates all landed."
  - "Beads limits titles to 500 bytes, not characters; 9 bch-cloak titles exceed it. An imported row with no priority becomes P0, the highest."
  - "Beads treats parent-child as a dependency in the same graph. A blocking link from a child to its own parent (bch-cloak has 196 of them) is refused as a cycle and dropped; the import still reports success (it printed a 'Skipped dependency … would create a cycle' line, and I kept only the last line of its output)."
  - Backlog.md 1.53.0 drops unknown front-matter fields when its CLI edits a task, ignores task files whose ID prefix is not the configured one, treats the last configured status as the only completed one, and its --ready list includes tasks in any other status.
  - "There is no de facto standard for agent work items. Beads JSONL has ports and viewers (beads_rust, bv, ralph-tui), but it is one project's format. OpenTelemetry gen_ai.* (Development stability) is the only multi-vendor standard that touches runs: gen_ai.request.model, gen_ai.agent.name, and gen_ai.request.reasoning.level is pending."
  - "The console reads the record only through `org today --json` and `org status --json` (console/lib/cli.mjs). bch-cloak's supervisor kit calls the org CLI about 30 times in 12 files; only apply-settle.sh and tidy-tabs.sh mention events.jsonl directly."
artifacts:
  - /private/tmp/arch-11-trial/ (copies herdr-org and bch-org of both records; originals only read)
  - /private/tmp/arch-11-trial/tools (npm install @beads/bd@1.3.1 backlog.md@1.53.0, local only; HOME=/private/tmp/arch-11-trial/home for every run)
  - /private/tmp/arch-11-trial/convert/to-beads.mjs and to-backlog.mjs (converters from our fold)
  - /private/tmp/arch-11-trial/beads-herdr, beads-bch (stored status from closes only), beads-bch2 (derived statuses stored)
  - /private/tmp/arch-11-trial/backlog-herdr, backlog-bch-1
  - /private/tmp/arch-11-trial/convert/*-ready.txt (ready sets compared with comm)
  - "commands: bd init --non-interactive --stealth --skip-agents; bd import; bd ready --json/--explain; bd export; backlog init/task create/edit/list --ready --json; backlog mcp start with initialize + tools/list"
  - "spec read: raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/changelog.mdx; ext-tasks specification/2026-07-28/tasks.md; schema/2025-11-25 and 2026-07-28; A2A v1.0.1 specification"
  - "files read: docs/north-star.md, docs/roadmap.md, lib/state.mjs, lib/report.mjs, console/lib/cli.mjs, bch-cloak .lane/supervisor/*.sh (grep only)"
decisions:
  - decision: Trial Beads and Backlog.md hands-on and cover the rest (Task Master, git-bug, GitHub Issues, Linear, Taskwarrior, todo.txt, A2A, OpenTelemetry, Spec Kit tasks.md) from their docs
    why: The brief named those two, and none of the others is both local and agent-native without a sign-up (Linear and GitHub are SaaS). Task Master went quiet in April 2026 and carries a Commons Clause licence.
  - decision: Model runs as child issues of a custom type "run", with harness, model, effort and the parsed report in metadata; questions as a custom type "question" with category labels; decisions and notes as comments
    why: It is the most faithful mapping Beads allows, so the gaps that remain are Beads' own and not artefacts of a lazy mapping.
  - decision: Run bch-cloak's comparison twice, first with status taken only from closes, then with our derived statuses written into Beads' stored status
    why: The second pass separates the semantic differences (ready rules, dropped links) from the stored-versus-derived status difference.
  - decision: Do not install or run beads-mcp (a separate PyPI package)
    why: Its existence is enough for the comparison, and the brief keeps installs minimal. Its tool list is marked as unverified.
  - decision: Answer "keep ours plus interfaces" rather than "adopt or build"
    why: The record is already built and proven on 10,549 events. The real choice is where portability comes from, and the trial showed export reaches Beads cheaply while adoption costs semantics.
questions:
  - question: Is there a specific tool you want this project's work to show up in soon (Linear, GitHub Issues, a Beads viewer), or is portability a principle for future adopters?
    recommend: A principle for now. Build the neutral export and the MCP server, and add a target only when someone needs one.
    why: Only the operator knows whether a concrete destination exists. If it does, that tool's API becomes the first export target instead of Beads JSONL.
    category: design
challenges:
  - premise: A standard tracker makes us portable.
    verdict: wrong
    evidence: "There is no standard to be portable to. The survey found no format that several independent tools read and write, apart from Beads' own JSONL with its ports and viewers, and Beads' docs say to go through the bd CLI. Portability came from an interface: a 60-line converter from our fold put herdr-brain's 96 items and 26 runs (122 rows), and bch-cloak's 1,827 items and 985 runs (2,812 rows), into Beads with no change to our storage."
  - premise: Our record's runs, reports, questions and decisions are what make the cycle work, and no tracker covers them.
    verdict: partly
    evidence: "Beads can hold them through extension points (types.custom run,question; a native decision type; free-form metadata that survived bd update; comments), so 'no tracker covers them' is wrong for storage. No tracker derives status from them, though. In bch-cloak's copy, 401 items are done by report but not closed, 25 are blocked by a report, 8 need a human and 7 are active through an open run. Beads shows all 441 as plain open work unless each writer sets status. Our rule that a question answered 'no' keeps blocking has no counterpart. Backlog.md cannot hold them as fields at all: unknown front matter is deleted on the next CLI edit, which leaves body prose, against the roadmap's rule that questions and decisions come from structured fields. Linear's agent sessions and elicitations come closest for runs and questions (from docs), but they are SaaS and have no category, recommendation or model fields."
  - premise: Beads is the closest match.
    verdict: holds
    evidence: "Of everything trialed or surveyed, Beads alone has a dependency graph, a ready query, custom types, preserved metadata, a decision type and safe concurrent writes. On herdr-brain its ready set matched ours on 7 of 8 items. Closest is still not close enough, for reasons tested on the copies: 308 of 1,157 bch-cloak blocking links dropped (196 are a child blocking its parent, the review and fix-round pattern); goals listed as ready work; 15 items under a blocked ancestor held back that our record treats as ready, because phases are guideposts. The import took 104 s and 1.3 GB of memory, and 39 MB became 527 MB on disk. It brings a 144 MB binary and stored status, against the core's contract."
  - premise: Adopt or build is the right framing.
    verdict: wrong
    evidence: "Building already happened: the record runs bch-cloak's 10,549 events. The useful third option is to keep the record and add interfaces: a versioned export (Beads JSONL is proven above), an MCP server over the CLI, and vocabulary borrowed from real standards (OpenTelemetry gen_ai.* for run metadata, and possibly A2A's state names for run lifecycle). This gets portability without giving up derived status or the dependency-free core."
  - premise: Decide this before the restructure.
    verdict: partly
    evidence: "The storage format does not block the restructure. The console reads only `org today --json` and `org status --json`, and bch-cloak's kit calls the CLI (about 30 calls in 12 files; two scripts mention events.jsonl). The format can change later behind the CLI. What is worth settling before the restructure is cheap: the CLI and its JSON output are the contract, the record module keeps its own format, and bch-cloak's record is not migrated."
  - premise: (brief) The MCP Tasks extension is a candidate for the item layer.
    verdict: wrong
    evidence: "Checked against the spec text. In 2025-11-25 Tasks were core and experimental; in 2026-07-28 they moved to the extension io.modelcontextprotocol/tasks, which applies to tools/call only and removes tasks/list. The extension says it 'allows a server to respond to a tools/call request with an asynchronous task handle'. A task has taskId, status (working, input_required, completed, failed, cancelled), statusMessage, timestamps, ttlMs and pollIntervalMs, and no title, dependencies, priority or assignee. It could serve a long-running dispatch call through our MCP server; it cannot hold items."
  - premise: (trial) Beads' ready query is consistent with its own data.
    verdict: unknown
    evidence: "With derived statuses stored, 23 bch-cloak items our record calls blocked appear in bd ready. 10 trace to dropped links. In other cases `bd ready --explain` lists an open blocker as resolved (bch-cloak's ARCH-7 is blocked by ENG-6, which is open, yet the explanation says 'Resolved blockers: ENG-6'). I could not tell whether this is a bug or a cache effect of bulk import. It needs checking before anyone relies on Beads' ready set."
---

# ARCH-11: what should hold the work items

## Position

**Keep the record. Get portability from interfaces, not from the storage format.** No standard
for agent work items exists, so "adopting the standard" is not on the table. Adopting one project's
format (Beads) would cost the derived status that makes the cycle cheap to run, about a quarter of
bch-cloak's blocking links, and the dependency-free core. A versioned export and an MCP server cost
little and deliver the portability that was asked for. Confidence is high that this is right for
now. It would change if a concrete destination tool appeared (see the question), or if Beads
gained derived status and stopped refusing links that cross the parent tree.

## What each candidate covers

"Tried" means I ran it on copies of our records in this trial. "Docs" means the claim comes from
the candidate's own docs or spec only.

| Need | Ours | Beads 1.3.1 (tried) | Backlog.md 1.53.0 (tried) | MCP Tasks ext. (spec) | Linear agents (docs) | Task Master (docs) |
|---|---|---|---|---|---|---|
| Items + dependencies | yes | yes, but parent-child is a dependency edge: 308/1,157 links refused | yes, one ID prefix only | no | yes | yes |
| "What is ready" | derived | `bd ready`: goals count as ready, children of blocked parents held back | `--ready` ignores status; only the last status counts as done | no | no query | `next` |
| Runs (who, harness, model, effort) | yes | custom type + metadata, preserved | body prose only (front matter dropped on edit) | an execution handle, no metadata | sessions, no model fields | no |
| Structured reports | yes (front matter, `org check`) | metadata blob on the run | prose | `result` of one call | response activity | no |
| Questions with category + recommendation | yes (`org ask`, auto categories) | custom type + labels; no auto-answer, no "declined still blocks" | prose | `input_required` within one call | elicitation, no category | no |
| Decisions | notes with `decision` | native `decision` type, or comments | `backlog/decisions/` documents | no | no | no |
| Priorities | unbounded number, agent-ranked | P0–P4 (lossy) | high/medium/low (lossy) | no | 0–4 | high/medium/low |
| Derived status | yes, from events | no: stored; only ready is derived | no: stored | state machine of one call | session state derived | no: stored |
| Local, no account | yes | yes (embedded Dolt, 144 MB binary) | yes (markdown files) | protocol | no (SaaS) | yes |
| MCP | not yet | separate `beads-mcp` package (docs) | yes: 20 tools listed (tried) | is MCP | yes | yes |

Also surveyed, from docs: git-bug (operation-log entities like ours, but no dependencies or
priority), GitHub Issues (sub-issues, blocked-by and issue fields, SaaS, no ready query),
Taskwarrior (a documented JSON interchange that preserves unknown fields, no agent concepts),
todo.txt and Spec Kit `tasks.md` (too thin), A2A (its Task is closer to our run than to our item,
with no dependencies or priority), and OpenTelemetry GenAI conventions (the only multi-vendor
standard near our runs, and telemetry only).

## The trial

Both live records were copied to `/private/tmp/arch-11-trial/` and only the copies were touched.
The herdr-brain copy had 96 items and 26 runs, one item and one run more than the brief said,
because ARCH-13 and this run were added since. The bch-cloak copy had 10,549 events: 1,827 items,
985 runs and 1,157 links.

**Beads, herdr-brain.** Imported 122 rows in 1 s.
- Ready: 9 for Beads, 8 for us; 7 agree.
- Beads adds the goals G-1 and G-3, which it treats as ready work.
- Beads drops ARCH-12, because its parent ARCH-9 is blocked. Our record lets work proceed under a
  blocked phase on purpose, since phases are guideposts.
- ARCH-11 (this run) also shows as blocked in Beads, through ARCH-7.

**Beads, bch-cloak.**
- The first import failed on titles over 500 bytes; 9 titles are longer.
- After clipping, it imported 2,812 rows in 104 s with 1.3 GB peak memory. The store grew from
  39 MB to 527 MB.
- `bd ready` takes 0.37 s against 0.12 s for `org status`. One write takes 0.73 s against 0.11 s.
- With status taken from closes only, Beads lists 1,026 ready items against our 606. The extra
  ones are 401 items done by report but never closed, 25 blocked by a report, 8 needing a human,
  7 active and 10 goals.
- With our derived statuses written in, Beads lists 624:
  - 10 extra are goals.
  - 23 extra are items our record calls blocked. 10 of those trace to dropped links; the rest are
    the unexplained "resolved" blockers noted under challenges.
  - 15 are missing: items under a blocked ancestor.
- The export showed 849 of 1,157 blocking links kept. Of the 308 dropped:
  - 196: the blocker is a child of the blocked item;
  - 40: the blocker is the blocked item's parent;
  - 68: the blocker is a deeper ancestor or descendant;
  - 4: blocker and blocked are on unrelated branches.
- The import ended with "Imported 2812 issues" and a skipped-cycle warning. I kept only the last
  line of output, so I can't say how many of the 308 were reported.
- Metadata survived `bd update`. Eight concurrent `bd create` calls all landed.

**Backlog.md, herdr-brain and bch-cloak.**
- A task file whose ID is `ARCH-11` is invisible (`Task ARCH-11 not found`), so every ID has to be
  renumbered; the converter keeps the old ID in a label.
- Custom front matter (`org_runs`, `question_category`) disappeared on the first
  `backlog task edit`. A custom `## Runs` body section survived.
- With our statuses mapped onto its statuses, its ready list matched ours plus the goals and the
  active item, but only after filtering out statuses it does not treat as done.
- On bch-cloak, 1,827 files take 7.7 MB, and `--ready` runs in 0.43 s.

**MCP Tasks.** A subagent read the raw spec files, and I re-read the 2026-07-28 changelog and the
ext-tasks specification myself. The quotes are in the challenges above.

## What moving bch-cloak's record would cost (if Beads were adopted)

- **Data.**
  - Remodel 308 blocking links. Most are review and fix rounds holding up their parent; Beads
    would need waits-for gates or a flatter tree.
  - Clip or move 9 titles.
  - Map unbounded priorities onto P0–P4.
  - Turn 985 runs and 949 reports into run rows with metadata. Report files stay as files.
  - History collapses to the import time: link and update timestamps, and the 317 reopenings,
    survive only if kept in metadata.
- **Behaviour.**
  - Every writer that today relies on derived status must set stored status:
    - ingest and settle: done, blocked, needs_human;
    - dispatch: active;
    - `org answer`: a declined question keeps its work blocked.
  - Concretely, that means bch-cloak's supervisor kit (12 files, about 30 org calls), the settle
    prompt, `lanes/`, the console's two read calls and the Brain watcher.
- **Contract.** The core gains a 144 MB binary and a database engine, and status becomes stored.
  That breaks two lines of `AGENTS.md`.
- **Effort.** Roughly a phase of work, plus a cut-over that bch-cloak would feel. Under the
  recommendation the cost is zero: nothing moves.

## What the operator would see in the console

- **If Beads were adopted:**
  - "Waiting on you" and "needs a human" would have to be rebuilt from labels and stored statuses.
  - Goals would appear among ready work.
  - Items under a blocked phase would vanish from ready. That is 15 items in bch-cloak today, and
    ARCH-11 itself in herdr-brain.
  - Some items blocked by a dropped link would appear ready when they are not.
  - Priority order would coarsen to five buckets.
- **Under the recommendation:** nothing changes. The export and the MCP server add ways out and in,
  not a new view.
