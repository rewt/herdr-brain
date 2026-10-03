# ARCH-17: workspace design (research, a recommendation for the operator)

Read ARCH-17, ARCH-10's notes and the operator's 2026-10-03 decision on G-3 (record show). North Star:
docs/north-star.md. The operator wants one machine-level boundary that projects live within, all sharing one agentic
framework (a dispatch is a session in its own worktree, lanes run concurrently and promote, settle, the test slot,
release), each project customizing what it needs, and a workspace supervisor and console that see sessions across
projects while project agents see only their own. Today /Users/rewt/development/rewt behaves like an accidental
workspace (shared .lane.json, shared .org record, shared .worktrees) and bch-cloak lives outside it under bastian/.

Recommend the shape: what the workspace file holds and where it lives; the three tiers (installed framework,
workspace, project) and which settings belong to which; how a project joins (registered roots, nothing moved);
how each project comes to own its record, worktrees and temp, including a safe migration for herdr-brain's record
at rewt/.org; what a new machine gets by default (ARCH-19). Try the important parts in scratch. Say plainly where
the operator's framing is wrong or costly. ARCH-18 (sandbox) researches enforcement in parallel; note the seams.

Write the recommendation as docs/design/ARCH-17-workspace-20261003.md with decisions the operator must make marked
as questions. No product code changes. Commit, write the report, record check it, commit it, run lane check last.
Then stop.
