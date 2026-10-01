---
run: R-42
outcome: done
summary: |
  Implemented a dependency-free foreground dispatch module that opens or reuses and prepares a lane, starts a routed record run, launches and records a worker, starts the existing detached watcher with a readiness acknowledgement, then sends the generated prompt. Fix rounds can start a fresh worker or reuse a stopped worker with matching recorded route and live occupant identity. Partial failures leave a request journal, record notes when a run exists, and explicit recovery commands; retries preserve the run and do not silently replay uncertain launch or prompt delivery. Offline validation passes. The supervisor kickoff now uses the module for the next real dispatch; that live canary remains to be observed under the brief's prohibition on real agent dispatch during testing.
headline: One command now starts a recorded worker and its watcher with explicit recovery
blockers: []
proposals: []
learnings:
  - Start a worker without a work prompt, record its identity, and acknowledge watcher startup before sending work; watch failure then leaves an unprompted worker that can be retried safely.
  - Herdr prompt failure does not prove nondelivery; recovery must distinguish accepted delivery from an explicitly authorized resend.
  - Relative report paths need to resolve inside the selected lane worktree, while absolute paths can support an external archive.
  - A routing snapshot can feed both record start and lane dispatch without replacing lifecycle configuration or changing its relative path provenance.
  - Reusing a worker safely requires matching route metadata on its previous run and immutable identity from live Herdr; display-only session registry metadata is insufficient.
artifacts:
  - Add watched dispatch with explicit recovery
  - Report watched dispatch implementation and validation
  - dispatch/dispatch.mjs
  - dispatch/README.md
  - dispatch/test/dispatch.test.mjs
  - lanes/lane.mjs
  - lanes/test/lane.test.mjs
  - lanes/README.md
  - watch/watch.mjs
  - watch/README.md
  - supervisor/KICKOFF.md
  - npm test (307 tests, 306 passed, 1 existing skip)
  - npm run test:lanes (146 passed)
  - record check docs/reports/ENG-71-dispatch-20261001.md
  - lane check (run last after the report commit; its gate names the final clean commit)
decisions:
  - decision: Keep dispatch as a foreground module at dispatch/dispatch.mjs, composing the record, lane and watch CLIs with argument arrays.
    why: The record remains deterministic, library-free and foreground. Lane retains ownership and lifecycle checks; only the existing watcher runs in the background.
  - decision: Arm and acknowledge the watcher before sending the generated work prompt.
    why: Starting a worker without a prompt allows its identity to be recorded first and makes watch failure retryable without starting unwatched work.
  - decision: Store dispatch progress in its own atomic request journal and describe milestones and errors through record notes.
    why: Recovery needs durable knowledge of ambiguous side effects, while item and run status must remain derived from the record's events. No stored core status or new event type is introduced.
  - decision: Freeze routing per request and require explicit stopped-worker reuse from an earlier run.
    why: Record and launch use one route snapshot. Fix rounds cannot silently reuse a worker on a different model or infer permission from session display metadata.
  - decision: Require caller inspection and explicit adoption, fresh launch, acceptance or resend when an external side effect has an uncertain outcome.
    why: Neither a CLI failure nor an interrupted response proves that its side effect did not happen. Blind retries could create duplicate workers or deliver the same work twice.
questions: []
challenges:
  - premise: Dispatch is its own module.
    verdict: holds
    evidence: The new foreground CLI composes existing CLIs without importing record mutation logic or adding background behavior to the core. The lane launcher only gains structured output and a routing snapshot option.
  - premise: The prompt to the worker can be generated.
    verdict: holds
    evidence: Tests assert the ask, generated run brief, exact report path, run ID and caller fix instructions in the delivered prompt, and verify that input briefs remain unchanged.
  - premise: bch-cloak's dispatch.sh is the model.
    verdict: partly
    evidence: Its prepare, clean fast-forward and detached-watch requirements are retained. Copied harness/model/effort flags, rewriting briefs, parsing human launch output and fire-and-forget watcher startup are replaced by shared route resolution, structured output and an acknowledgement.
  - premise: Offline tests can establish the next-real-dispatch acceptance criterion.
    verdict: wrong
    evidence: Tests establish orchestration and recovery with a temporary record and Git repositories, fake Herdr and the real watcher. Actual supervisor use still needs observation; no real worker or pane was addressed during this run.
---

The implementation commit is **Add watched dispatch with explicit recovery**.
The report commit is **Report watched dispatch implementation and validation**.

The entrypoint is `node dispatch/dispatch.mjs ITEM --org DIR --lane TOPIC --route
ROUTE --brief FILE [--report FILE]`. It prints one JSON result containing the
route, declared harness/model/effort, run, lane, agent, pane, watcher PID/log and
journal path. `--base` fast-forwards only a clean lane. The generated prompt points
at the original ask and the record's original run brief; neither file is patched.

Fix rounds use a new run on the same item and lane. They start a fresh routed
worker by default. `--reuse R-previous --extra 'fix instructions'` selects the
stopped previous worker only after comparing item/lane/route and declared
harness/model/effort, checking live cwd/pane/workspace, and matching recorded
terminal/session identity. Old hand-dispatched runs without immutable occupant
evidence need a fresh worker. The lane session registry remains display-only;
dispatch does not read it to authorize or recover work.

Thirteen dispatch tests cover the successful ordering and separate record fields,
relative report destination, untouched briefs, open/prepare failures, watch
failure and same-run retry, uncertain launch adoption, explicit fresh launch,
uncertain prompt resend and accepted delivery, fresh/reused fix rounds, changed
routing config, replaced occupant, clean base fast-forward and dirty refusal,
lost record-start response recovery, request lock refusal, and invalid-input
preflight. One test starts the real detached watcher against fake Herdr, checks
its live PID/log and stripped supervisor pane identity, and verifies duplicate
watch refusal. Existing lane coverage now verifies structured launch output,
immutable identity and a pinned routing snapshot without sending a work prompt.

Baseline `npm test` passed 293 tests with one existing skip. After the change,
`npm test` passes 306 with that same skip; `npm run test:lanes` passes all 146.
The final `lane check` runs after both commits, as requested, and writes only the
lane's ignored gate artifact.

Recovery is deliberately visible. Before a run exists, open/prepare/base failure
prints a journal path; retry that path. Once started, the run links its journal and
has milestone/failure notes visible through `record show`. `--status R-n` reads
the journal; `--retry R-n` continues the saved request. A lost run-start response
needs `--recover-run`; an uncertain launch needs `--adopt` or `--fresh`; uncertain
prompt delivery needs `--accept-delivered` or `--resend`. Worker adoption requires
the caller to confirm that it is the worker from the frozen-route launch, then
checks its cwd and captures its live identity. A stopped saved watcher is surfaced
and cleared; a subsequent retry re-arms without replaying the prompt. If a live
watcher's startup acknowledgement was lost, watch's lock refuses duplication;
inspect and stop that watcher before re-arming. These uncommon recovery choices
are documented in `dispatch/README.md`.

The next supervisor dispatch is the remaining live acceptance observation, with
the exact entrypoint and record inspection in `supervisor/KICKOFF.md`. This run
has not claimed that canary, changed the shared `.lane.json`, activated or built
a release, written bch-cloak's repository/record, changed global launchers,
pushed, or published. `contrib/settle-watch.mjs` is unchanged. bch-cloak continues
on its current script until a later operator-activated release switch; its
cutover also needs to preserve its existing watcher timing policy.
