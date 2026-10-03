---
run: R-151
outcome: done
summary: |
  Wrote the workspace recommendation (docs/design/ARCH-17-workspace-20261003.md) after surveying how
  rewt/ and bastian/ act as accidental workspaces today and trying the important parts in scratch.
  The recommended workspace is a single file per user account (~/.herdr-monitor/workspace.json).
  It lists joined projects and maps each one's record, worktrees and temp; projects stay where they
  are, and both existing records stay in place. It holds machine-wide guardrails as mechanisms:
  counted leases with test-slot liveness, the test slot, and the memory and load gates. It also
  holds sandbox grants. Projects join by being entered, and discovery stops at the project's edge.
  Guardrails narrow, stricter wins; customization is the project's. Four operator questions are
  filed (HUM-20..23), two reversible decisions are recorded, and three implementation items are
  proposed. No product code changed.
headline: The workspace should be a list of joined projects with machine-wide limits, not the rewt folder, and nothing needs to move.
blockers: []
proposals:
  - role: engineer
    title: "Workspace file, read side: a resolver for ~/.herdr-monitor/workspace.json (projects, record/worktree/temp mappings, guardrails, grants); console and watch read it with console.json as fallback; a view that prints every effective setting with its tier and source; a one-time adoption that maps herdr-brain and bch-cloak in place"
    why: "Every later workspace piece (discovery fix, leases, sandbox generation in ARCH-18, the default install in ARCH-19) needs one place that answers which project this is and where its things live. The scratch prototype in docs/reports/evidence/ARCH-17-R151/workspace.mjs is a starting point. The home directory's name waits on HUM-20, but renaming it later is cheap."
  - role: engineer
    title: "Discovery stops at the project's edge: with a workspace present, a project's record and parent .lane.json layers come only from its workspace entry; an ancestor .org or parent config that belongs to another project is skipped; behaviour without a workspace is unchanged"
    why: "Reproduced in scratch: a repository with no record of its own resolves its neighbour's ancestor record and dispatches with its neighbour's routes and memory profile. On this machine that would be any of the 13 other repositories under rewt/ writing into herdr-brain's record. bch-cloak runs its own kit and an explicit --org, so it is unaffected."
  - role: engineer
    title: "Workspace leases and lock keys: worker, review and promotion caps as counted leases in the workspace home, using the test slot's pid-and-start-time liveness; dispatch, review and promotion wait on them; watch and settle-watch lock names key on the record's real path and move out of os.tmpdir() into the workspace home (settle-watch's path, flags and behaviour unchanged)"
    why: "Turns the G-3 prose lane caps into one number plus measured gates (HUM-23). Path-keyed lock names would let two watchers run for one run if the record were ever reached through a symlink, and ARCH-18 will deny system temp, which is where these locks live today."
learnings:
  - "Node 20 on macOS silently truncates Unix socket paths longer than 104 characters: a 105-character bind succeeds with the socket at a different, truncated path, and connect also succeeds. Around 150 characters it fails with a misleading EADDRINUSE. Python reports 'AF_UNIX path too long'. A short real directory, or a short symlink to a long one, binds fine."
  - "The record's fold does not depend on its location: a copy of herdr-brain's record (1,750 events) moved with a symlink at the old path gave a byte-identical record snapshot. 435 event lines embed absolute rewt/.org paths, so any move keeps the old path as a symlink."
  - "watch/watch.mjs:288 and contrib/settle-watch.mjs:218 hash path.resolve(org), not the real path, into lock names under os.tmpdir()."
  - "herdr workspace list reports repo_key (the Git common directory) for every Herdr workspace, so live sessions can be grouped by project without configuration."
  - "Lanes find existing worktrees by branch (lanes/lane.mjs worktreeFor), so changing where new worktrees go lets old ones retire as they close. Worktree folders are keyed by basename: two repositories named app collide, and the second is refused safely."
  - "git clean -fdx removes a .org/ listed in .git/info/exclude, which is today's default record location for a new project."
  - "bch-cloak's lanes come from its own kit (worktrees hard-coded to ~/.herdr/worktrees/bch-cloak), not this repository's lanes CLI. Its record is bastian/.org and its routes are in the parent bastian/.lane.json."
artifacts:
  - "docs/design/ARCH-17-workspace-20261003.md"
  - "docs/reports/evidence/ARCH-17-R151/ (prototype workspace.mjs, demo.mjs, temp.mjs, demo-output.txt, transcripts.md, workspace.example.json)"
  - "Commit: ARCH-17: workspace design recommendation and scratch evidence"
  - "Commit: ARCH-17: separate operator questions from reversible decisions"
  - "Branch: lane/workspace"
  - "Record questions HUM-20, HUM-21, HUM-22, HUM-23 under ARCH-17"
decisions:
  - text: "Keep herdr-brain's record at rewt/.org, mapped in place by the workspace; the move is rehearsed and documented but deferred."
    category: design
    why: "Ownership comes from the mapping, the discovery fix and the sandbox grant, not from the location. A move costs a quiet window, a symlink for the historical absolute paths and two lock-name fixes, and buys only tidiness. It is reversible: the rehearsal's rollback restored the same events hash."
  - text: "The workspace home holds a small workspace record for cross-project decisions (caps, grants) instead of herdr-brain's G-3."
    category: design
    why: "Same record format and CLI, no new concepts in the core. G-3 should carry herdr-brain's roadmap, not machine-wide limits. Reversible by not creating it."
  - text: "Per-run temp always uses the short form ~/.herdr-monitor/t/<8 hex>/ rather than a path inside the project area when it fits."
    category: design
    why: "One rule and one sandbox grant shape. It is 37 to 56 characters for realistic usernames, against a 104-character socket limit that Node enforces by silent truncation."
questions:
  - question: "Workspace naming: keep 'workspace' with its home at ~/.herdr-monitor/, and always say 'Herdr workspace' for Herdr's tab groups?"
    category: other
    recommend: yes
    why: "The operator's word; the collision with Herdr's workspaces is manageable if always qualified."
    id: HUM-20
  - question: "Workspace boundary: projects join only by being entered, with no directory roots, so rewt/ is not a root?"
    category: security
    recommend: yes
    why: "A directory root brings every repository under it inside the boundary; joining on entry gives the same convenience."
    id: HUM-21
  - question: "Workspace supervisor: the console plus mechanical guardrails and an on-demand --role workspace chat, rather than a resident session?"
    category: other
    recommend: yes
    why: "Cross-project decisions so far were cap and load judgments that leases and gates make mechanical; a resident chat brings back the context cost the north star removes."
    id: HUM-22
  - question: "Machine-wide cap of 6 concurrent worker sessions, with memory and load gates deciding below it, replacing the '2 while bch-cloak is heavy' rule once ENG-116 lands?"
    category: other
    recommend: yes
    why: "The gates measure what 'heavy' meant; the cap becomes a counted lease."
    id: HUM-23
challenges:
  - "Formalizing rewt/ as the workspace would make a leak permanent. Its parent .org and .lane.json already resolve for any repository under it that has none of its own (reproduced in scratch). The boundary should be the set of joined projects."
  - "'Each project owns its record' does not require moving the record. Mapping plus discovery and sandbox scoping gives ownership; moving buys tidiness at a cost."
  - "A workspace supervisor as another long-running agent conflicts with the north star's cost argument and the M2 design rule (zero-inference checks, short triggered sessions, the record)."
  - "'Guardrails (enforced)' fits the contract that budgets are advisory only if guardrails defer and queue rather than refuse. Only the sandbox denies."
  - "ENG-118's in-flight lane defaults the test slot to bch-cloak's /private/tmp lock path. That is right for coexisting now, but the workspace should own the slot's location and honour the legacy lock until bch-cloak adopts; ARCH-18 will deny system temp otherwise."
---

## What I did

I read ARCH-17, ARCH-10's notes, the operator's 2026-10-03 decisions on G-3, the north star, the
sibling briefs (ARCH-18, ENG-116, ENG-118) and the M2 supervisor-homes design. I then surveyed how
the machine actually resolves records, settings, worktrees, locks and the console's project list.
Five things were tried in scratch: the neighbour leak and the basename collision, Unix socket
limits, a rehearsal of herdr-brain's record move on a copy, `git clean` against an excluded
`.org`, and a prototype resolver with a stricter-wins merge and counted leases, run against this
machine's real checkouts with read-only Git queries. Transcripts are in
`docs/reports/evidence/ARCH-17-R151/transcripts.md`.

## Not done, on purpose

- No product code changed, as the brief asked.
- I did not take the live record's lock to copy it. The copy tolerates a torn tail, and the copy
  was only read.
- I did not run `npm test` before the change. The change is documentation plus evidence files
  outside every test glob, and several lanes were running test suites on a memory-gated machine.
  `lane check` ran last as the validation.

## Seams handed to ARCH-18

These are listed in the design's "Seams with ARCH-18" section:

- The workspace file is the sandbox's only input.
- Locks in system temp move into the workspace home, with a named exception for bch-cloak's
  legacy test-slot lock.
- Cross-project channels that exist today need closing or an explicit grant:
  - the per-root claude-mem domain;
  - shared package stores;
  - bch-cloak running settle-watch from herdr-brain's checkout (ENG-64);
  - herdr-brain's release gate reading bch-cloak's checkout.
- The short per-run temp scheme is required for sockets.
- Herdr has one socket for every pane, so a supervisor needs a broker that only acts on its own
  project's panes, using `repo_key`.
