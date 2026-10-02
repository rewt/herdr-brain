# Brief: ENG-80 (with ENG-76), install carries discovery and housekeeping

Org item **ENG-80**. Read `docs/north-star.md`, `docs/roadmap.md`, `AGENTS.md` and the module READMEs you touch first; this brief is only the ask.

## The outcome

Discovery's entry adapters (ENG-77, `discovery/install.mjs`) and default housekeeping startup are
built but delivered by hand. Make installing a Herdr Monitor release (`herdr/release.sh` build/activate
and the plugin manifest) install the entry adapters reversibly and deliver the supervisor-only
housekeeping start through the same entry policy, so a machine that installs the plugin gets the
whole workflow in any project; `restore`/`rollback` remove it cleanly. Prove a native Herdr launch is
intercepted in a scratch home, and say plainly what is not covered (absolute binary paths, desktop or
remote sessions) and what entry transport those would need. ENG-76 (housekeeping start delivered
by the installed plugin rather than a project AGENTS.md) is folded in here.

Judged by: a test harness case that builds a release into a scratch home, activates it, starts a fresh agent in a pristine project through Herdr, sees discovery and the housekeeping instruction, then restores and sees the machine back as it was; offline tests for install/restore.

## Frame (operator, 2026-10-01)

For anyone, on any project, with no special user configuration: agents discover the workflow when
they enter a project and the record fills from their work; a project may override defaults through
its own tracked config. bch-cloak is one existing project, not the design center.

## Boundaries

Work only in this lane's worktree and scratch directories (scratch homes for any install test).
Never write bch-cloak, the shared `/Users/rewt/development/rewt/.lane.json`, the activated release,
`~/.local/bin`, launchd, harness user configuration, or Herdr panes you did not create. Keep
`contrib/settle-watch.mjs` as `AGENTS.md` says. Every test sets its own `ORG_ACTOR` and is bounded in
time. No push or publish.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`; cite commits by subject; `record check` it, commit
it, and run `lane check` last. Then stop. Rebase onto main yourself if it moves.
