# Brief: ENG-77, agents discover the workflow in any project

Org item **ENG-77**, proposed by R-46 (ENG-74, release acceptance). Read `docs/north-star.md`,
`docs/roadmap.md`, `AGENTS.md`, `acceptance/README.md` and
`docs/reports/ENG-74-release-acceptance-20261001.md` first. This brief is only the ask.

## The outcome

An agent that enters any project on a machine where Herdr Monitor is installed finds out, without
a person setting anything up, how work is done there: that the project has a record (and it gets
one if it has none), that its own work goes in its own lane, how promotion works, how to dispatch
and how reports come back, and what the routing policy is. The project's record then fills from
the work agents do. When there is no routing policy yet, an agent asks the operator, proposing
today's routes as the default, and the answer becomes the project's configuration.

## Why it matters, and to whom

The operator (2026-10-01): this is for anyone, with any project; a project needs no specific user
configuration; agents discover it when they enter to work, and everything is agentic. A main use
case is several agents in one project side by side without collision, each following the
promotion process, and an agent asking the operator how to route models. ENG-74's acceptance run
shows none of this happens today: entering agents find no policy, work in the shared main
checkout, and never populate a record or ask about routing.

## How the result will be judged

ENG-74's acceptance cases, run against main with this work promoted:
- 02 New project: record discovers and populates
- 03 New project: routes resolve without config
- 04 New project: discover dispatch/watch/default cycle
- 20 Real discovery: concurrent lanes and promotion
- 21 Real discovery: routing question waits and answer applies

all pass, with the others still passing (`node acceptance/run.mjs --candidate main ...`, see its
README; the real-agent cases use the cheapest route and report their tokens). If a case is wrong
about what should happen, say so and change the case with evidence rather than bending the product
to it.

## Premises to test

1. "Discovery needs a file in the project." Something must reach an entering agent; it may be a
   file an agent writes on first entry, something the Herdr plugin provides when a session starts,
   a harness hook installed with the plugin, or the record's own CLI. Compare what each costs a
   project and which harnesses each reaches. The core never branches on harness (`AGENTS.md`);
   per-harness adapters can live outside it.
2. "A project without a record should get one automatically." Decide when, by whom, and how to
   avoid two agents creating two records.
3. "The supervisor and a lane worker should be told different things." Today's housekeeping
   finding says yes: a lane worker must never act as if it owns the project.
4. "The routing question waits for a human." In this record `tooling` auto-answers; ENG-74 proposes
   `other`. Decide what a fresh project's defaults should be, and whether the product should carry
   today's routes as a preset.
5. "Promotion from inside a sandboxed agent session is possible." ENG-74 found a Git limit; find
   the bounded path that keeps sandbox protection.
6. Anything else here you find wrong.

## Already decided

- Module names and the record CLI (`record`, `org` an alias). Routes in `lanes/routes.mjs`;
  dispatch, watch and housekeeping as on main. The record contract in `AGENTS.md`.
- No push, publish or account sign-up; no release activation.

## Boundaries

- Work only in this lane's worktree and scratch directories. Never write bch-cloak's repository,
  record or workspaces, the shared `.lane.json`, the activated release, `~/.local/bin` or launchd,
  or other projects on this machine. Keep `contrib/settle-watch.mjs` as `AGENTS.md` says.
- Installing anything into a harness's user-level configuration (hooks, settings) is not yours to
  do on this machine: build it, test it in scratch homes, and say in the report what the
  supervisor or operator should install.

## Where you are free

The discovery mechanism, bootstrap, file formats, what a project carries, and how it is told to
supervisors versus workers.

## Reply

Commit on this lane; write the report at the path your prompt names, with `decisions`,
`questions` and `challenges` after `artifacts`, and the acceptance one-screen result in the body;
cite commits by subject, not hash; `record check` it, commit it, and run `lane check` last. Then
stop.
