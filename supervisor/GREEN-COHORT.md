# Green clean-PASS cohort

`green-pass` is a separate, opt-in cohort. It uses the existing notice autopilot,
one independent ready review, explicit empty Findings and clean PASS, existing
native worker, and checked promotion. It does not enable itself. `clean-pass`
retains its existing map and behavior.

The governing implementation decision is ENG-396 seq 7939 (supervisor-herdr under
Astra's 20:41 grant), which supersedes R-529's proposed runtime-behavior extraction.
Containment is release pinning: source code runs in Brain, the declared disposable
lab, and the declared cross-project checkout entries. Other projects consume an
immutable release; they receive a change through a checked switch candidate. The
supervisor must revalidate that deployment fact before enabling or extending the
cohort. This checker cannot discover unreported external consumers.

## Configuration and identity

After independent bootstrap review, the supervisor can select the cohort in the
canonical project's `.supervisor.json`:

```json
{
  "autopilot": {
    "enabled": true,
    "cohort": "green-pass",
    "green": {
      "brain": {"repo": "/canonical/brain", "identity": "/canonical/brain/.git", "org": "/canonical/record"},
      "lab": {"repo": "/canonical/lab", "identity": "/canonical/lab/.git", "org": "/canonical/lab/.org"}
    }
  }
}
```

These are real canonical paths, not example names to match. Resolve identity with
Git's common directory, including separate Git directories. The Brain pair must
match the checkout running the checker. Both records must match actual project
discovery without inherited `ORG_DIR` or Git selectors; the identities and records
must be distinct. Admission uses one of those exact pairs, and its lane must share
that identity and record. Mismatch is `GREEN_IDENTITY_MISMATCH`. Pins are rechecked
before each automatic command; a policy change interrupts the sequence.

## Execution reach and refusal

`green-contracts.json` is the protected cross-project entry inventory and contract
path map. Its initial Brain entry is `supervisor/reconcile.mjs`; the lab has no
declared cross-project consumers. Add any new consumer by ordinary reviewed work.
The checker, declaration, authority dependencies and evidence validator cannot
approve their own edits (`GREEN_SELF_AUTHORITY`). Candidate declarations are never
loaded as policy; the Brain base and candidate declaration bytes must match the
running checker.

The first principle is that closure files are frozen for this cohort. The checker
inventories both committed trees and the complete diff, with renames represented
by deletion plus addition. Any edit to the base-or-candidate execution closure of
a cross-project entry refuses as `GREEN_BCH_CONSUMED`. Any edit to the execution
closure of an authority entry refuses as `GREEN_SELF_AUTHORITY`. A candidate
cannot introduce an execution edge into a frozen file through this cohort.

Authority entries are `supervisor/autopilot.mjs`, `supervisor/green-pass.mjs` and
`supervisor/supervisor.mjs`, including the spawned handle/evidence relay. Their
imports, literal repository references and supported subprocess targets are
followed transitively in the running trusted checkout and both Brain Git trees.
This includes helpers such as the paused-housekeeping gate, dispatch metrics,
supervisor entry, status and safe-point modules. Self-authority takes precedence
when a file also serves another declared contract. Candidate modules are never
imported or executed to compute either closure.

The second principle is a closed profile for execution edges, not for all
JavaScript syntax. Functions, closures, classes (including constructors), control
flow, ordinary calls, literals and identifier/numeric member access are known
when they contain no unresolved execution capability. Every body and branch is
scanned; calling a function is never required to discover its edges. This is an
execution inventory, not a JavaScript syntax validator or evaluator. Normal code
validation and independent review remain required.

The execution-edge profile recognizes these forms:

- Static relative imports/re-exports and literal `import()` loads follow their
  repository modules transitively. An explicit leaf-module allowlist admits
  non-loader builtins such as `node:fs`, `node:path`, `node:crypto`, `node:os`,
  `node:url`, `node:util`, `node:assert`, `node:events`, `node:stream`,
  `node:buffer`, `node:timers` and their listed safe subpaths. Bare builtin names
  use the same list. Unknown builtins and package imports refuse; builtin status
  alone grants no admission. Loader/debugger modules including `node:vm`,
  `node:module`, `node:worker_threads`, `node:inspector`, `node:wasi`, REPL and
  test-runner modules are not leaves.
- Only named child-process launcher imports are understood. Namespace/default,
  default-as, class imports and launcher re-exports refuse. Each launcher use
  must be a recognized direct call; escaping, aliasing or shadowing a launcher
  refuses. Shell-launcher calls remain unknown.
- Fixed `fork` or Node `spawn`/`spawnSync`/`execFile`/`execFileSync` calls require
  script targets anchored by `new URL(literal, import.meta.url)` (converted by
  imported `fileURLToPath` for argv) or absolute paths inside the bound source
  tree. Closed constants can hold those values, but aliases, mutation and
  parameter shadowing cannot borrow an outer constant's value. A cwd-relative
  target refuses. Fork argv and process options must be inline literals.
- Closed process options accept only explicitly typed `silent`, `detached`,
  `windowsHide`, `encoding`, `stdio`, `timeout` and `maxBuffer`. All other keys
  refuse, including `env`, `cwd`, `shell`, `execPath` and `execArgv`. Spreads,
  computed keys, accessors and option bindings are outside that grammar.
- Computed member/key accesses with nonnumeric keys refuse, including optional
  chains and stored reads. Reflection and loader capabilities such as `eval`,
  `Function`, `require`, `createRequire`, `process.dlopen`, `process.binding`,
  constructor/prototype reads and global reflection remain unknown. The process
  object has its own explicit metadata/non-loader member allowlist; unrecognized
  native capabilities and escaping/shadowing that object refuse.

The crypto namespace is confined to explicitly listed non-loader properties and
cannot escape into aliasing or enumeration. Its native `setEngine` loader is
unknown, including named-import aliases. This exception matters because Node
20.19.4 permits an engine path to name a shared library, as documented in
[crypto.setEngine](https://nodejs.org/download/release/v20.19.4/docs/api/crypto.html#cryptosetengineengine-flags).

Lexing retains uncertainty without selecting a convenient fallback. Unambiguous
regex literals and division are understood; slash contexts requiring a deeper
statement/expression parse (such as after `)` or `}`), nested regex character
classes and Unicode-sets regexes refuse. Escaped/non-ASCII identifiers and lexical
errors refuse. Unicode display strings/comments are data. Template interpolation
is recursively scanned, including nested templates; it cannot hide a load.

Literal repository references remain conservative inventory edges even when a
file is unknown. Every literal lazy-command target may therefore be frozen while
its computed import/dispatch still refuses. The running source and real-main
probe can retain unresolved launch targets, executable options, computed member
accesses and lexical ambiguity. ENG-422 must resolve those concrete execution
edges before enablement. Ordinary function bodies and leaf imports no longer
make the cohort inert by construction. Any further profile extension requires
ordinary independent review of the affected edge contract.

An unknown inventory or authority edge, missing input or resource limit refuses
as `GREEN_REACH_UNKNOWN`. Changed green modules' affected closures are also
checked. No evidence assertion or override waives uncertainty. Contract rules are
selected by their code; reordering the JSON exclusion array does not change the
self-authority pre-check or assign its code to another rule.

`supervisor/test/green-main.test.mjs` probes committed real `main` with candidate
bytes held only in memory. It records the main commit, a one-line ordinary-module
candidate and inventory/authority refusal controls, plus exact reach diagnostics.
It uses the same read-only execution stage as full admission. An execution-stage
refusal proves full admission cannot succeed; execution-stage success alone does
not waive canonical identity, matching policy bytes, lifecycle evidence or review.
A blocked ordinary control is reported as blocked readiness, even if the fixture
and refusal tests pass. No real Git ref, configuration, record or source is changed.

The other named refusals are declared over contract paths:

| Code | Contract |
| --- | --- |
| `GREEN_BLUE_HOTFIX` | Blue branch/operation or blue hotfix paths |
| `GREEN_HOST_RESOURCE` | Shared slots, lock namespaces and resource admission |
| `GREEN_CROSS_PROJECT_AUTHORITY` | Targeting, enrollment, HOLD and retirement safeguard authority |
| `GREEN_GLOBAL_RELEASE` | Global current, launchers, fallback, installation, migrations and rollback |
| `GREEN_SHARED_RUNTIME` | Notices, identities, queues, receipts and persistent-state semantics |
| `GREEN_NATIVE_ISOLATION` | Native permissions/isolation and file-type/executable-mode changes |

The path map is an explicit conservative contract. Changes that add a contract or
move its authority take the ordinary route and update that map under review.
Unmapped source, configuration or launchers also take the ordinary route. The
closure check does not substitute for independent review of contract effects.

## Lifecycle evidence

Changes in the declared lifecycle areas require `green_lifecycle` in the immutable
engineer report (or its run-bound pending report at initial preflight):

```json
{
  "version": 1, "run": "R-123", "base": "FULL_BASE_COMMIT", "head": "FULL_CANDIDATE_COMMIT",
  "identity": "/canonical/brain/.git", "org": "/canonical/record",
  "controls": {
    "identity": {"file": "evidence/identity.json", "sha256": "SHA256"},
    "hold": {"file": "evidence/hold.json", "sha256": "SHA256"},
    "live_reference": {"file": "evidence/live-reference.json", "sha256": "SHA256"},
    "recoverability": {"file": "evidence/recoverability.json", "sha256": "SHA256"}
  }
}
```

Artifact paths are relative to the run's report directory. Capture them there after
committing the candidate so no self-referential commit hash is needed. Each JSON
artifact names `schema: "green-control/v1"`, its `control`, the same run/base/head/
identity/org, actual `command` argument array, `exit_code: 0`, and a `log` descriptor
with relative file and SHA-256. The log must contain passing TAP cases with these
exact names and `# fail 0`, and no failing cases:

- identity: `foreign-project-kept`, `record-mismatch-kept`;
- hold: `hold-at-mutation-kept`;
- live_reference: `live-reference-kept`;
- recoverability: `dirty-or-unknown-kept`, `unmerged-work-archived`.

Use focused checks exercising the actual changed consumer. Preserve the raw output
and record its real command; do not turn a report assertion into a check result.
The checker verifies all bindings, regular unlinked files, path containment,
digests, case presence and successful result. Independent review judges whether
the controls demonstrate the behavior. Missing, stale, altered or symlinked
artifacts refuse as `GREEN_LIFECYCLE_EVIDENCE`.

The evidence is checked again after settlement. Only the exact independently
hashed generated review document may be added after the engineer evidence head;
any source delta or rebase requires fresh evidence and ordinary handling of the
existing immutable report. The scope receipt preserves reach and control
descriptors for review and promotion inspection.

## Evidence and switch checks

Regular non-executable UTF-8 evidence in `docs/evidence/**` with the declared text
extensions maps to `evidence-only`; it needs no code tests or lifecycle controls.
It still cannot edit authority or a consumed input. Binary, executable or code
evidence takes the ordinary route (`GREEN_BINARY_EVIDENCE`, or native mode refusal).
Generated review documents retain their exact-byte exemption only.

Each code change still carries focused engineer checks and one independent ready
review. Release-wide suites, live acceptance and BCH seam checks run once per
switch candidate in the supervisor's agreed window. Elapsed green soak or a number
of landings never authorizes a switch, global activation or lifting a HOLD.
