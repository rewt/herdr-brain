# Markdown workflows (prototype v1)

Agents author and improve workflows as reviewed project code; humans set intent
and boundaries. This dependency-free foreground interpreter parses structured
Markdown, runs argument arrays, and writes mechanical step receipts. It never
calls a model, schedules work, or writes the record event log.

The format borrows the configuration/prose split from
[GitHub Agentic Workflows](https://github.github.io/gh-aw/reference/workflow-structure/)
and its [local composition idea](https://github.github.io/gh-aw/reference/imports/).
It does not compile to GitHub Actions or accept the gh-aw schema.

## Format

Frontmatter sits between `---` lines. Each field is `key: JSON-value` on **one
line**, a small YAML-compatible subset without a YAML dependency. Required fields
are `name`, `trigger`, `inputs` and `permissions`; `imports` is optional. Unknown
fields and duplicate frontmatter fields are errors.

````markdown
---
name: "Project check"
trigger: "manual"
inputs: {"repo": {"required": true}, "target": {"default": "core"}}
permissions: ["commands"]
---

# Project check

## Steps

### check — Run the project gate

Check {target} and retain its output.

```json
{"command": ["node", "scripts/check.mjs", "--repo", "{repo}", "--target", "{target}"], "permission": "commands"}
```

## Gates

["check"]

## On failure

Preserve the checkout and inspect the failed step's log before retrying.
````

Each `### step-id` (optionally ` — Title`) under `## Steps` has prose and exactly
one fenced `json` object. IDs start with a lowercase letter, contain only lowercase
letters, digits and hyphens, and must be unique. Command steps have `command`
(a string argument array) and `permission`. Arguments may be empty strings; the
executable must be nonempty. No shell is inserted. Hosts may register local verbs
through `runCommand(argv, options)`; otherwise the executor uses
`spawnSync(argv[0], argv.slice(1))`.

Agent steps instead have `route` and `permission`, plus nonempty prose:

```json
{"route": "project-review", "permission": "dispatch"}
```

The engine passes `{route, prompt, inputs, step, receipt}` to a host dispatch
adapter. Routes are opaque; provider/model policy stays in dispatch. The adapter
returns a durable `{id}`. The step becomes `dispatched`, the workflow becomes
`waiting`, and later steps are skipped. Acknowledgement proves handoff, never
completion or a green gate. Without an adapter the step fails. This prototype
exposes that contract; it does not wire live dispatch or report-based continuation.

`## Gates` is a JSON array of unique command step IDs whose success is required
for completion. Any failed step stops subsequent execution. Gate declarations do
not replace host lifecycle proofs. `## On failure` is required recovery prose,
retained in the definition, not an executable handler.

Input definitions accept `required` (boolean) and `default` (string). Supplied
values must be strings; unknown inputs are rejected. `{input_name}` substitutes
once into each argument, agent route and step prose, preserving one argument even
with spaces or shell punctuation. All templates and permission grants are checked
before any effect. `trigger` is a label for the caller, without a scheduler.

Permissions are named host capabilities. The caller explicitly grants every
declared capability, and every step names one declared capability. This adapter
boundary is not an OS sandbox: default executable commands are trusted project
code. Restricted hosts must enforce their command set in the adapter, as the
train does. Workflow edits go through normal review, train and release gates.

## Imports and API

`imports: ["shared/checks.md"]` prepends local fragments in listed order. Each
fragment has only `## Steps` and its step subsections, inheriting root inputs and
permissions. Paths resolve from the root workflow's directory. Real paths outside
that directory, duplicate imports/step IDs, metadata in fragments and nested or
remote imports are refused. The definition hashes all source bytes, including prose.

```js
import { loadWorkflow, runWorkflow } from './engine.mjs';

const workflow = loadWorkflow('/project/.herdr/workflows/check.md');
const result = runWorkflow(workflow, {
  directory: '/project/.git/workflow-runs',
  cwd: '/project', inputs: { repo: '/project' }, grants: ['commands'],
});
```

`parseWorkflow(text)` parses a standalone definition; use `loadWorkflow(file)` for
imports. Adapters are synchronous. Exceptions close the failed receipt and return
as `result.error`; the host decides whether to propagate them. Nonzero exits and
signals fail the workflow. There are no automatic retries or invented timeouts.

## Receipts and recovery

Every execution creates a UUID directory with `run.json` (`workflow-run/v1`) and
one `STEP.json` (`workflow-step/v1`) and `STEP.log` per step. Files are replaced
atomically with mode 0600. Receipts include `status`, `started_at`, `finished_at`,
`output_path`, and command argv or agent route. Commands save exit code and signal;
adapter `output_path` becomes an `artifact` link to external evidence. Environment
values are not saved. `onStart({id, manifest})` links a run before its first effect.

Executed steps move from `running` to `succeeded`, `failed` or `dispatched`.
Skipped steps have null clocks. Running steps have no exit result or finish clock.
Crashes leave unfinished receipts; the engine cannot infer success. Hosts own
locking, recovery and idempotence. Receipts are display evidence for the pipeline
view, never authority to integrate, retry or delete. Retention is not implemented.

## First workflow: the train

[The train definition](../.herdr/workflows/train.md) selects four registered
argument-array commands: prepare, validate, integrate and close. Opt in with:

```sh
node promote/promote.mjs TOPIC --workflow
node lanes/lane.mjs promote-batch /absolute/train.json --workflow
```

The queue saves the choice per request and batches only compatible choices. The
default remains the existing train. `PROMOTE_WORKFLOW_ENGINE=1` opts in an invocation
and lets the unchanged promotion tests exercise the engine. Queued CLI requests
retain their choice after the enqueuer exits.

The train loads the bundled definition, pins its hash to the batch and rejects a
changed definition on resume. v1 requires the four stage commands in order and
the validation gate; prose edits cannot remove safety checks. The host still owns
FIFO bisection, scratch replay, cleanliness, merge-tree proof, STOP, record
readiness, validation evidence, locks and the exact-commit fast-forward. Existing
shell-based lane preparation/gate configuration stays inside the registered
validation command.

`train.json.workflow_runs` links each group execution before its first step.
Receipts live beside the batch under `workflow/`. Red groups have failed validation
and skipped integration/close steps; FIFO halves each get an execution. A recovered
fast-forward runs only close with a fresh receipt, preserving the original
interrupted receipt. Queue tab cleanup, Git lane closure and supervisor delivery
stay in the existing queue after these four stages.

## Limits and next steps

v1 supports sequential steps, one-shot inputs and local fragments. It cannot
express conditionals, DAGs, loops, dynamic outputs, executable failure handlers,
nested/remote imports, asynchronous report joins, resource policies or generic
durable resume. Train branching and recovery remain host operations, with a fixed
stage shape during migration.

Next connect agent handoff to `dispatch/dispatch.mjs` with durable bindings and
report-based continuation. Then map release preflight, preparation and gate argv
while retaining exact-tag snapshots, single gate claims and operator ship
decisions. Finally map settle review/fix handoffs and caps, keeping code-only
reviews and reviewed-head promotion bindings. Each migration must prove existing
behavior with unchanged tests before becoming the default.
