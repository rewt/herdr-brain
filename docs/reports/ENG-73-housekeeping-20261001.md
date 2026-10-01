---
run: R-44
outcome: done
summary: |
  Added dependency-free, default-on project housekeeping with a detached deterministic timer, a one-pass preview, record/Herdr/Git discovery, optional configuration overrides, and durable action/attempt logs. Worker closure requires a recorded terminal run and settled Git lane evidence; recovery requires an open recorded run, a matching live occupant and a current Codex interruption banner with only mouse-wheel junk in the composer. The module reuses supervisor/tidy-tabs.mjs in a strict authorization mode and never reads lane session metadata. The real herdr-brain preview preserved all twelve observed tabs and proposed no mutations. No real pane was closed, resumed or typed into, and no production schedule, release, shared configuration or launchd service was changed.
headline: Project housekeeping now discovers its defaults and preserves unsettled workers
blockers: []
proposals:
  - role: engineer
    title: Surface housekeeping activity and optional overrides in the console
    why: The deterministic module already writes structured actions and optional configuration, but Phase 4 should let the operator observe its activity and stop or adjust it from the control plane without opening log files.
  - role: engineer
    title: Include default housekeeping startup in installed plugin agent discovery
    why: This checkout now teaches entering agents to start the schedule, and the plugin exposes a generic project action. Adoption should deliver that same agent-entry instruction from the installed plugin in any project without requiring that project to copy AGENTS.md or a setup file.
learnings:
  - "Herdr's installed Codex manifest 2026.10.01.1 has no dedicated interrupted state; a synthetic interruption screen evaluates to idle with default_known_agent_idle_fallback. Live finished Codex work also appears idle, so lifecycle state alone cannot authorize recovery."
  - "R-44 has recorded terminal_id but no agent_session_id. Matching one recorded occupant identity, and checking both when present, supports current dispatch without using the display-only lane session registry. Legacy workers without either recorded identity are preserved."
  - "Project state defaults to the discovered record's housekeeping directory, keyed by the canonical Git common-directory hash, so projects need no new ignore rules and projects sharing one record remain separate."
  - "A detached schedule must clear inherited pane, tab and workspace IDs; retaining its first worker's tab would exempt that worker forever. Foreground passes still protect their own tab."
artifacts:
  - "Commit: Add default-on project housekeeping"
  - "housekeeping/housekeeping.mjs and housekeeping/README.md"
  - "housekeeping/test/housekeeping.test.mjs and housekeeping/test/fixtures/interrupted.txt"
  - "supervisor/tidy-tabs.mjs strict workerEligibility mode; AGENTS.md and supervisor/KICKOFF.md discovery instructions"
  - "herdr-plugin.toml generic housekeeping action; package.json includes the offline tests"
  - "npm test after implementation: 351 passed, 0 failed, 1 explicit skip; final lane check runs the suite after the report commit"
  - "Final focused housekeeping and shared tidy planner tests: 48 passed, 0 failed"
  - "npm run test:lanes: 146 passed, 0 failed"
  - "Live preview: node housekeeping/housekeeping.mjs --once --dry-run --state-dir $PWD/.lane/housekeeping-preview; 0 closes, 12 keeps, no recovery proposals"
  - "Preview evidence: .lane/housekeeping-preview/actions.jsonl (ignored, local to this lane)"
decisions:
  - decision: Default housekeeping on and discover the project, record and base branch; configuration is an optional override.
    why: The operator's steering superseded the brief's switch-on premise. Git worktree discovery and the existing record discovery provide the necessary machine-specific values without requiring a project setup file.
  - decision: Use a project-scoped deterministic timer started idempotently by an entering agent or supervisor.
    why: A 60-second recovery tick and 600-second cleanup pass cover record ingestion and later Git promotion, neither of which is fully represented by Herdr events or watch's final notice. No launchd installation or resident reasoning session is required.
  - decision: Reuse the tidy-tabs planner with explicit record and Git authorization for every live worker in a tab.
    why: Tab topology, running-process protection, watcher cleanup and self-tab protection already exist there. Strict mode prevents its legacy report-only or review/session-file rules from authorizing housekeeping deletion.
  - decision: Recover only the evidenced accidental mouse-wheel interruption, with a durable attempt written before input.
    why: A bare idle worker can be finished, waiting or interrupted by a human. The current banner plus an exclusively wheel-junk composer narrows automatic recovery to the incident demonstrated by the existing kit, and uncertain input must not be replayed after restart.
  - decision: Store module bookkeeping beside the discovered record, separated by canonical repository identity.
    why: Default-on operation must not create untracked files that make a project with no ignore configuration dirty. Housekeeping never writes events.jsonl or stored work status.
questions: []
challenges:
  - premise: A project must switch housekeeping on before it can work.
    verdict: wrong
    evidence: The operator explicitly corrected this premise during R-44. Replaced required org/config flags and enabled=false behavior with discovery, enabled=true defaults, and idempotent start. No-project or no-record invocations are quiet no-ops. Missing overrides use defaults; enabled=false is only an optional stop override. The change was small enough to implement in this run.
  - premise: Close, tidy and resume belong together.
    verdict: partly
    evidence: They share a cheap scheduler and live evidence but have separate authorization paths and cadences. Recovery can be disabled independently; watch remains responsible for delivery and dispatch remains responsible for launch/retry. Recovery does not interpret reports or retry dispatch.
  - premise: Herdr events or watch's final notice remove the need for a schedule.
    verdict: partly
    evidence: They can accelerate a pass, but they do not establish later record ingestion or Git promotion/closure and cannot recover an interrupted worker while watch is waiting. A deterministic timer covers those boundaries without extra integration state.
  - premise: bch-cloak's janitor scripts are the design to copy.
    verdict: wrong
    evidence: The tracked close script admits unrecorded workers, accepts a report file before ingestion, and does not require settled lane work. Its recovery grep can erase human words beside wheel junk or mistake an old interruption for the current turn. These behaviors were replaced with explicit recorded ownership, Git settlement and current-composer evidence.
  - premise: Idle or done proves a worker is finished.
    verdict: wrong
    evidence: Read-only live agent list and a finished Codex screen showed idle plus a final response and placeholder composer. The installed Herdr explain command classified the synthetic interruption fixture as idle too. Only the record and the current screen distinguish the actions safely.
---

## Delivery and use here

The implementation is committed as **Add default-on project housekeeping** on
`lane/housekeeping`. Core record storage, fold, status and lane lifecycle commands
were not changed. `contrib/settle-watch.mjs` and the tracked bch-cloak kit were not
changed. No model was called by housekeeping or its tests.

After this lane is reviewed and promoted, the supervisor should run from the
canonical herdr-brain checkout:

```sh
node housekeeping/housekeeping.mjs --start
```

It requires no housekeeping file or user-specific arguments. The command discovers
`/Users/rewt/development/rewt/.org` here and prints its PID and state directory.
Repeated startup reports the existing schedule. The optional canonical-checkout
`.housekeeping.json` can contain `{"enabled":false}` to stop at the next tick;
SIGTERM/SIGINT also stop gracefully. `resume:false` disables recovery alone.
The log is `actions.jsonl` in the printed state directory, and detached stderr is
`schedule.log`. No schedule was activated during this run: the brief forbids real
pane mutations, so the real canary use was the read-only preview instead.

## Safety evidence and limits

The preview at 2026-10-01 23:36 UTC discovered the real project and record without
org/config flags. It preserved twelve tabs: unnamed operator chats, the supervisor,
console programs and shells, this worker's tab, and a working release worker. It
observed only this repository's workspaces by canonical Git common-directory
identity, rather than a label, basename or remote. There were no eligible close or
resume candidates; destructive behavior was exercised only against fakes.

The offline tests use real disposable Git repositories with fake Herdr and record
commands. They cover promoted and archived closure; open, dirty, unpromoted,
blocked, replaced, unnamed, unrecorded and mixed-pane preservation; newer open
runs; waiting/declined questions; inert session-done and review files; the current
interruption/composer distinction; reports awaiting ingestion; durable recovery
deduplication and failed input; pre-action record/state changes; read outages;
configuration-free discovery; default-on startup; idempotent detached startup;
disable/stop; overlap refusal; and dry-run behavior.

Read-only Herdr investigation used the **herdr** skill at
`/Users/rewt/.agents/skills/herdr/SKILL.md`. The live worker's `agent explain` matched
`osc_title_working` under Codex manifest `2026.10.01.1`. Reading an older finished
local worker showed its final message and `› Ask Codex to do anything`, not an
interruption. Evaluating the **synthetic**, tracked interruption screen with
`herdr agent explain --file housekeeping/test/fixtures/interrupted.txt --agent codex --json`
returned `state: idle` and `fallback_reason: default_known_agent_idle_fallback`.
No real worker was interrupted to produce evidence. The tracked incident account
in `kit/bch-cloak-20261001/supervisor/WORK-PATTERN.md` explains the wheel escape.

Recovery covers that narrow Codex incident, not every possible harness interruption.
Unknown workers and legacy runs lacking recorded occupant identity remain untouched.
A removed merged lane without archive evidence is conservatively left alone; normal
lane removal already retires its Herdr workspace. The CLI has no atomic
compare-and-close or compare-and-prompt operation, so rechecks reduce but cannot
eliminate the final command race. A crash leaves a lock that requires inspection
before restart; logs currently have no retention policy. The action log is available
to the supervisor but does not yet have a console screen. Installed plugin-wide
agent-entry discovery remains adoption work, listed as a proposal above.

## Verification

Baseline `npm test` ran before edits: 312 passed, one explicit skip, and one existing
watcher timing failure in `a still-working worker delivers the long-running notice`.
That test passed in isolation. The full suite subsequently passed twice (351 passed,
one explicit skip). Two additional safety fixtures were then added; the final focused
suite passed all 48 housekeeping/shared-planner tests. `git diff --check` passed.

The report is checked with `record check`, then committed. `node lanes/lane.mjs check`
is deliberately the last command, after that commit, and runs the full configured
validation on the final clean lane HEAD; its result is stored in ignored
`.lane/gate.json`. The additional `npm run test:lanes` run passed all 146 tests and
uses offline fakes as well.
