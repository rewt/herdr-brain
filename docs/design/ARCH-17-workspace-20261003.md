# ARCH-17: the workspace

Date: 2026-10-03. Run R-151. Status: **recommendation; nothing built.** Operator decisions are
marked **Q1–Q4**, and two reversible decisions taken here are marked **D1–D2**; both are
collected at the end. ARCH-18 (sandbox) is researched in parallel; the seams are
in their own section. Scratch evidence: `docs/reports/evidence/ARCH-17-R151/`.

## The short version

- **The workspace is a file, not a directory.** One file per user account,
  `~/.herdr-monitor/workspace.json`, lists the projects that have joined, where each one's record,
  worktrees and temp live, the machine-wide guardrails, and the sandbox grants. Projects stay where
  they are. Moving them gains nothing.
- **The boundary is the set of joined projects, not `rewt/`.** Today `rewt/` and `bastian/` act as
  accidental workspaces through parent files (`.org`, `.lane.json`, `.worktrees`). I reproduced in
  scratch that these leak: a repository with no record of its own silently writes into its
  neighbour's record and dispatches with its neighbour's routes. Formalizing `rewt/` as the
  workspace would make that leak permanent for the 13 other repositories that live there.
- **Ownership comes from mapping, not moving.** herdr-brain's record stays at `rewt/.org` and
  bch-cloak's at `bastian/.org`. The workspace file names them as those projects' records, discovery
  stops crossing into another project's record, and the sandbox grants each project only its own.
  A move was rehearsed on a copy and is safe, but it should wait until two lock-key bugs are
  fixed, and it is optional.
- **Machine-wide guardrails become mechanisms, not prose.** Today the lane caps are sentences in the
  record ("at most 2 lanes while bch-cloak is heavy"). They should be counted leases in the workspace
  home, using the same pid-and-start-time liveness as the test slot (ENG-118), alongside the memory
  and load gates (ENG-116). Guardrails defer or queue work and never refuse it, which keeps the
  contract that budgets are advisory. Only the sandbox denies.
- **A workspace supervisor should not be another resident chat.** The console plus those mechanisms
  covers almost all cross-project coordination. When the operator wants to talk about the machine,
  any chat can enter the workspace role and get a cold start.

## What exists today (evidence)

Three accidental layers, with three worktree schemes and about nine settings files:

| Concern | herdr-brain | bch-cloak | a new project |
|---|---|---|---|
| Record | `rewt/.org`, found by walking up to an ancestor | `bastian/.org`, the same way | `<checkout>/.org`, created automatically |
| Routes and memory domain | parent `rewt/.lane.json` (`claude-mem-rewt`) | parent `bastian/.lane.json` (`claude-mem-bastian`) | the parent's, if one exists above it |
| Worktrees | `rewt/.worktrees/<basename>/` (lanes CLI, parent rule) | `~/.herdr/worktrees/bch-cloak/` (bch-cloak's own kit, hard-coded) | entry: `~/.herdr/worktrees/<sha16>/`; lanes CLI: `~/.herdr/worktrees/<basename>/` |
| Machine locks | watch and settle-watch locks in `os.tmpdir()` | test slot at `/private/tmp/bch-cloak-test-slot.lock` | the same |
| Cross-project view | `~/.config/herdr-org/console.json` lists both records for the console and watch | | not listed |
| Lane caps, memory rules | prose decisions on G-3 | bch-cloak's own two-lane rule | none |

Findings, each reproduced in scratch (`e1`, `e5`) or read in the source:

1. **The record leaks to neighbours.** `findOrgDir` (`lib/store.mjs:38`) falls back to any ancestor
   `.org`. In scratch, `projB` with no record ran `record status` and got `projA`'s record. On this
   machine `rewt/coach`, `rewt/Handy`, `rewt/openoats` and the rest would all resolve to
   herdr-brain's record. Nothing has written there yet (no `coach` paths in the 1,750 events), but
   only because nobody has entered those repositories.
2. **Routes and memory domains leak the same way.** The lanes CLI layers the nearest parent
   `.lane.json` (`lanes/lane.mjs:287`). `projB` dispatched with `projA`'s engineer route and memory
   profile. On this machine every repository under `rewt/` would write observations into the
   `claude-mem-rewt` domain. That is a cross-project data channel, which ARCH-18 has to close or
   grant explicitly.
3. **Worktree folders are keyed by basename.** Two different repositories named `app` resolve to the
   same `.worktrees/app`. The lanes CLI refuses the second one ("worktree path belongs to another
   repository"), so this is safe but unusable: the second project cannot open a lane with the same
   topic name.
4. **The fold does not depend on the record's location.** I copied the live record (1,750 events,
   19 MB) and moved it into a project area with a symlink at the old path. `record snapshot` was
   byte-identical through the symlink, and identical after path normalization through the new
   path. Rollback restored the same SHA-256. Three things are location-bound:
   - 435 events embed absolute `rewt/.org/...` paths (briefs, watcher logs).
   - Running sessions carry `ORG_DIR` in their environment.
   - `watch/watch.mjs:288` and `contrib/settle-watch.mjs:218` key their locks on
     `path.resolve(org)` rather than the real path, so a watcher started through the old path and
     one started through the new path would not exclude each other.
5. **Unix socket paths fail silently.** On this Mac (Node 20.19), binding a 105-character path
   succeeds but creates the socket at a truncated path, and the connect also succeeds. A
   150-character path fails with a misleading `EADDRINUSE`; Python reports "path too long". Today's
   validation temp prefix is already 88 characters
   (`…/lane-workspace/.lane/validation-tmp/`), and macOS's own `TMPDIR` is 49. A short real
   directory binds fine, and so does a short symlink to a long directory.
6. **Herdr already knows project identity.** `herdr workspace list` reports `repo_key` (the Git
   common directory) for every Herdr workspace. The console can group live sessions by project
   without any configuration.
7. **Name collision.** "Workspace" already means a Herdr workspace (a tab group). The record stores
   `worker_workspace=w2KJ` on every run. See Q1.

## The three tiers

**Installed framework** (`~/.local/share/herdr-monitor/releases/<tag>`, read-only, changed only by
activating a release). This holds the code, every default, and the only code shared across projects.
It covers the route preset, validation tiers, release defaults, housekeeping defaults, approval
categories, the supervisor protocol, the entry policy, and the sandbox profile generator.

**Workspace** (one file per user account). Machine-wide facts and limits:

- which projects have joined, and where each one's record, worktrees and temp live;
- guardrails: lane, review and promotion caps; settle sessions per day; load and memory thresholds;
  the test slot (location, which tiers take it, wait or refuse); and the approval categories that
  are reserved for the operator in every project;
- the sandbox: private-data denies, cross-project grants, the Herdr socket policy (ARCH-18);
- shared defaults projects may replace: routes, `always_args`, harness environment;
- console preferences (refresh, glyphs).

**Project** (committed in the repository, plus the project's record config). The project's own
customization: routes by name, validation and `prepare`, the release gate and ship step, the entry
mode and policy, housekeeping, budgets, and approvals outside the reserved set. On top of that, a
project may narrow any guardrail for itself.

The rule is **stricter wins for guardrails, the project wins for customization.** If a project sets
a looser guardrail (more lanes, a lower memory floor, an auto approval in a reserved category), that
value is ignored and shown with its source; the project's work is not refused. A project can never
grant itself sandbox access. Grants exist only in the workspace file. The scratch prototype
implements this merge. With bch-cloak asking for `max_workers: 2` (kept), `min_free_percent: 10`
(ignored as a widening) and an extra reserved category `prover` (kept, because reserving more is
narrowing), the result was exactly that.

Settings by tier (✓ owns, ↓ may only narrow, · not here):

| Setting | Framework | Workspace | Project |
|---|---|---|---|
| Defaults for everything | ✓ | · | · |
| Routes, `always_args`, harness env | preset | shared default | ✓ replaces by name |
| Worker, review and promotion caps | default | ✓ machine total | ↓ |
| Settle sessions per day | default 30 | ✓ | ↓ |
| Load and memory gates | mechanism | ✓ thresholds | ↓ |
| Test slot | mechanism | ✓ path, tiers, wait or refuse | ↓ may add tiers |
| Reserved approval categories | default six | ✓ | ↓ may reserve more |
| Approvals outside reserved, budgets | default | · | ✓ record config |
| Validation, prepare, release gate, ship | default | · | ✓ |
| Entry mode and policy, housekeeping | default | · | ✓ |
| Record, worktree and temp locations | layout | ✓ per project | · |
| Sandbox denies and grants | generator | ✓ | ↓ may deny more |

I am not proposing a new project settings file. The existing files (`.lane.json`,
`.lane.validation.json`, `.promote.json`, `.housekeeping.json`, the record's
`config.json`) are the project tier already. The cheap fix for the scatter is one view, like
`lane config` today, that prints every effective value with its tier and source file.

## The workspace file

```json
{
  "version": 1,
  "projects": {
    "herdr-brain": {
      "checkout": "~/development/rewt/herdr-brain",
      "record": "~/development/rewt/.org",
      "worktrees": "~/development/rewt/.worktrees/herdr-brain",
      "layers": ["~/development/rewt/.lane.json"]
    },
    "bch-cloak": {
      "checkout": "~/development/bastian/bch-cloak",
      "record": "~/development/bastian/.org",
      "worktrees": "~/.herdr/worktrees/bch-cloak",
      "layers": ["~/development/bastian/.lane.json"],
      "legacy_locks": ["/private/tmp/bch-cloak-test-slot.lock"]
    }
  },
  "guardrails": {
    "lanes": { "max_workers": 6, "max_reviews": 1, "max_promotions": 1 },
    "memory": { "max_swap_used_mb": 0, "min_free_percent": 25 },
    "test_slot": { "tiers": ["promotion", "release"], "when_held": "wait" }
  },
  "grants": [
    { "id": "W-1", "project": "herdr-brain", "read": ["~/development/bastian/bch-cloak"],
      "why": "the release gate runs bch-cloak's compatibility check (RELEASE_BCH_CLOAK)" }
  ]
}
```

- **Where it lives:** `~/.herdr-monitor/` is the workspace home. It holds the file, project areas
  (`p/<name>/`), short temp (`t/<8 hex>/`), locks and leases (`locks/`), and a small workspace
  record (D2). A single home gives the sandbox one rule: the home is read-only to every
  session, and only a session's own area and temp under it are writable. An environment variable
  (`HERDR_MONITOR_WORKSPACE`) points tests and rehearsals elsewhere. The directory name is the
  operator's choice (Q1).
- **Identity:** a project is its Git common directory, as everywhere else in the product. The file is
  keyed by a readable name and stores the checkout. The identity is recomputed and checked on every
  use. A checkout that has moved shows as stale in the console instead of being guessed at. A new
  project's name is its basename, with a 6-character identity hash added only on a collision.
- **Who writes it:** only the operator, either by entering a project or through a `monitor workspace`
  command the operator runs. Sessions can read it but never write it; the sandbox enforces that.
- **What it replaces:** `~/.config/herdr-org/console.json`'s project list (the console and watch
  read the workspace file first and fall back to console.json), and in time the parent
  `.lane.json` files, which become explicit `layers` entries for the projects that use them.

## How a project joins

**By being entered.** When the operator starts `claude` or `codex` in a Git repository that has not
joined (entry already intercepts this), entry adds it to the workspace file and creates its area
(`p/<name>/record`, `worktrees`, `tmp`). The operator entering is the consent; nothing else
registers a project. Sessions launched by Monitor already run inside a joined project. Repositories
the operator never enters stay outside the boundary, even if they sit next to one that has joined.

**Existing layouts are mapped, never moved.** If the repository already has a record (its own
`.org`, or an ancestor `.org` that belongs to it), the join maps it instead of creating a new one.
For this machine, a one-time adoption writes the two entries shown above. That changes nothing
about where anything lives.

**Discovery stops at the project's edge.** With a workspace present, a project's record and parent
settings layers come only from its workspace entry. An ancestor `.org` or parent `.lane.json` that
belongs to another project is skipped, and a project with nothing of its own gets its own area.
This is the product change that fixes findings 1 and 2. Without a workspace file, today's behaviour
stays as it is, so bch-cloak and older installs are unaffected.

Q2 asks whether directory roots (for example "anything under `rewt/` may join") are worth keeping.
I recommend against: joining by entry already covers it, and a directory root silently widens the
boundary to every repository that ever lands there.

## Each project's record, worktrees and temp

**Record.** Mapped in place for both existing projects. New projects get `p/<name>/record`, outside
the checkout. That keeps a `git clean -fdx` in the canonical checkout from deleting it: today's
default `<checkout>/.org` sits in `info/exclude`, which `-x` removes. The record stays a plain
directory that `ORG_DIR` can point at, so the core needs no new concepts.

**Moving herdr-brain's record (optional; D1 defers it).** It was rehearsed on a copy. If the operator ever
wants `rewt/` tidy, the move is safe in this order:

1. Fix the two lock keys to use the record's real path (`watch/watch.mjs:288`,
   `contrib/settle-watch.mjs:218`). For settle-watch this changes only an internal lock name, not
   its path, flags or behaviour, which bch-cloak relies on until ENG-64.
2. At a quiet point with no runs open and watch stopped, take the record lock, copy, and compare the
   SHA-256 of `events.jsonl` and the `record snapshot` text.
3. Point the workspace entry, console.json and the supervisor's environment at the new path. Leave
   a symlink at `rewt/.org` for at least one release so that the 435 historical absolute paths keep
   resolving. History is never rewritten.
4. Rollback is removing the symlink and moving the directory back. The rehearsal restored the same
   hash.

This buys tidiness, not ownership. I recommend not moving it now.

**Worktrees.** Mapped per project. New projects get `p/<name>/worktrees/lane-<topic>`, which ends
the basename collision. Existing lanes are found by branch (`worktreeFor` in `lanes/lane.mjs:544`),
not by recomputed path. Changing a project's `worktrees` mapping therefore only affects new lanes,
and old ones retire as they close. In-flight worktrees never move.

**Temp.** Each run gets `TMPDIR`, `TMP` and `TEMP` set to `~/.herdr-monitor/t/<8 hex of
identity + run>/`. That is 37 characters for this account and 56 for a 30-character username,
leaving 47–66 characters for socket names inside it. Use a short real directory, never a symlink,
so the sandbox's rules match the same path the tools use. The project's area keeps an index from
run to temp directory, and housekeeping removes the temp with the lane and reports leftovers it
owns. I measured a "natural" layout (`p/<name>/tmp/<run>`): it fits for herdr-brain on this account
(51 characters) but not for longer names or usernames. Always using the short form keeps one rule
and one sandbox grant shape.

## Guardrails as mechanisms

| Guardrail | Mechanism | Sees non-adopting projects (bch-cloak's kit)? |
|---|---|---|
| Heavy validation one at a time | test slot (ENG-118), lock moves to `locks/test-slot` and also honours bch-cloak's legacy lock while it exists | yes, through the legacy lock |
| Worker, review and promotion caps | counted leases in `locks/leases/<kind>/`, with pid and start-time liveness | no; Herdr's working agents by `repo_key` fill the gap until bch-cloak adopts |
| Memory and load | gates (ENG-116 and today's load checks) read the machine | yes |
| Settle sessions per day | per project, derived from the record | n/a |

The lease mechanism ran in the scratch prototype with a cap of 2. A lease held by a dead pid was
reclaimed, two live holders from different projects were granted, and a third was refused with
`held 2/2`, so the caller waits. Leases are coordination state like the record lock, not stored
status, so "status is derived from events" still holds. With leases and gates in place, the G-3
prose rules ("two lanes while bch-cloak is heavy, six while it is idle, nothing while swap is in
use") become one number in the workspace file (Q4) plus gates that measure what "heavy" meant.

## Who sees what

- **The console** reads the workspace file for records and groups live Herdr sessions by `repo_key`.
  It sees every joined project, and it writes only through each project's record CLI, as it does
  today.
- **Project agents** see only their own project. Their record comes from their own workspace entry,
  the sandbox denies other projects' checkouts, areas and temp, and they have no Herdr socket
  (ARCH-18).
- **Project supervisors** need Herdr to open their lanes' panes, but Herdr has no per-project access
  control: one socket drives every pane. The workspace supplies the facts for a fix (`repo_key` per
  Herdr workspace, the project's identity). The fix itself, a small broker that only acts on panes
  belonging to the caller's project, is an ARCH-18 decision.
- **The workspace supervisor (Q3).** I recommend against a new resident chat. The M2 design's rule
  applies: always-on checks with zero inference, a short session only when something needs
  reasoning, and the record. The cross-project decisions made today were all cap and load
  judgments that the leases and gates make mechanical. When the operator wants to talk about the
  machine, a chat entered with `--role workspace` gets a cold start from every project's
  `today` plus machine state, and records into the workspace record (D2) instead of into
  herdr-brain's G-3.

## A new machine (ARCH-19)

Install creates `~/.herdr-monitor/workspace.json` with no projects and framework-default guardrails.
Sandboxing is on by default (ARCH-18). The first `claude` or `codex` in a repository joins it,
creates its area and record, and runs normally. The console lists whatever has joined. No
questions are asked, there are no directory roots, and no parent files are read, because there is
no workspace-less legacy to honour. Settings that need human input stay optional, such as a release
gate's inputs or a cross-project grant, and are surfaced when they are first needed. The fresh
account rehearsal should assert three things: the file exists, a second repository entered next to
the first gets its own record, and the per-run temp path is under 60 characters.

## Seams with ARCH-18 (sandbox)

1. The workspace file is the sandbox's only input. Per project and per session: write the session's
   own worktree, its project's record and its own temp; read its own checkout, the installed
   framework and toolchains; deny everything else. Grants are workspace entries with an id, a
   reason and a record reference, and they are revocable by deleting the entry.
2. Locks in system temp today: the watch lock, the settle-watch lock, and bch-cloak's test slot at
   `/private/tmp`. They move into `~/.herdr-monitor/locks/`, except bch-cloak's legacy lock, which
   needs a named exception until bch-cloak adopts.
3. Cross-project channels that exist today and need closing or an explicit grant:
   - the per-root memory domain (`claude-mem-rewt` covers every project under `rewt/`);
   - shared package stores (`bastian/.pnpm-store`, `~/.npm`);
   - bch-cloak running `contrib/settle-watch.mjs` from herdr-brain's checkout, which means a
     herdr-brain lane that lands on main changes code bch-cloak executes (ENG-64 moves it to the
     installed release);
   - herdr-brain's release gate reading bch-cloak's checkout (grant W-1 above).
4. Socket path budget: Node truncates silently past 104 characters, so the short temp scheme above
   is a sandbox requirement, not a convenience.
5. A separate macOS agent user (ARCH-18's third option) would need the workspace home to be readable
   by that user and writable only per area. That is ownership and mode bits on `p/<name>/` and
   `t/`; the layout supports it without change.

## Where the framing is wrong or costly

- **"`rewt/` in place" as the workspace.** `rewt/` is a folder that happens to hold several
  projects. Its parent files are the leak shown above. The boundary should be the joined projects.
- **"Each project owns its record" read as "move the record".** Ownership means the project and
  only the project resolves and writes it; mapping gives that. Moving costs a quiet window, a
  symlink and two bug fixes, and buys tidiness.
- **"A workspace supervisor" read as another long-running agent.** That is the cost the north star
  exists to remove. Mechanisms plus an on-demand role give the same oversight.
- **"Guardrails (enforced)" against "budgets are advisory".** Both hold if guardrails defer and queue
  instead of refusing work. Only the sandbox denies.
- **The word "workspace".** Herdr already uses it, and the record already stores it on every run.
  See Q1.

## Operator decisions

- **Q1 (naming).** Keep "workspace" for this concept, with the home at `~/.herdr-monitor/`, and always
  say "Herdr workspace" for Herdr's tab groups? Recommended: yes. It is your word, and the collision
  is manageable if it is always qualified in code and in briefs. The alternative is a new noun.
- **Q2 (security boundary).** Should projects join only by being entered, with no directory roots, so
  `rewt/` is not a root? Recommended: yes. A directory root silently brings 13 other
  repositories inside the boundary, and joining by entry covers the convenience.
- **Q3 (how you steer).** Should the workspace supervisor be the console plus mechanical guardrails and an
  on-demand `--role workspace` chat, rather than a resident session? Recommended: yes, per the north
  star and the M2 design.
- **Q4 (guardrail value).** Should the machine total be 6 worker sessions, with memory and load gates
  deciding below that, replacing the "2 while bch-cloak is heavy" prose? Recommended: yes, once
  ENG-116's gate has landed; until then, keep the current rule.

Decided here (design, reversible; say so to overturn either):

- **D1.** herdr-brain's record stays at `rewt/.org`, mapped in place. The move is rehearsed and
  documented above for whenever tidiness is worth a quiet window.
- **D2.** The workspace home gets a small workspace record for cross-project decisions (lane caps,
  grants), so they stop landing in herdr-brain's G-3. It uses the same record format and CLI.

## Scratch evidence

`docs/reports/evidence/ARCH-17-R151/` holds the prototype (`workspace.mjs`: resolver, area and temp
layout, stricter-wins merge, counted leases), its demo against this machine's real paths (read-only
Git queries), the leak and collision reproduction, the socket-length probe and the record-move
rehearsal transcript. None of it is product code.
