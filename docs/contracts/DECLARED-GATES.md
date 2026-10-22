# Project-declared promotion gates

Status: accepted (authority review 7346206-r1 PASS); `receipt_reuse` = `declared-inputs` selected by the operator (HUM-38)

Implementation status (ENG-537): **inert**. Every v2 admission is refused with
`DECLARED_GATES_V2_INERT` before effects. No project can activate this contract
until ENG-538 completes the identity fence and removes the lock. Behavior tests
that require admission remain pending ENG-538; there is no activation switch.

Authority: ARCH-38 decisions of 2026-10-21 at 18:51Z (park), 18:52Z (opaque
commands and declared coverage), and 18:53Z (receipt-reuse alternatives),
record sequences 13232, 13235 and 13237. The
[agreed plan, section 2.5 rule 6 and section 3 piece 2](/Users/rewt/development/rewt/.org/proposals/PLAN-20261021.md)
requires config that launches work to run as its owning identity. The existing
execution-identity amendment stands. The original
[contract PASS](../reviews/declared-gates/af96a9a-r1.md) applies to the earlier
design; it is not approval of this amendment. The later
[implementation reviews](../reviews/declared-gates/) remain historical evidence.

**The project declares commands and coverage; the train executes those commands
as that project and records their outcomes.** Commands are opaque. Brain does
not infer coverage from scripts, inspect imports, recognize Python launch forms,
or discover runtime chains to police launches. Candidate test scripts, helpers,
package recipes and runner configuration are covered by the lane's independent
review, as in ordinary CI. The operator-owned native sandbox is the wall.

Brain remains dependency-free and model-free. No project name, file extension,
language, harness or provider selects special execution behavior.

## What a project declares

### One authority and its precedence

The redesigned opt-in is `schema: "declared-gates/v2"` in the owner's resolved
`.lane.validation.json`. This is a new version because command selection,
coverage and receipt meanings change. It is not an extension of the parked v1
implementation. File names here are logical surfaces; ENG-514's config-home
contract owns storage, resolution and history (it is outside this parked lane's
base). This contract adds no competing loader.

The declaration alone owns tier commands, additional named gates, coverage,
preparation, the optional planner, environment, limits and the receipt-reuse
switch. Capture its complete value, source revision and digest at admission.

| Source | Adopted-mode rule |
| --- | --- |
| Owner `.lane.validation.json` | Exactly one resolved declaration. Missing, ambiguous, invalid or unsupported resolution refuses without fallback. |
| `.promote.json` | Queue/transport policy remains here. `validate` and `gate` are forbidden, even if equal to the owner declaration. Move the old host gate profile to `.lane.validation.json.gate`. |
| `.lane.json` `validate`, `validation`, `prepare` | Explicit competing gate declarations must be removed at adoption. Inherited defaults add no execution steps. |
| `LANE_VALIDATE`, enqueue `--validate`, saved command overrides | Refuse for adopted promotion. Drain or explicitly dispose of incompatible jobs and re-enqueue with their requirements retained. |
| `LANE_CONFIG`, lane copies, working edits | Cannot redirect gate authority. A lane can propose a future declaration; it cannot authorize it for its own job. |
| Legacy `.validation-receipts.json` | Does not select or override declared-mode reuse. There is one switch, `receipt_reuse`, below. Legacy exact-validation remains unchanged. |

The owner adopts atomically: consolidate policy, remove conflicts, inspect the
effective declaration and capable release, then admit jobs. An owner config
change after admission requires explicit re-admission for work still needing
execution; retries must not recapture a weaker rule. Use existing config history
and queue receipts, with no new approval service. BCH owns its adoption
(ENG-1830); this document does not lift its hold or turn on its focused gate.

Development `lane check --cmd` remains available. An arbitrary local pass
certifies only its command; it cannot replace a required adopted gate. Reuse
requires the complete matching evidence described below.

### Commands and declared coverage

Keep the existing nonempty command-string tier keys `fast`, `promotion` and
`release`, `environment`, tier wall/idle limits and the existing `gate` host
profile, literal environment and ordered preparation semantics. Promotion and
release must be explicit. Existing suite inventories `host_suites` and
`tier_suites` keep their meanings. Add:

- `coverage`: a list of coverage tokens for each declared tier command.
- `gates`: additional named gates, each with a complete nonempty `command`
  string, project-relative `cwd`, and `covers` token list.
- Optional `promotion_tests`: the canonical planner command and its preparation.
- Required `receipt_reuse`: the single policy switch in the reuse section.
- Optional top-level `inputs` map keyed by tier, and an optional `inputs`
  object on each additional gate, used only by option B.

Coverage tokens are exact, nonempty strings. A test path token promises that
the command runs the whole file; a recipe or build token names that complete
project obligation. There is no extension whitelist. Tokens are not shell
fragments, path-glob expansion or evidence inferred from logs. A patterned
subset must have a distinct token and cannot satisfy a whole-file requirement.
The project, through its canonical declaration and independent review, is
responsible for the truth and completeness of these promises.

Commands are passed unchanged to `/bin/sh -c` in the declared cwd. Tier commands
run at the candidate root. Shell quoting, pnpm recipes, Python file/module/inline
drivers and other runtimes are ordinary project commands. Brain appends no
planner-produced arguments and substitutes no bare suite for a fixture driver.
The declared command is responsible for finishing its work before exit; Brain
does not attest the behavior or completeness of its children.

This BCH-shaped example is illustrative, not an approved BCH recipe or a claim
about its files. It shows the ARCH-692 cases without importing BCH policy:

~~~json
{
  "schema": "declared-gates/v2",
  "fast": "pnpm validate:fast",
  "promotion": "pnpm validate:smoke",
  "release": "pnpm validate:all-safe",
  "coverage": {
    "fast": ["recipe:validate-fast"],
    "promotion": ["recipe:validate-smoke"],
    "release": ["recipe:validate-all-safe"]
  },
  "receipt_reuse": "declared-inputs",
  "timeout_seconds": { "promotion": 3600, "release": 7200 },
  "idle_timeout_seconds": { "promotion": 900 },
  "gate": {
    "node_version_file": ".nvmrc",
    "prepare": [
      { "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile" }
    ]
  },
  "promotion_tests": {
    "command": ["pnpm", "exec", "tsx", "scripts/promotion-plan.ts"],
    "prepare": [
      { "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile" }
    ]
  },
  "gates": {
    "dependency-build": {
      "command": "pnpm --filter @example/dependency build",
      "cwd": ".",
      "covers": ["build:@example/dependency"]
    },
    "pool-vitest": {
      "command": "pnpm exec vitest run tools/pool-action-modules/test/canonical.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=60000",
      "cwd": ".",
      "covers": ["tools/pool-action-modules/test/canonical.test.ts"],
      "inputs": {
        "paths": ["packages/**", "tools/pool-action-modules/**", "scripts/**", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".nvmrc", ".npmrc", "vitest.config.*", "tsconfig*.json"],
        "environment": ["PATH", "HOME", "LANG"],
        "toolchains": {
          "node": "node --version",
          "pnpm": "pnpm --version",
          "vitest": "pnpm exec vitest --version"
        }
      }
    },
    "pnpm-recipe": {
      "command": "pnpm validate:fixture-controls",
      "cwd": ".",
      "covers": ["recipe:fixture-controls"]
    },
    "python-fixture": {
      "command": "python3 tools/example/scripts/test-runtime-no-proof.py",
      "cwd": ".",
      "covers": ["fixture:runtime-no-proof"]
    }
  }
}
~~~

Only the example's Vitest gate declares reuse inputs. The other commands
execute on every attempt under option B. Its input list is a shape example;
the project must review its actual input closure, including ignored/generated
dependencies where relevant. The example recommends B without selecting it
for the operator.

Gate identifiers are unique and cannot collide with tier names. Cwds must
normalize within the candidate and resolve there; unknown keys/versions, wrong
types, duplicate tokens within a list and undeclared gate references refuse.
An unavailable tool fails the declared command normally; Brain never installs
project dependencies into its bundle.

Preparation belongs to the project. Use locked dependencies/tool pins and run
preparation for a fresh candidate; an existing `node_modules` directory alone
cannot skip installation. Ignored build output is allowed; changes to tracked
content, HEAD or branch invalidate the attempt. Installation/network policy
stays with the project; Brain's own tests remain offline. Host profile, slot
path, token and `NODE_OPTIONS` restrictions stay intact. Ordinary builds/tests
stay shared; declared proving retains its existing
[host admission](HOST-RESERVATIONS.md).

## What the train does

### Canonical planning and required work

Capture the canonical base commit, candidate, owner declaration and each job's
head/run/required-evidence binding. Planner policy and coverage come from that
canonical base and its resolved owner declaration, never a candidate edit.
Materialize a private canonical-base snapshot, prepare it with the declared
`promotion_tests.prepare`, and invoke the planner argv there as a subprocess.
Brain does not import the project's TypeScript or other libraries. Candidate
paths are inspection data; the train does not substitute candidate scripts,
package installations or working config into the planner snapshot. Keep
snapshot containment and tracked-source immutability checks. This is a base
snapshot, not an inferred import closure or an attestation of every child launch.

Planner stdin is closed JSON with `schema: "promotion-gates-input/v1"`, the full
`base` and `candidate` commits, inspection-only `candidate_root`, sorted
`changed` paths (including deletions and both rename sides), and the jobs'
bound `required` union. The train computes these from Git and its jobs.
Planner stdout is one bounded, closed `promotion-gates/v1` selection:

~~~json
{
  "schema": "promotion-gates/v1",
  "gates": [
    { "id": "dependency-build", "reason": "build the selected suite's dependency" },
    { "id": "pool-vitest", "reason": "required whole-file suite" },
    { "id": "pnpm-recipe", "reason": "retain the recipe's controls" },
    { "id": "python-fixture", "reason": "retain fixture setup and negative controls" }
  ],
  "deferred": [],
  "unknown": []
}
~~~

The planner selects ordered IDs and explains them; it cannot supply commands,
argv, cwds, new coverage or a replacement promotion command. The project owns
dependency order, fixture context and conservative selection policy. The train
executes the mandatory promotion command, then the selected gates in order
(subject only to the chosen reuse policy). Without a planner there are no
additional gates; the mandatory command's coverage must suffice.

Required evidence is either an exact coverage token (including existing file
strings) or `{"gate":"pool-vitest"}` for a complete declared invocation.
Admission binds a gate requirement to its full definition, not just its name.
The train mechanically checks that mandatory plus selected declared coverage
contains every required token and that every required gate definition is
present unchanged. It does not prove those coverage claims by reading scripts.
A candidate package-script or helper change is allowed under independent lane
review; it is not a new coverage declaration and may invalidate reuse inputs.

Batch planning takes the union of members' requirements. Bisection, retry and
resume retain every included job's requirements. Unknown gates, a missing
requirement, duplicates, deferred/selected overlap or a nonempty `unknown`
list refuse before the gate. A canonical conservative plan may select extra
declared work, never silently drop obligations. If an owner change makes a
bound requirement unrepresentable, obtain explicit disposition/re-admission.
There is no implicit full-suite fallback, docs-only exemption or selector
authority. The existing observational selector stays observational.

Keep the planner's 20-second and 1-MiB stdout limits, the canonical snapshot's
10,000-path/64-MiB bounds and the separate existing affected-source scan bounds.
Selected, required and deferred inventories are each capped at 512, without
truncation. Optional gates retain finite count/time budgets (default ten gates
and 300,000 ms; unmeasured work costs 60,000 ms). Selection entries may carry
the existing positive `estimated_ms` and `estimate: measured|fallback` fields;
the plan may carry a `budget` object with `extras_ms` and `max_extra_gates`
(nonnegative safe integers). Required work consumes the allowance first and
may exceed optional caps with a recorded
`required_over_budget` exception, never the hard limits or execution deadline.
Deferred gates retain ID, reason, estimate and
`destination: release-candidate`; they satisfy no required obligation.

### Identity and bounded execution

**The existing identity amendment is retained.** Each identity's operator-owned
native sandbox is the root of trust. Brain does not verify native execution
identity on a shared-UID host or stop a hostile process outside its sandbox.
Its identity checks stop mistakes at the level agreed in plan 2.5. A project
needing a hard wall gets its own identity.

Enqueue, drain, dequeue, resume and integration require equal caller and project
identity roots, using existing `messages/journal.mjs` `identityRootAt` detection:
caller from cwd, project from its canonical Git common-directory realpath.
No marker means the standard default identity. The caller must also be in the
canonical checkout or one of its linked worktrees, matched by common directory.
Record both roots and recheck the captured binding at every stage, including
bookkeeping recovery. Mismatch/ambiguity refuses with a stable code before
effects. Foreign `--repo`, config, argv, environment and session display
metadata grant no identity override.

The project's supervisor launches its train from its own checkout. Its worker
binds to the job, project and identity root; a foreign-root resume refuses.
Brain performs no identity switch, sandbox widening or credential forwarding.
Config written by another identity never launches under the writer's access.
Owner-request/operator-authority and no-relaying rules stay intact. Native
permission refusals go to the operator. Native launch provenance remains
separate future work (ARCH-39 / plan 7).

One finite attempt deadline covers planner preparation/planning, candidate
preparation, declared version probes when applicable, input hashing and gate
execution. Preserve bounded host/lock waits, idle watchdogs and existing
process-group cleanup. All commands share the attempt's admission, log and
green gate. Nested commands inherit that slot; no second slot or
post-integration gate is introduced. Retries and bisection remain
bounded by existing train policy. No estimate extends a deadline.

Execution consumes one immutable, fully serialized `declared-gate-execution/v2`
binding containing the declaration, selection, requirements, identities and
candidate/base. Pass it as one safely quoted literal argv value to the executor;
a mutable plan path or environment pointer alone is insufficient. An oversized
argv refuses without omitting fields. Recheck Git/declaration/identity bindings
before execution and integration. Do not recompute a smaller selection.

## What it records

The `declared-gate-attempt/v2` attempt retains project/common directory, both
identity roots, job/head/run bindings, base/candidate, changed paths, declaration
source/revision/digest, planner snapshot and selection, required and declared
coverage, deferred reasons, limits and command order. Each preparation, planner,
probe and executed gate records its exact declared command, cwd, start/end,
exit code, signal/timeout and immutable log reference/digest, including on red
attempts. Preserve available TAP summaries and the train's own Node version;
neither proves coverage of an opaque project command.

Record each gate as executed, reused, failed or not reached. A reuse points to
the original executed receipt and log, with the compared declared-input digests
and hit/miss reason; never fabricate another execution or log. Environment
values/secrets never appear in receipts or diagnostics. Declared commands and
version probes must themselves contain no secrets.

Receipts are local execution evidence, not native identity attestations or an
independent review PASS. Do not capture child-launch trees, interpreter chains,
Python imports, package-script expansions or executable inventories. Option B
records only the explicitly declared input and version observations needed for
reuse; it is not a launch-policing mechanism.

## Failure and recovery

Malformed declarations/plans, authority conflicts, identity mismatch, unresolved
required work, changed Git/declaration bindings, failed preparation/planning,
nonzero gate exit, signal or timeout prevent integration. Preserve the command
exit and log; failure is never a green receipt. The train fast-forwards only
the exact clean, validated candidate under existing Git/record/readiness locks.
It never pushes, creates a merge commit or performs validation after landing.

Persist outcomes before completion bookkeeping. On restart, check identity and
saved job/candidate bindings, then recover durable terminal results under their
captured declaration **before** comparing current config or acquiring execution
admission. This includes integrated checkpoints, mixed refused/integrated
batches and a refusal-only batch. Verify the saved integration/log/tree and
containment proof when integration occurred. Complete bookkeeping without
repeating commands or integration. A later declaration change cannot strand
an already final refusal or integration.

Only unfinished work faces current-declaration admission checks; a mismatch
holds it for explicit owner disposition. An interrupted execution with no
completed pass is not reusable. Any bounded retry preserves its captured
declaration and requirements and all previous outcomes. Do not reinterpret old
evidence under new policy to finish a job.

## Compatibility and old readers

With no declared-gates schema, preserve legacy parity: the additive
`.test.mjs` planner, dependency-free snapshot, command bytes/order, coverage,
precedence, limits
and receipts. The old string `promotion_tests` retains its meaning in legacy
mode. No file extension or object shape silently opts a project in.

The new declaration, selection, execution and receipt versions require an
explicit capable-worker handshake before admission. In particular the parked
`declared-gates/v1` worker must refuse v2; it cannot reinterpret named gates
as `promotion-tests/v2` runners. Releases that ignore unknown fields are
incapable and must not be selected for an adopted project. Unknown schemas or
capabilities refuse visibly before effects. Old file-only and parked-v1
receipts remain historical evidence and cannot certify the redesigned mode.

Rollback stops admission and drains or explicitly resolves outstanding jobs
under their bound release/declaration. Restore legacy policy explicitly from
config history only when it still satisfies all outstanding requirements;
never erase a typed/gate requirement to fit an old reader. Otherwise hold the
project on a capable release. Keep logs, receipts, existing release-pin and
run-ownership handoff checks.

Brain still runs all offline suites once per release candidate, including
deferred extras. Other projects retain their declared release obligations.
An opaque promotion pass does not replace release acceptance or the BCH pilot.

## Receipt reuse: one operator decision

The standing rule is: **"rerun only failing tests; passing tests on unchanged
inputs aren't rerun".** The operator chooses the declaration's single named
switch `receipt_reuse`. There is no implicit default and no second override
in queue config, environment or a legacy receipt declaration. Until the
operator selects the policy and the authority review accepts the amendment,
this is a proposal, not permission to activate either option.

| Option / switch value | Behavior and consequence |
| --- | --- |
| A — `"always-execute"` | Run every selected declared gate on every executable attempt. Simple, with no reuse input declarations or version probes, but passing unchanged gates rerun after a test-only fix. This conflicts with the standing rerun-only rule and needs the operator's explicit choice. Terminal bookkeeping recovery still never reruns commands. |
| **B — `"declared-inputs"` (recommended)** | Reuse an executed pass only when the project declares all gate inputs and every compared digest is byte-identical. Missing/incomplete declarations, unavailable evidence or any mismatch mean execute that gate once. This preserves passing gates whose declared inputs are unchanged. |

B operates per complete gate, including the mandatory tier command. It cannot
extract a passing test from inside an opaque recipe. If one input of a broad
gate changes, that whole gate executes; projects need separately declared gates
to preserve passes at finer granularity. Red, incomplete, timed-out or signaled
executions are never reused.

For B, a gate's `inputs` declaration must explicitly provide all of:

1. **Paths/globs**, relative to the project, including product/test code,
   fixture drivers/helpers/controls, recipes, runner config, manifests,
   lockfiles and relevant ignored/generated dependencies. Hash sorted matched
   paths, entry kinds/modes and content bytes, including presence/absence and
   glob membership so additions/deletions change the digest. Bound enumeration
   and hashing by the snapshot path/byte limits and attempt deadline. An
   escaping symlink, unreadable or unrepresentable input is a reuse miss.
2. **The complete effective command**, cwd, declared coverage, ordered
   preparation and relevant gate/environment/limit policy. These are taken
   directly from the captured declaration, not repeated in planner output.
   Compare the input specification itself too. No name-only or reason-only hit.
3. **A non-secret environment allowlist.** Hash each value, distinguishing absent
   from empty. For a reusable execution, preparation, probes and gate receive
   only these names plus the existing closed runner-bookkeeping pass-through
   from [exact-validation/v1](exact-validation.md#exactly-two-named-exclusions).
   Literal project env names must be included. Bookkeeping cannot affect test
   selection or behavior. A command needing other/secret ambient inputs runs
   without reusable evidence.
4. **Project-declared toolchain versions** in `inputs.toolchains` must include
   at least the gate's **runtime** (for example `node`, `python3` or pnpm's Node)
   and its **test runner or build tool as invoked** (for example `vitest`, `pnpm`
   or `node` itself for node:test). A declaration missing either is not
   reuse-eligible and the gate executes. Observe versions through the finite,
   opaque version-probe commands under the same identity, environment and
   deadline. Digest their declarations and successful version output. Brain
   guesses no `--version` flag, resolves no hidden runtime chain and scans no
   PATH or imports. Missing/failed/changed version evidence is a miss, not
   permission to substitute a tool.

Completeness is the project's reviewed assertion, not Brain's discovery.
Undeclared network, host state or mutable dependencies cannot support reuse;
omit `inputs` for such a gate and execute it. Preparation runs before a reuse
lookup where needed to establish the declared inputs; it is not itself skipped
by a gate pass. A reusable source must have matching input observations before
and after execution. Changed or unstable inputs cannot mint a reusable pass.
Preparation contributing to reusable evidence must use the gate's declared
allowlist; if shared preparation cannot satisfy this for eligible gates, their
evidence is nonreusable. A pass reuses validation evidence, not build artifacts:
when later gates need a build's outputs, the build must execute unless
preparation restores those outputs and they are present among its byte-matched
declared inputs.
On a miss, execute once and record why; do not run a gate again just to create
another receipt.

The redesigned `declared-gate-receipt/v2` key binds canonical Git project and
owner roots, the gate definition/coverage, all the inputs above and their
digests. Verify a completed, originally executed green source receipt, its
immutable log and execution-sidecar integrity under the existing shared receipt
lock. Reused pointers, edited lane pointers and legacy receipts are not source
authority. Recheck inputs before accepting a hit and before integration.
Current required coverage and every Git/identity/readiness guard still apply.
If a reused pass's inputs change before integration, execute that gate once
under the current inputs within the remaining deadline, or hold the attempt.
An unstable input must not create an unbounded recheck/rerun loop.

This follows ENG-419's exact-input principle, but **does not weaken or relabel
`exact-validation/v1`**. That schema retains its full base/candidate-tree
identity and exclusions. B needs this separate receipt version because it can
reuse across commit changes outside the declared gate inputs. Both source and
current commits remain recorded; commit identity alone is neither a hit nor a
miss in B. A changed owner gate definition or any declared input always misses.
No new runner-owned exclusion or inferred scope is authorized here.

## Parked implementation: delete or replace in the implementation round

At `a98dadb4`, the lane implements the superseded
`declared-gates/v1` / `promotion-tests/v2` design. It has not landed.
This docs-only amendment changes none of that code. In particular:

| Existing surface | Required disposition |
| --- | --- |
| `promote/declared-policy.mjs`: `assertPythonFileLaunch`, `policyBinding`, `assertCandidatePolicy`, `assertRunnerPolicy` | Delete launch recognition, source/import scope capture, recipe expansion checks, generated-helper refusals and candidate-orchestration equality policing. Python `-m`/`-c`, aliases and quoted launch spellings need no language-specific guard. Retain any generic cwd containment helper through ordinary shared path validation. |
| `promote/declared-runtime.mjs`: executable discovery, `runtimeIdentity`, `promotionRuntime`, `runtimeBinding`, `dependencyIdentity` and planner PATH filtering | Remove inferred executable/interpreter chains, executable/dependency inventories and PATH/runtime discovery used for policing. Keep bounded-deadline and ordinary declared-environment handling as needed. Only explicitly declared B inputs/probes may produce reuse observations. |
| `promote/declared-gates.mjs`, `declared-runner.mjs`, `declared-planning.mjs`, `declared-planner.mjs` | Replace scope/runtime capture and rechecks with opaque declared command execution, base planning, literal named-gate selection and v2 outcomes. Keep bounds, host admission, logs and immutable binding checks. |
| `promote/declaration.mjs`, `declared-selection.mjs`, queue/train, lane/settle adapters | Replace v1 runner-plus-argv and scope/toolchain requirement bindings with v2 complete gates and declared coverage; version capabilities and durable formats. Keep single authority, requirement unions, identity roots and clean fast-forward safety. |
| Existing declared-mode exact-receipt additions | Do not reuse them as v2 passes. Implement only the operator-selected switch; preserve legacy ENG-419 behavior. |
| `promote/README.md`, format inventory and declared-mode tests | Update in the implementation round. Launch-recognition/refusal witnesses become obsolete; replace them with opaque mixed-command, declared-coverage, recovery, compatibility and chosen-reuse witnesses. Preserve legacy and identity witnesses. |

The final review's static-launch findings are superseded design obligations,
not fixed implementation bugs. Its refusal-only recovery finding still applies
and must be fixed alongside mixed/integrated recovery. Preserve every previous
review and log; the earlier green test receipts do not prove this redesign.

## Out of scope and next acceptance

This run amends the contract and registry only, with no code changes or tests.
The next step is the single authority review on `review-sol-max`, including the
operator's A/B choice; implementation follows that accepted contract.

Implementation acceptance must demonstrate the actual opaque mixed runners,
unchanged command bytes/order and fixture controls; canonical selection and
declared required coverage; identity refusal before effects; conflict/old-reader
refusal and legacy parity; bounded failure/logging; all terminal recovery cases;
and, if B is chosen, pass reuse plus misses for every declared-input dimension.
These are future evidence obligations, not tests selected for this docs run.
BCH owns its configuration, recorded-case comparisons, adoption and ENG-1815
pilot after a capable release.

No launch classifier, Python policy parser, runtime/PATH policing, candidate
script immutability promise, native identity attestation, sandbox change,
cross-identity relay, new dependency or background service is introduced.
Release execution, adoption and lifting project holds remain separate actions.
