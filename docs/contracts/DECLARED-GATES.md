# Project-declared promotion gates

Status: **binding contract for ARCH-38, approved 2026-10-21 on `review-sol-max`;
review `lr-aa342e2099490484937ea7ba9c7baa53` (`af96a9a-r1`), PASS.** Approval
covers the contract; implementation and activation require their own evidence.

The agreed [2026-10-21 plan, sections 2.5 and 3.2](/Users/rewt/development/rewt/.org/proposals/PLAN-20261021.md)
requires a project's train, gates and sessions to run as that project's identity.
The [BCH feasibility report](/Users/rewt/development/bastian/archive/BCD-C-PLANNER-20261021.md)
and its [evidence directory](/Users/rewt/development/bastian/archive/BCD-C-PLANNER-EVIDENCE-20261021)
establish the missing cases: native Vitest files, dependency builds, pnpm recipes,
Python fixture drivers and a planner importing TypeScript. These are source and
historical execution evidence, not acceptance of an implemented adapter.

Normative requirements below apply to the proposed opt-in mode. The existing
[additive planner](../../promote/README.md#existing-additive-planner) remains the
legacy mode. Brain remains dependency-free and model-free; projects own their
test policy, runtimes and commands. No project name or runner extension selects
special product behavior.

## One authoritative declaration

An adopting project declares `schema: "declared-gates/v1"` in
`.lane.validation.json`. That file is the sole authority for its `fast`,
`promotion` and `release` commands, preparation, planner, runners, environment,
toolchain and gate limits. These are logical file names and keys, independent
of their directory. ENG-514 owns their storage, source resolution, history and
config-home migration; this contract introduces no competing loader.

The new declaration retains the command-string tier keys, `environment`,
`timeout_seconds` and `idle_timeout_seconds`. It adds `schema`, a `gate` profile,
`runners`, and the command form of `promotion_tests` below. Existing suite
inventory keys `host_suites` and `tier_suites` retain their meanings. The new
format is closed: unsupported keys, versions or wrong types visibly refuse.
`promotion` and `release` must be explicit nonempty commands in this mode.

| Source | Rule for an adopting project's train |
| --- | --- |
| `.lane.validation.json` | Exactly one resolved owner declaration; capture its complete value and source revision/digest. Invalid, missing or ambiguous resolution refuses, without a fallback. |
| `.promote.json` | Queue/transport policy such as `to`, `delivery_attempts`, `retry_seconds` and `max_batch` remains here. `validate` and `gate` are forbidden, even if equal to the new declaration. Move the entire old `gate` profile into `.lane.validation.json.gate`. |
| `.lane.json` validation/`validate` and `prepare` | Do not merge these into an adopted gate. Explicit competing gate declarations must be removed during adoption; inherited defaults supply no execution steps. Move needed gate preparation into the authoritative declaration. |
| `LANE_VALIDATE`, enqueue `--validate`, saved job overrides | Refuse their use for adopted promotion; never override or silently bypass the declaration. Incompatible queued jobs require explicit drain/disposition and re-enqueue. |
| `LANE_CONFIG`, lane copies and working edits | Cannot redirect gate authority. Lane edits may propose a future rule, but the captured owner declaration governs that lane's validation. |

Admission binds each job to an immutable, owner-authorized declaration snapshot,
using the existing config history and queue receipt. A lane cannot authorize a
replacement snapshot for its own job. A config-home edit after admission is a
mismatch to resolve, not permission to recapture a weaker rule during retry.
An independently authorized owner change requires explicit job re-admission
while retaining its bound requirements. No new approval service is introduced.

An explicit development `lane check --cmd` may still run an arbitrary authorized
local check. Its receipt cannot certify an adopted promotion unless it matches
the complete declared execution and all bindings below. A command override is
never a way to opt out of required selection.

The project owner adopts atomically: consolidate the commands and preparations,
remove competing overrides, and inspect the effective declaration before
admitting new jobs. BCH's ENG-1830 owns its configuration change. Until adoption,
legacy precedence, including `.promote.json.validate`/`LANE_VALIDATE`, remains
unchanged; this proposal does not turn BCH's focused gate on.

## What the project declares

This illustrative declaration shows the shape, not BCH's approved recipes:

```json
{
  "schema": "declared-gates/v1",
  "fast": "pnpm validate:fast",
  "promotion": "pnpm validate:smoke",
  "release": "pnpm validate:all-safe",
  "timeout_seconds": { "promotion": 3600, "release": 7200 },
  "idle_timeout_seconds": { "promotion": 900 },
  "gate": {
    "node_version_file": ".nvmrc",
    "prepare": [
      { "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile" },
      { "run": "pnpm --filter @example/dependency build" }
    ]
  },
  "promotion_tests": {
    "command": ["pnpm", "exec", "tsx", "scripts/promotion-plan.ts"],
    "prepare": [
      { "run": "pnpm install --prefer-offline --ignore-scripts --frozen-lockfile" }
    ]
  },
  "runners": {
    "node-test": { "command": ["node", "--test"], "cwd": "." },
    "vitest": { "command": ["pnpm", "exec", "vitest", "run"], "cwd": "." },
    "pnpm": { "command": ["pnpm"], "cwd": "." },
    "python": { "command": ["python3"], "cwd": "." }
  }
}
```

`gate` retains the existing profile's host-admission keys, Node pin, literal
`env` and ordered `prepare` semantics; its location changes, not its resource
classification. Existing restrictions on host slot paths, tokens and
`NODE_OPTIONS` remain. Project environment declarations confer no identity or
native permission. Existing exclusive/proving admission remains exclusive only
where already declared; ordinary builds and tests remain shared work under the
[host contract](HOST-RESERVATIONS.md).

Each runner has a unique nonempty identifier, a nonempty string argv `command`
and a normalized project-relative `cwd` inside the candidate. Runner identifiers
carry no built-in language dispatch. `node-test` is the declared runner used for
the file shorthand below. Shell syntax in argv is literal; a shell recipe must
be an explicit declared command, rather than interpolated planner output.
Prepare `run` strings retain their existing shell-command meaning. Every
executable and runtime must already be available or supplied by the project's
preparation. Missing tools refuse; Brain never installs a project dependency
into its own bundle or imports TypeScript, Vitest or another project library.

Preparation must use lockfiles/tool pins and run for every fresh candidate;
`unless` must not skip a dependency install just because `node_modules` exists.
Preparation may produce ignored build artifacts, but must not change the
captured tracked tree, HEAD or branch. Project-specific installation/network
policy stays with the project; Brain's own tests remain offline.

## Planner execution and trusted inputs

**Choice: invoke the planner as a declared command.** Brain invokes the
`promotion_tests.command` argv as a subprocess; it does not assume that Node can
load the planner. Thus a project can use its pinned `pnpm exec tsx`, Python or
another runtime without adding a Brain dependency. A command also preserves a
project's existing collector interface instead of requiring a dependency-free
rewrite of its TypeScript inventory.

The following provenance is mandatory, including at settle and when bisecting
or resuming a train:

1. Capture the current canonical base commit, the owner declaration revision
   and the candidate. The canonical Git common-directory realpath identifies the
   project; an identity directory identifies its owning execution identity.
   Neither a project basename nor a remote establishes ownership.
2. Materialize planner code, imports, policy tables, package manifests and
   lockfiles from that base into a private planner snapshot. Run
   `promotion_tests.prepare` in that snapshot, then the planner with that snapshot
   as cwd. Its dependencies and runtime come from that prepared base, never the
   candidate's `node_modules`, package scripts, config or import search path.
   Shared package caches may supply verified locked artifacts, not mutable
   candidate installations. Scrub loader/search-path overrides that could load
   lane code. The planner cannot follow a source symlink out of the snapshot.
   Preparation may create locked dependencies or compiled output from base
   sources; changing tracked planner or policy content invalidates the snapshot.
3. Supply one closed JSON input on stdin with keys `schema`
   (`promotion-selection-input/v1`), `base` and `candidate` (full commit IDs),
   `candidate_root` (absolute inspection path), `changed` (sorted paths),
   `command` (effective promotion command), and `required` (the union of the
   jobs' bound evidence). Changed paths include deletions
   and both rename sides, computed by the train from Git rather than caller
   assertions. Candidate files are inspection data, never executable selection
   policy. The candidate root is execution-local and is not a reusable identity.
4. Accept one bounded JSON plan on stdout. Diagnostics go to stderr and the
   attempt log. Check the base, declaration and candidate again before execution
   and integration; a changed input invalidates the attempt. Replanning must
   retain the job's authorized declaration and requirements; a declaration
   mismatch requires the owner disposition above. A lane changing its own
   planner or dependency lock cannot affect this
   selection. An owner-approved rule update governs later attempts only after
   it is canonical; it cannot approve itself.

Candidate runtime preparation is separate: `gate.prepare` runs in the candidate.
It never supplies the planner's imports. Both preparations, planning and selected
execution belong to the same admitted attempt and log. No subprocess of a more
privileged Brain identity may prepare or plan on the project's behalf.

## Selection and required evidence

The new output schema is `promotion-tests/v2`; it does not widen
`promotion-tests/v1`. `schema`, `files` and `steps` are required, with empty
arrays allowed. It retains `files`, `covered`, `selected`, `deferred`,
`budget`, `graph` and `unknown`, and adds ordered `steps`. For example:

```json
{
  "schema": "promotion-tests/v2",
  "files": ["test/dist-consumers.test.mjs"],
  "covered": [],
  "steps": [
    {
      "runner": "pnpm",
      "args": ["--filter", "@example/consumer", "build"],
      "reason": "dependency build before the selected consumer test"
    },
    {
      "runner": "vitest",
      "args": ["tools/pool-action-modules/test/canonical.test.ts", "--maxWorkers=1", "--minWorkers=1", "--testTimeout=60000"],
      "reason": "bound required whole-file evidence"
    },
    {
      "runner": "python",
      "args": ["tools/example/scripts/test-runtime-no-proof.py"],
      "reason": "fixture driver owns installation, controls and its TS suite"
    }
  ]
}
```

`files` and `covered` retain the unique, relative `.test.mjs` predicate and
whole-file semantics of v1. A `files` entry means invoke the declared `node-test`
runner with that exact path as its argument. `covered` means the mandatory base
promotion command already executes the whole file, as established by the
canonical planner and captured command. A patterned subset cannot cover a file.
Existing `selected` file details keep their v1 meanings.

A step has a declared `runner`, string-array `args` and nonempty `reason`.
Optional estimate fields use the existing positive `estimated_ms` and
`estimate: measured|fallback` conventions. Ordered dependency builds, canonical
pnpm recipes, native suites and Python drivers are all first-class steps; a
driver's complete fixture/control context must survive selection. Replacing a
driver or recipe with a bare suite is not equivalent evidence. A reason is
explanation, never authorization or a coverage claim.

Bound requirements travel with the immutable job/head/run binding, not a new
lane-authored plan. Legacy required file strings remain valid. A typed
requirement is `{runner, args}` plus its captured runner definition and scope
bindings. Equality compares the runner definition, argv, cwd, toolchain and
scope; it never compares only a display name or free-text reason. The train
independently enforces these rules before any gate can be green:

- Every required file is in `files` or in valid whole-file `covered` evidence.
  Every required typed step is present with exactly the bound invocation.
  There is no arbitrary typed `covered` alias in v2. Work intended to satisfy a
  typed requirement must execute as that step, rather than be inferred from a
  recipe name or a passing baseline.
- Bound test paths, flags, worker caps, cwd, fixture controls and dependencies
  cannot be dropped, narrowed or replaced. A patterned Vitest case cannot
  satisfy a whole-file requirement. No deferred entry may satisfy a requirement.
- Canonical orchestration determines scope: planner imports, runner adapters,
  recipe expansions and scope-affecting runner configuration are captured from
  the base. Their code may execute candidate products/tests, but cannot use
  lane-modified orchestration to turn a bound invocation into a smaller check.
  In particular, a candidate `package.json` changing a pnpm recipe is not a new
  coverage definition. An adapter unable to separate these inputs must refuse.
- A batch plans the union of its members' requirements. A bisected subset keeps
  every included member's requirements; retries and restarts cannot silently
  discard them. A changed rule or missing runner that makes an old requirement
  unrepresentable refuses and needs explicit owner disposition, not a waiver.

The planner may add work, never replace the mandatory `promotion` command or
shrink the bound set. Unknown paths or an incomplete graph require a declared
conservative selection that still meets all requirements, or a refusal. There
is no implicit full-gate sentinel, docs-only exemption or selector-driven
execution. A nonempty `unknown` list refuses: a conservative plan must resolve
the uncertainty through explicit selected work before it can be accepted.
The existing observational selector remains observational.

## Bounds, execution and evidence

Planning retains the 20-second subprocess limit and 1 MiB stdout limit. The
canonical source snapshot retains its 10,000-path/64 MiB bound. The existing
Brain affected-source scan retains its separate 10,000-path/32 MiB bound.
There are at most 512 selected obligations in total, counting `files` and
`steps` together; required/covered/deferred inventories are each bounded to
512, with no duplicate identities or overlaps with deferred work. A required
set larger than the hard limit refuses intact; it is never truncated. The JSON
byte bound also bounds argv and reasons. Unknown fields, invalid paths or
cwd escapes, undeclared runners, malformed JSON, duplicate obligations, bad
estimates, failed preparation and nonzero/timed-out planning all refuse visibly.

Optional extras retain finite estimated-time and count budgets. Absent an
explicit canonical budget, v2 uses 300,000 ms and ten obligations, counting file
shorthands and typed steps together; an unmeasured obligation costs the existing
60,000 ms fallback. Optional work must fit both caps or be explicitly deferred;
an oversized plan refuses rather than silently deleting steps. Brain's legacy
defaults remain 300,000 ms and ten files. Required work consumes that allowance
first and bypasses optional caps, including the existing recorded
`required_over_budget` exception; it never bypasses hard validation limits or
execution timeouts. Deferred extras record the reason, estimate and
`destination: release-candidate`. Typed deferred entries retain the same runner
and argv identity as selected steps. Estimates guide selection; they do not
grant additional wall time or turn a timeout green.

The admitted attempt runs planner preparation/planning, candidate preparation,
the mandatory promotion command, selected steps in order, then remaining
`files`. Each command must succeed before the next. All run within the same
existing admission/slot context, foreground process group, attempt log and
green gate. Nested commands inherit the admission rather than acquiring a
second slot. No selection may create a detached execution, separate green
receipt or post-integration validation. Any failure, signal, timeout or changed
tracked tree prevents integration and retains its evidence.

Resolve a finite attempt wall-clock deadline before preparation. Runtime
installation, preparation and execution all consume it; planning also has its
20-second ceiling. Retain the existing bounded host/lock waits and watchdog
configuration, including idle-timeout semantics. Child-runner limits may
shorten but never extend the remaining attempt deadline. Retries/resume use
existing bounded train policy and preserve previous outcomes; they do not
create an unlimited preparation or bisection loop.

The final command line must include the complete canonical serialized selection
as one literal, safely quoted argv value to the gate executor, including the
typed steps. A mutable plan file path or environment variable alone is
insufficient. Execution consumes this validated plan without recomputing a
smaller one. Runner argv is not reparsed as shell syntax. An argv-size failure
refuses; the executor must never omit selection fields to make the command fit.

The attempt receipt retains base/candidate, changed paths, declaration
source/digest, planner source/runtime bindings, required/selected/covered and
deferred evidence with reasons, bounds, ordered effective commands and their
selection, and all exits/timeouts, including on red attempts. Runtime identity
includes actual executable paths/versions and locked dependency identities for
the project's Node, package manager, TypeScript runtime, test runner or Python
where used. Never print environment secrets; retain existing digest/redaction
rules. These are execution facts, not independently accepted status.

Green evidence reuse must bind that entire execution: canonical project and
owner, base, candidate tree, declaration, plan, command order, preparation,
toolchains and environment. A different argv, fixture driver, selection rule or
runtime is a miss. The [exact-validation contract](exact-validation.md) retains
all its core fields and exclusions; project adapters add these bindings rather
than weaken matching. Selection cannot be a runner-owned exclusion. Old
file-only receipts cannot certify typed steps. No additional test run is needed
solely to produce a second receipt for identical proven inputs.

## Execution identity and authority

The owning project's supervisor starts its train worker from that project's
canonical checkout, inside its own identity's native harness context. Sessions
launch from the project's directory with that identity's native configuration
and any already-authorized identity launch prefix. Brain's read-across chat is
not an execution host for another project's commands.

Before executing any declared preparation, planner, runner or session launch,
admission resolves the canonical Git common directory to the owning identity
and verifies the supervisor/worker's existing launch authorization. Bind every
enqueue to its actual enqueuing identity and project, and compare them again
when dequeuing, resuming and integrating. Refuse a foreign, missing, ambiguous
or changed identity before executing project code. Jobs cannot pick another
identity through config, argv, queue JSON or a `launch` override. Identity names
in an environment variable, session display metadata, record actor, directory
basename or a shared OS UID are insufficient evidence. Reuse the native launch
and project/session authorization binding; absent provenance is a hold, never
an instruction to manufacture credentials.

This protects against a confused deputy, rather than granting config files a
new security power. The native sandbox remains the hard boundary, owned by the
operator. A directory/marker/allow-list check is a routing safeguard, not an OS
isolation claim. No identity switch, sandbox widening, inherited Brain access
or credential forwarding is performed by a gate. A config author can arrange
execution only with the owner's already-authorized access. Writing another
project's config never invokes anything with more access than that project
already has; a broader Brain launcher must refuse instead of becoming its
executor. Cross-identity edits/requests retain the plan's owner-request or
operator authority and no-relaying rules. Permission refusals go to the
operator, never to another identity for execution.

## Compatibility, rollback and release evidence

No opt-in means no change: `.test.mjs`-only projects keep the current planner
arguments, predicate, dependency-free snapshot, command bytes, order, limits,
coverage, precedence and receipts byte for byte. The legacy `promotion_tests`
string remains a relative Node planner; only the schema-gated object form
enables the new command protocol. Never infer new semantics from a filename.

The explicit schema/object cannot be silently interpreted as a legacy planner.
Current old validation readers reject the unknown `schema` key. An older
release that ignores new fields must not be admitted to an adopted project:
the owner must verify the selected immutable release supports the declaration
and typed receipt version before starting its worker. Unsupported or unknown
versions refuse visibly; ignoring fields cannot yield a false green. New queue
jobs/attempts carry the declaration mode and version and are not handed to a
legacy worker. Historical v1 receipts remain readable as historical evidence,
without being promoted to v2 coverage.

Rollback first stops admission and drains or explicitly resolves outstanding
jobs under their bound release and declaration. A previously integrated
checkpoint only recovers bookkeeping, without repeating integration or tests.
To use an older release, the owner restores the saved legacy declaration and
overrides explicitly and verifies a gate that still covers every outstanding
requirement; typed requirements cannot be translated by omission. Otherwise
keep that project held on the capable release. Preserve logs and receipts;
never downgrade evidence in place. ENG-514 owns config-history restoration and
the existing release-pin/run-ownership contracts own version handoff.

Brain's release preparation still runs **all offline suites once per release
candidate**, including deferred extras. Focused promotion does not replace that
evidence. Projects keep their own declared release obligations. The supervisor
performs the required authority review before implementation continues in this
lane; neither this proposal nor a development check is that review's PASS.

Implementation acceptance must supply offline witnesses for each runner and
its real context; canonical planner/import/lock/recipe tampering; required-set
omission and pattern narrowing; conflicting declarations; malformed/oversized
plans and bounded preparation/timeouts; foreign enqueue/worker/resume refusal
before side effects; receipt misses on selection/runtime changes; and old-reader
refusal/legacy command parity. BCH owns the recorded-case comparisons and its
ENG-1815 pilot after the capable Brain release and adoption. This document
claims none of those implementation or pilot results.
