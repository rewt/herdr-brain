---
run: R-249
outcome: done
summary: |
  Added a dependency-free Markdown workflow parser and foreground executor with per-step receipts, local step imports, literal argument-array commands and an opaque routed-agent handoff contract. Today's train is expressed in .herdr/workflows/train.md and runs through the engine with --workflow; the current train remains the default. All 67 targeted offline tests pass, including the unchanged train and promotion tests against the engine. Implementation is committed; the lane check follows this report's validation and commit.
headline: The train can run from a Markdown workflow with durable step receipts.
blockers: []
proposals:
  - role: engineer
    capability: tooling
    title: Connect workflow agent steps to durable dispatch and report-based continuation
    why: The prototype hands routed prose to a synchronous dispatch adapter and pauses after its durable acknowledgement. Live dispatch needs exact request and run bindings, report joins, lost-reply reconciliation and resume proofs before later steps can execute.
  - role: engineer
    capability: tooling
    title: Express release preflight, preparation and gate as a Markdown workflow
    why: Reuse the argument-array executor and receipts while preserving exact-tag snapshots, single gate claims, setup-required behavior and the operator's ship and activation decisions. Existing release tests must pass unchanged against an opt-in path before changing the default.
  - role: engineer
    capability: tooling
    title: Express settle review and fix handoffs as a Markdown workflow
    why: After agent continuation exists, model review and correction steps can use the same format. Retain code-only settle reviews, review-round caps, originating-run bindings and exact reviewed-head promotion; prove the existing settle tests unchanged.
learnings:
  - Workflow receipts are display evidence; the train's existing attempt checkpoints, validation proofs and locks remain the authority for recovery and integration.
  - The train accepts registered argument-array stages in a fixed order during this migration, so workflow prose cannot remove lifecycle safety checks. Branching and FIFO bisection remain host operations.
  - Existing promotion fixtures need fs.watch; a minimal watcher probe fails with EMFILE inside this session's sandbox. The same targeted offline suites passed outside the sandbox without test changes.
artifacts:
  - "Implementation commit d66946e on lane/workflow-engine"
  - "workflow/engine.mjs and workflow/README.md"
  - ".herdr/workflows/train.md"
  - "promote/train.mjs, promote/promote.mjs and lanes/lane.mjs"
  - "promote/test/workflow-engine.test.mjs and promote/test/workflow-train.test.mjs"
  - "Final targeted test output: /private/tmp/ENG-202-engine-final.tap (67 passed, 0 failed)"
  - "Report: docs/reports/ENG-202-workflow-engine-20261004.md"
decisions:
  - text: Use one-line JSON values in Markdown frontmatter and one JSON step block under each named step.
    category: design
    why: This YAML-compatible subset keeps the core dependency-free, rejects ambiguous configuration and preserves prose as the authored instructions.
  - text: Keep train branching and recovery in the existing host while the opt-in engine executes its four guarded stages.
    category: design
    why: The prototype adds a reusable format and receipts without weakening replay proofs, STOP, record readiness, tree-keyed validation, locking or exact-commit fast-forward integration.
questions: []
challenges: []
---

Implemented in `d66946e`. The specification and examples are in
[workflow/README.md](../../workflow/README.md); the first executable definition is
[.herdr/workflows/train.md](../../.herdr/workflows/train.md).

The design follows the operator's G-3 direction: agents author and improve the
system through normal review, train and release gates; humans set intent and
boundaries. It borrows frontmatter plus Markdown prose and local composition from
[GitHub Agentic Workflows' structure](https://github.github.io/gh-aw/reference/workflow-structure/)
and [imports reference](https://github.github.io/gh-aw/reference/imports/), without
adopting its schema or compiler.

The v1 format requires name, trigger, input definitions and permission names,
then `## Steps` with one `### step-id` per step, `## Gates` with a JSON array of
required command step IDs, and `## On failure` with recovery prose. Each step has
one fenced JSON definition. Commands are argument arrays; agents are a route plus
prose passed to a dispatch adapter. Inputs substitute literally within arguments,
routes and step prose, and are checked before any effect. Permission grants are
host capabilities, not an OS sandbox; command files remain trusted project code.

For example:

````markdown
---
name: "Check"
trigger: "manual"
inputs: {"repo": {"required": true}}
permissions: ["commands"]
---
## Steps
### check
Check the selected project and retain the output.
```json
{"command": ["node", "scripts/check.mjs", "--repo", "{repo}"], "permission": "commands"}
```
## Gates
["check"]
## On failure
Keep the checkout and inspect the step log before retrying.
````

`imports: ["shared/checks.md"]` prepends local `## Steps` fragments, inheriting the
root inputs and permissions. Imports cannot escape the workflow directory,
introduce metadata, nest, or duplicate steps. The root and imports are hashed.

The executor writes one atomic `workflow-step/v1` receipt and output log per step,
plus a `workflow-run/v1` manifest. Receipts include status, start, finish, output
path, command argv or agent route, and completed exit/signal or dispatch ID.
An interrupted step remains running with no invented result. Agent acknowledgement
produces a waiting workflow, never a green gate. No environment values are saved.

Opt in with `node promote/promote.mjs TOPIC --workflow` or
`node lanes/lane.mjs promote-batch RECEIPT --workflow`.
`PROMOTE_WORKFLOW_ENGINE=1` also selects the engine, including for unchanged tests.
Queue requests save their selection and incompatible selections form separate
batches. The train runs prepare, validate, integrate and close through registered
argument-array commands. It pins the workflow hash to the batch, links each group
execution before its first effect, and retains red and interrupted receipts.
Recovered integration executes only bookkeeping, without repeating the gate.
Queue cleanup, Git lane closure and supervisor notice delivery remain outside
these four stages. The existing lane preparation/gate shell commands are retained
inside the validation adapter for compatibility.

The prototype cannot express generic loops, conditionals, DAGs, dynamic outputs,
executable failure handlers, nested/remote imports, asynchronous report joins,
generic durable resume, scheduling or retention. The train's four-stage shape is
fixed; its existing host owns bisection and checkpoint recovery. The follow-on
proposals cover agent continuation, then release and settle.

Validation: the command below passed 67/67 offline tests in 104.5 seconds. Both
existing promotion test files are unchanged. Coverage includes FIFO stacking and
bisection, record/STOP/head guards, scratch mutation, interrupted validation,
lost fast-forward recovery, validation reuse, running telemetry, queue cleanup and
notice recovery. New tests cover format rejection, imports, literal argv, grants,
dispatch pause, live receipts, red exit preservation, default behavior, explicit
flags and pinned workflow changes. The test-tier map includes both new files.

```sh
PROMOTE_WORKFLOW_ENGINE=1 node test/helpers/run.mjs \
  promote/test/workflow-engine.test.mjs promote/test/workflow-train.test.mjs \
  promote/test/train.test.mjs promote/test/promote.test.mjs test/tier-plan.test.mjs
```

The initial sandbox run hit filesystem watcher errors; a standalone watcher probe
confirmed the environment limitation. The unchanged suites passed outside the
sandbox. No baseline, full npm suite, promotion tier, lane suite, live acceptance
or model was run. `record check` validates this report before its commit; the final
command is `node lanes/lane.mjs check` on the clean committed lane. Its evidence
is stored in `.lane/gate.json` and the Git-common-directory validation receipt.
