# One promotion bootstrap (ENG-555)

This is the operator-approved option D from R-769. Use it for the combined
policy-changing promotion, then let later requests use the adopted policy.
The supervisor submits the reviewed stack through the existing unsandboxed train.

`bootstrap-coverage.json` freezes **161 whole files** from main
`876f08b45a07ebfd01c4d9a8ab96203f0f45d674`: the 78 promotion files, 16 slot files,
one lane witness, 11 logic witnesses, eight adopted smoke files, the union of all
four supplied L-43 lists, the captured stack's changed tests and these two bootstrap
unit files. The dispatch monolith is replaced everywhere by the four files from
`4a4799ea21e62b78febb4f0ef8c6b721972f41ec`. Registration-only collection proves
the same **100 names and callback hashes** (32 admission, 4 options, 24 recovery,
40 session). It runs neither callbacks nor product/fixture imports.

The input snapshot includes the original required-list paths, byte hashes and
contents, plus immutable stack heads. Its `inputs_sha256` in the generated manifest
hashes compact JSON. All inventories come from those inputs and pinned Git objects;
the new selector is never asked to define the bootstrap coverage.

Regenerate with Node 20.19.4 from a checkout containing the captured Git objects:

```sh
node --experimental-vm-modules test/helpers/bootstrap-coverage.mjs
git diff -- test/helpers/bootstrap-coverage.json
```

The checked-in manifest has 64 groups before partitioning. `releasePhases()`
keeps groups at four files or fewer and isolates every lane, acceptance and
completion file. The recipe calls the existing bounded runner once per group,
sequentially, with `--file-timeout=480000 --suite-timeout=540000`. It preserves the
runner's load scaling, fixture policy, native ownership audit and teardown. The
manifest pins that runner to the reviewed capacity prerequisite and pins the
grouping and containment sources. The command pins the manifest and recipe bytes.

## Supervisor invocation

Every stacked request must use this **identical** `--validate` value:

```text
/Users/rewt/.nvm/versions/node/v20.19.4/bin/node test/helpers/bootstrap-gate.mjs --manifest-sha256=3ab01e439985adb2ac21356b10fae0eb19efb92517134b6a73a34d716fabb877 --recipe-sha256=87a8c3731b9c662eedec3abe6026b3821d75850c8d34d5eb8006a7c12a60f6aa
```

At R-769's idle train boundary, launch the queue worker/drain with
`MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1` and Node 20.19.4 first in `PATH`. This existing
sentinel suppresses the selected-file adapter's loaded-timeout retry as well as
any nested retry. The recipe refuses before starting files if the sentinel is
missing. Setting it only inside `--validate` cannot affect the sibling appended
step, because the train wraps the declared command in a subshell. A worker already
running without the sentinel must reach the normal idle boundary first.

For example, the supervisor's enqueue that starts the worker has this shape
(repeat the same override for each job, with that job's actual bindings):

```sh
MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1 PATH=/Users/rewt/.nvm/versions/node/v20.19.4/bin:$PATH \
node promote/promote.mjs TOPIC --org /Users/rewt/development/rewt/.org \
  --expected-head FULL_REVIEWED_HEAD --if-current-run R-NUMBER \
  --required-tests 'JOB_REQUIRED_FILES_JSON' \
  --validate '/Users/rewt/.nvm/versions/node/v20.19.4/bin/node test/helpers/bootstrap-gate.mjs --manifest-sha256=3ab01e439985adb2ac21356b10fae0eb19efb92517134b6a73a34d716fabb877 --recipe-sha256=87a8c3731b9c662eedec3abe6026b3821d75850c8d34d5eb8006a7c12a60f6aa'
```

`promote/promote.mjs` chooses `opt.validate` before `LANE_VALIDATE` and committed
settings, stores it on each job and passes it into the batch's `LANE_VALIDATE`.
The dequeue key is `[laneCLI, validate, laneConfig, Boolean(run)]`; only contiguous
matching requests join a batch, up to `maxBatch`, with no accumulation window.
Capture all intended jobs at a normal boundary and verify membership; identical
overrides alone do not guarantee a single batch. Preserve the normal source-head,
run, record, review, clean-tree, base and fast-forward checks.

## Partition and evidence

Let **F** be the frozen files and **P** the captured-base planner's actual
`plan.files`. `promote/train.mjs` gets its plan via `canonicalTestPlan()` and calls
`plannedCommand()`, which exports `MONITOR_PROMOTION_TEST_FILES`, then executes
`( declared command ) && candidate-planner --run P`. With no append, P is empty.
The recipe verifies that P is unique and contained in F before starting a file,
runs **F \ P**, and leaves **P** for that append exactly once. It does not subtract
the planner's `covered` claims or derive F from new smoke membership. Unknown
selected files refuse preparation; reconcile and review the manifest before any
bootstrap proof if the final stack adds files. The candidate planner's explicit
`--run` contract must still execute its supplied list in full.

Each group streams TAP and stops on its first nonzero status, signal or launch
error. Assertion/timeout diagnostics name the failing file; an audit or group
failure without a file location names every member of the failed group, without
claiming which individual assertion failed. No group is retried or excused. The
final JSON summary partitions every F file into passed groups, the red group,
unstarted files and train-pending P. P remains pending in this summary: only the
normal train gate's subsequent TAP and green receipt establish its execution.

Before enqueue, recheck that the captured base still permits request-scoped
overrides (R-769 found no `.validation-receipts.json` at the frozen source). Retain
the existing train's exact candidate receipt and integration proof. The independent
stack review covers this recipe, all source pins and the candidate `--run` contract.

## Worker proof

Run only these native-free unit files on the clean committed lane candidate:

```sh
node /Users/rewt/development/rewt/herdr-brain/lanes/lane.mjs check --cmd 'node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/bootstrap-coverage.test.mjs test/bootstrap-gate.test.mjs'
```

The generator tests only registration and pinned source reads. Recipe tests inject
group results, including failure, timeout, signal and launch error; they never run
the manifest. L-43 files stay deferred to the supervisor's bound required tests.
