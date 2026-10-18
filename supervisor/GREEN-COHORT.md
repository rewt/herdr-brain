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

The second principle is recognition by a closed allowlist. Every token of a file
must belong to the supported grammar; falling outside it records unknown reach.
This is a small source profile, not a JavaScript parser that assumes unfamiliar
constructs are harmless. Its supported forms are:

- Semicolon-terminated static relative imports/re-exports, closed constant data
  and constant exports, and standalone literal `import()`/`await import()` loads.
  Constant data comprises scalars, arrays, explicit object fields and numeric
  indexing of a known literal array. Imported arbitrary values cannot be called,
  aliased as loaders or used to infer a script target.
- Named imports of the seven child-process launchers, and `fileURLToPath` from
  `node:url`. No other child-process specifier or builtin import form is accepted.
  Child-process re-exports and exports of launcher bindings remain unknown.
- Fixed `fork` or Node `spawn`/`spawnSync`/`execFile`/`execFileSync` calls. Script
  targets must be anchored by `new URL(literal, import.meta.url)` (converted by
  the imported `fileURLToPath` for argv) or be absolute paths inside the bound
  source tree. A cwd-relative script string is never credited to the calling
  module's directory. Fork argv and process options must be inline literals.
- Closed process options with the explicitly typed keys `silent`, `detached`,
  `windowsHide`, `encoding`, `stdio`, `timeout` and `maxBuffer`. Every other key
  refuses, including `env`, `cwd`, `shell`, `execPath` and `execArgv`, even when
  its value looks literal. Spreads, computed keys, accessors and option bindings
  are outside the grammar.

There are no speculative lexer branches. Code slashes (regex or division),
interpolated templates, escaped identifiers, non-ASCII source and any lexical
error refuse. Functions, general calls, control flow, nonnumeric bracket member
reads, reflection, native addons, shell commands, `eval`, `Function`, `require`
and unsupported code-loader modules all fall outside the accepted grammar.
There is no loader denylist whose omissions imply safety.

Literal repository references are conservative inventory edges even when a file
is unknown. For example, every literal lazy-command target may be frozen while
the function/dispatch implementation itself still refuses; the former broad
lazy-wrapper recognizer no longer makes such a file eligible. The running source
has unresolved execution edges today. ENG-422 must resolve those through ordinary
reviewed refactoring before enablement, rather than widening admission around
them. An unknown inventory or authority edge, missing input or resource limit
refuses as `GREEN_REACH_UNKNOWN`. Changed green modules' affected closures are
also checked. No evidence assertion or override waives uncertainty.

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
