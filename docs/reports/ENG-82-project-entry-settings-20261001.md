---
run: R-58
outcome: done
summary: |
  Installed Codex and Claude entry adapters now honor tracked project preferences in the canonical project's .lane.json: decline entry, choose worker lanes or the integration checkout, reuse main for the integration branch, and append project policy. Both transports deliver the project's root AGENTS.md and CLAUDE.md with explicit precedence over generic policy. Unconfigured projects keep worker-lane defaults, and entry-only configuration preserves the portable routing suggestion. Main-checkout workers retain their worker role and require clean committed work plus successful sandboxed validation before ingesting a done report. The implementation is committed on this lane for review; no promotion, installation or publication was performed.
headline: Projects can control installed entry adapters through tracked configuration
blockers: []
proposals:
  - role: engineer
    title: Always reap watcher test children after receipt timeouts
    why: Existing watcher receipt waits can fail under concurrent test load before reaching waitForExit, leaving mocked blocked or working children alive and preventing npm test from exiting. Register cleanup for every spawned child so a fixture failure finishes the suite and reports its error.
learnings:
  - "Entry preferences are canonical-project settings; inherited routes and a worker's edited config must not opt a project out or select its mode."
  - "A .lane.json containing only lifecycle or entry settings declares no model preferences; it must retain the suggested preset and pending operator question."
  - "Main-checkout mode selects a checkout, not a supervisor role. There is no lane to promote, and done-report ingestion must validate the committed integration checkout."
  - "The machine's global ignore rules can exclude CLAUDE.md in scratch projects; instruction fixtures explicitly track both instruction files."
artifacts:
  - "Commit: Project entry adapters honor tracked project preferences"
  - "Commit: Report project entry settings and offline verification"
  - "Branch: lane/entry-settings"
  - discovery/settings.mjs
  - discovery/runtime.mjs
  - discovery/policy.mjs
  - discovery/adapters/codex.mjs
  - discovery/adapters/claude.mjs
  - discovery/test/settings.test.mjs
  - discovery/README.md
  - lanes/routes.mjs
  - lanes/docs/REFERENCE.md
  - /tmp/eng82-pristine-baseline.log
  - /tmp/eng82-final-npm.log
  - /tmp/eng82-final-lanes.log
  - /tmp/eng82-acceptance-offline.log
  - /tmp/eng82-settings.log
  - /tmp/eng82-lane-check.log
  - /tmp/eng82-lane-check-concurrency2.log
  - .lane/gate.json
decisions:
  - decision: Add entry.enabled, entry.mode and entry.policy to the existing project .lane.json; retain main as the integration branch declaration.
    why: Projects already track route and lifecycle settings here. Reusing that file and branch field avoids another configuration layer and conflicting branch declarations.
  - decision: Check project opt-out before Git execution configuration, record initialization, exclusions, worktree creation or stale-entry recovery.
    why: Declining entry must preserve both an untouched project and any existing local entry state, even when unused settings would otherwise fail validation.
  - decision: Read entry preferences only from the canonical project, while preserving existing parent route and lifecycle discovery.
    why: Entry is a project choice. Machine settings and unpromoted worker changes cannot silently change another session's checkout or entry participation.
  - decision: Keep main-checkout workers separate from the explicitly selected supervisor role.
    why: Working in the integration checkout must not grant coordination or housekeeping authority. Fixed worker commands still verify Git identity and the assigned branch.
  - decision: Deliver project policy and root instruction contents through both native transports, with explicit project-instruction precedence.
    why: An entering agent receives the project's actual instructions, including review requirements that override generic workflow defaults, without editing tracked instruction files.
questions: []
challenges:
  - premise: Selecting the main checkout implies a supervisor session.
    verdict: wrong
    evidence: Main-mode entry remains a worker, refuses lane rebase and promotion operations, and supplies policy that forbids project housekeeping. Only explicit supervisor entry selects that role.
  - premise: The existence of a project .lane.json establishes its model routing preferences.
    verdict: wrong
    evidence: Entry-only settings retain the portable route suggestion and one shared pending operator question; they do not substitute model preferences for an operator answer.
---

The configuration contract and examples are documented in `discovery/README.md`.
All new cases run offline in unrelated scratch Git projects, with installed
wrappers and scripted native clients; no model calls or live pane operations are
needed.

The eleven cases cover explicit and interactive opt-out for both harnesses,
native argument/environment preservation and byte/mode comparisons of the full
project including Git metadata; delivery of settings, policy and both instruction
files; explicit and interactive main mode; real local Git promotion onto `trunk`;
main-mode commits and branch binding; rejection of dirty work, failed validation
and validation that changes tracked files before done-report ingestion; retained
routing suggestions; canonical identity; and invalid settings before setup.

The initial confined baseline runs and one final check at default test concurrency
stalled in existing watcher fixtures, leaving mocked working or blocked children
alive after short receipt waits. Only this run's verified process groups were
terminated. The unchanged starting commit passed in a scratch clone with normal
local process permissions: 399 passed, zero failed, two expected skips. The final
direct npm test also passed every case. The final lane check runs the same npm
test globs with Node test concurrency set to two; every test remains included.
Watcher-fixture cleanup is proposed separately.

| Verification | Result |
| --- | --- |
| Pristine baseline npm test | 399 passed, 0 failed, 2 expected skips |
| Final npm test | 410 passed, 0 failed, 2 expected skips |
| New installed-entry cases | 11 passed, 0 failed, 0 skipped |
| npm run test:lanes | 146 passed, 0 failed, 0 skipped |
| Offline acceptance harness tests | 27 passed, 0 failed, 0 skipped |
| Report record check | Pass; checked immediately before report commit |
| Final lane check | Runs last after report commit with test concurrency two; receipt in .lane/gate.json |

The stand-in transport cases establish what the installed adapters deliver and
which Git/record operations they perform. They do not claim live-model compliance
or approval of the full release acceptance gate. Existing lane promotion and
cleanup safety checks, display-only session metadata, the dependency-free core,
and `contrib/settle-watch.mjs` are preserved. Work and installations stayed in this
lane and scratch directories.
