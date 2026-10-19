# Exact validation evidence v1

`exact-validation/v1` is an opt-in bridge from an engineer's `lane check --gate`
to a promotion train gate. Evidence is **engineer-attested** local execution,
not a signature or independent acceptance. Review, lifecycle guards, clean-tree
checks and fast-forward requirements remain unchanged. Adapters may add bound
inputs; they must retain every core field. The selector stays observation-only
and never supplies a command.

This implements the ENG-419 contract for T2 review. Activation requires the
project owner's committed declaration and the applicable T2 ruling and release.
Herdr Brain deliberately ships without its own declaration; BCH's stronger
adapter remains separate and must retain its additional bindings.

## Canonical opt-in and execution change

Only `git show BASE:.validation-receipts.json` selects the bridge, where BASE is
the captured full commit of current canonical main. Lane copies, edited files
and untracked files cannot opt in or change the declaration. The declaration
must be a regular mode `100644` file. The closed format is:

```json
{"schema":"validation-receipts/v1","exclude":["settle-review-document"],"environment":["PATH","HOME","LANG"]}
```

All three keys are required. Unknown keys, schemas or exclusion identifiers,
duplicate names and invalid environment names visibly refuse. `exclude` may be
empty. The environment list must not name secrets, credentials or session
identity; owners choose non-secret validation inputs. Values never enter a
receipt, diagnostic or key in plaintext. An absent variable is distinct from an
empty value. Runner-owned names cannot also be allowlisted.

**Opting in changes execution:** prepare steps, the canonical planner and the
check run with only the allowlisted environment plus the closed runner-owned
pass-through below. All other ambient variables are removed. Projects must
explicitly declare needed PATH, HOME, locale, tool settings and non-secret
configuration. An unlisted variable cannot influence a check or invalidate
reuse. Commands can still set variables explicitly. This behavior change is
part of the T2 ruling, not merely a cache optimization.

Without this declaration the existing environment, keys, receipt shape and
`REUSE` output remain unchanged. Older releases ignore the separate file; it
adds no field to the closed `.lane.validation.json` format.

## Core identity

The key is SHA-256 of the JSON identity emitted by `exactIdentity`, containing:

| Field | Binding |
| --- | --- |
| `schema` | `exact-validation/v1` |
| `repo` | Realpath of the Git common directory |
| `base` | Full canonical base commit, proved ancestor of candidate HEAD |
| `candidate` | SHA-256 of ordered recursive Git tree entries (path, mode, kind, object ID), minus enabled named additions below |
| `commands` | Ordered exact command strings; the built-in adapter supplies the final `plannedCommand`, including the base command and any supplemental planner command |
| `toolchain` | Node realpath and version under `node`, `git --version` resolved with the restricted environment, `/bin/sh`, platform, architecture and OS release |
| `environment` | Sorted allowlist, mapping each name to SHA-256 of its value, or literal `absent` |
| `prepare` | Ordered preparation declarations including `run` and optional `unless` |
| `declared` | `validation.environment`, with the gate-profile fingerprint salt appended exactly as in the train |
| `exclusions` | Named v1 exclusions, enabled path exclusions and the complete closed runner pass-through name list |

Toolchain injection is a function parameter for fixtures, never an environment
switch. It cannot drop core fields. Adapter-specific inputs participate in the
identity key too: `exactIdentity({additional: {...}})` and
`validateTree({exact: {base, declaration, additional: {...}}})` append those bound
fields and reject attempts to replace core fields. Commands, prepare steps and salt declarations must themselves
contain no secrets, as with existing validation receipts. Ignored dependencies
and preparation outputs need a declared salt when their identity matters; v1
does not claim to snapshot arbitrary ignored files or the host filesystem.

## Exactly two named exclusions

1. `settle-review-document`: only an **added** mode `100644` blob matching
   `^docs/reviews/[a-z0-9][a-z0-9-]*/[0-9a-f]{7}-r[1-9][0-9]*\.md$`.
   Candidate hashing omits qualifying additions relative to the bound base.
   Reuse independently compares the source tree with the current tree: every
   delta must be a qualifying addition. Modification, deletion, executable
   modes and renames are ineligible, even if a path was previously excluded.
2. `runner-owned-environment`: the following names pass through execution and
   are excluded from environment identity. They are the runner-owned names in
   `lanes/validation.mjs:87` at source revision `ad97e531` (not wildcards):
   `MONITOR_VALIDATION_TIER`, `MONITOR_VALIDATION_DEADLINE`,
   `MONITOR_TEST_SLOT_PATH`, `MONITOR_TEST_SLOT_COMPAT_PATH`,
   `MONITOR_TEST_SLOT_TOKEN`, `MONITOR_TEST_SLOT_OCCUPANCY_PATH`,
   `MONITOR_TEST_SLOT_WAIT_SECONDS`, `MONITOR_TEST_SLOT_TIMEOUT_RETRIED`,
   `BCH_CLOAK_TEST_SLOT_TOKEN`, `BCH_CLOAK_TEST_SLOT_WAIT_SECONDS`.

Every exact receipt records both names and the enabled rules. The pass-through
is strictly runner bookkeeping, never project selection or test behavior. Any
new exclusion or expansion of this list is a **T2 contract change**.

## Evidence and reuse

`validateTree({exact: {base, declaration}})` looks up
`<common>/lane-validation/exact/<key>.json` under the existing per-key lock.
The source must be a green, executed, non-reused `lane-validation/v1` receipt,
with no timeout or signal. Its identity digest and key must match; its full
source receipt must match the ordinary receipt copy; its immutable log hash
and completed execution sidecar hash must verify. The sidecar must attest a
started, finished, successful execution without timeout or cleanup error. The
recorded head must resolve to its tree and contain the bound base. Finally the
source-to-current tree delta must consist solely of named additions.

A hit takes no slot, runs no check and calls no `onStart`. It returns the source
receipt with current `head`, `tree` and tier, `reused: true`, original
`validated_head`, and `exact.outcome: reused` plus `excluded_delta`. It prints
`EXACT_REUSE key=… receipt=…`. A completed green execution adds the exact block
and writes the exact copy. Source and log/sidecar copies are local integrity
checks, not authentication against a malicious repository owner.

Preparation still runs before looking for a hit. Skipping preparation is outside
v1. Resource and timeout policy does not turn incomplete or red evidence green.

## Lane and train behavior

`lane check --gate` requires the lane to contain current canonical main or
refuses `EXACT_BASE_BEHIND`. It removes only qualifying additions from changed
paths, calls the canonical base's planner, builds the train's exact command,
runs preparation and validation with the restricted environment, writes
`.lane/gate.json`, preserves `GATE` and prints `EXACT key=… base=…`.
`lane check --gate --required-tests '["test/review.test.mjs"]'` supplies the same
bound `requiredTests` list as the queue request. The JSON array uses promotion's
validation rules: at most 512 project-relative `.test.mjs` paths, with no parent
traversal. The worker passes their sorted union as the planner's `required`, just
as the train unions each job's bound tests. Required tests participate in command
selection; omitting one can change `plannedCommand` and cause a `commands` miss.
A missing required file or a plan without its required coverage refuses the
worker check before execution. `--required-tests` is only valid with `--gate`.

An opted-in train requires a declared successful planner and a complete plan.
The additive `unknown` array names unresolved paths or sources. A missing or
failed planner, non-empty `unknown`, or an `env` promotion command source refuses
with `SELECTION_UNKNOWN` in the existing notice's `code=` field. The base command
never runs on those refusals. No default full-suite fallback is permitted.

On a miss the selected command runs once under existing execution rules. The
attempt records `receipt_bridge: {outcome, field, receipt}`. Each job's
`.lane/gate.json` is only a diagnostic pointer and never reuse authority. A
multi-lane batch diagnoses `candidate`. Single-lane comparison reports the first
difference in fixed order: `repo`, `base`, `candidate`, `commands`,
`toolchain.node`, `toolchain.git`, `toolchain.shell`, `toolchain.platform`,
`toolchain.arch`, `toolchain.release`, other toolchain fields,
`environment.NAME` in sorted order, `prepare`, `declared`. Changes to exclusions
or adapter fields diagnose `declared`; equal identity with an ineligible source
or tree delta diagnoses `candidate`. A single-lane pointer that is missing,
unreadable or legacy (without `exact.identity`) also diagnoses `candidate`, with
an additive `pointer: missing|unreadable|legacy` marker naming that case; it does
not diagnose a repository mismatch. Actual reuse comes exclusively from verified
shared exact evidence, even when a lane pointer is missing or falsified.
