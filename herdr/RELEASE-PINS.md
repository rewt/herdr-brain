# Project release selection

`.herdr-release.json` is a small tracked file in the canonical checkout:

```json
{ "release": "rc-example" }
```

The canonical checkout's **committed HEAD** accepts the selection. This separates
release selection from housekeeping settings (whose schema already rejects unknown
keys) and from runtime queue state. Git's common directory binds the project;
worktree copies, edited/untracked configuration, project labels, and inherited
release/Git selector variables do not select a different pin. A damaged accepted
pin fails closed. No pin, or `{"release":null}`, preserves global `current`.

A verified no-pin fast path uses no Git subprocess. A filesystem pre-check
follows Git markers and `commondir` to the canonical checkout and proves that its
HEAD tree has no pin using hash-verified loose commit/tree objects (including
loose objects in alternates and refs in `packed-refs`). It never infers absence
from the working file or index alone. A committed pin deleted from the canonical
working tree fails closed, including a staged deletion: restore the file or
commit its removal. Packed objects, separate Git directories, unusual configuration
and uncertain metadata retain full Git verification; they never authorize an
absence guess. Pin-present admissions retain the committed-tree verification.

From the canonical project, prepare adoption or rollback with:

```sh
bash /path/to/bundle/herdr/release.sh pin RELEASE_ID /path/to/project
git add .herdr-release.json
git commit -m 'Adopt tested Brain release'
```

The command verifies the release's complete runtime inventory against its build
manifest and requires **READY live acceptance for that bundle's own commit**
before writing the file; it never commits on the project's behalf. New admission
resolvers enforce the same acceptance requirement, including for hand-edited pins.
A prepared pin is not an accepted pin.
Rollback repeats these commands with the previous release id. `unpin PROJECT`
writes a null selection, also accepted by a canonical commit. Pin changes affect
the next admission, while previously admitted work keeps its bundle. Do not edit
a pin from a lane. The installer does not activate projects or accept commits.

The supervisor builds a pin candidate with `build TAG --live`. The harness's
`--summary-file` handoff retains the exact `evidence/summary.json` bytes in
`.release-acceptance.json` before the manifest is written and the bundle is sealed.
The additive manifest `acceptance` field records `ran`, `ready`, counts, candidate
commit, elapsed seconds and the summary's SHA-256. A build without `--live` records
`{"ran":false,"ready":false}` and cannot be pinned. Global activation and rollback
remain available for unpinned callers; they do not certify acceptance.

Existing immutable protocol-1 bundles with no acceptance field have one explicit
compatibility path, using an already retained live summary:

```sh
bash /path/to/new/bundle/herdr/release.sh attest LEGACY_TAG /path/to/summary.json
bash /path/to/new/bundle/herdr/release.sh pin LEGACY_TAG /path/to/project
```

`attest` verifies the complete runtime inventory, `ready === true`, counts and
elapsed time, and an exact `candidateCommit` match. It atomically publishes a
write-once `$HOME_DIR/acceptance/LEGACY_TAG.json` containing the compact result and
summary SHA-256. It never opens the immutable bundle for writing, never overwrites
an attestation and cannot override an explicit non-READY build record. Bundles
without the protocol-1 manifest remain ineligible. Retain the original summary
with the release evidence.

Read back the next admission from any checkout in the project:

```sh
bash /path/to/bundle/herdr/release.sh pin-status /path/to/project
bash /path/to/bundle/herdr/release.sh pin-status /path/to/project --json
```

This uses the admission resolver and reports the canonical committed selection and
HEAD commit, a differing canonical working-tree pin labelled **prepared, not
accepted**, the resolved absolute bundle and manifest commit, READY evidence from
the manifest or legacy attestation with its summary SHA-256, and global `current`.
JSON includes `admissionError` when the selected target is refused; read-back
does not silently fall back to `current`. Installation overrides select the
installation to inspect, just as for pin/attest tooling.

Installed `org`, `record` and `lane` are links to tiny content-addressed Node
resolvers under the installation's `routing/` directory. Their installation root
is baked in; `HERDR_MONITOR_HOME` in a caller's environment cannot redirect it.
They select once and launch an absolute immutable file, using the existing Node,
arguments, cwd and native harness permissions. No shell/harness entry wrappers,
sandbox controls or permission changes are installed. Global activation still
selects `current` for every unpinned caller, including BCH during migration.

Other module entry points have a common project-aware admission command:

```sh
bash /path/to/bundle/herdr/release.sh exec supervisor/supervisor.mjs brief --json
bash /path/to/bundle/herdr/release.sh exec housekeeping/housekeeping.mjs --start
```

Only the canonical supervisor starts real housekeeping. Source commands from
the target project's own checkout or lanes execute that source tree, as bound
by their shared Git common directory. Source commands from other projects and
the mutable `current` paths for record, lane, supervisor, promotion, dispatch and
settlement honor accepted pins. An explicit immutable bundle path means
the operation has already selected that bundle; continuations use that path and
never read `current` or the pin again. Use `exec` when admitting through other
module paths rather than storing a mutable `current` path in an adapter.
`exec` and `arm-watch.sh` honor the module's explicit `--repo`/`--cwd` target;
without a pin they keep the bundle from which that adapter was invoked. Invoke
the adapter through `current` to retain global selection, or through a particular
immutable path for an explicit bundle. Installation environment overrides apply
to build/install/pin tooling, never to these operation admissions.

## Operation inventory

| Entry/continuation | Bundle binding and evidence |
| --- | --- |
| Installed org/record/lane | Resolver selects canonical pin or resolves current once; passes absolute bundle entry |
| Supervisor cold start/entry/checkpoint/handle/promote and restart | Cold start includes `project.release`; promotion authorization receipt includes release; saved promotion requests and their completion notices re-enter that receipt's bundle before project selection; child record/settle/promote commands are module-relative immutable paths |
| Promotion enqueue, drain/resume and mixed-version queue | Every job records release; detached startup picks the saved bundle; a drain transfers work to a different saved bundle only after releasing the shared worker lock; batch members share its lane CLI path; the attempted-batch set travels through handoffs so interrupted versions cannot retry each other forever |
| Promotion validation, host lock/slot children | Train and host receipts include release; host adapter self-spawns via import.meta.url, never argv's mutable path; lane, gate and record adapters are relative to the executing bundle |
| Promotion reconciliation/replacement/cleanup retries | Run inside the saved job's bundle; pending cleanup explicitly re-enters that bundle. Existing completion receipts/locks and reconcile command surface remain unchanged |
| Housekeeping start/loop/tick | Start action, owner receipt and activity include release; detached loop, tidy-tabs, retirement, record and inbox children use absolute bundle paths |
| Dispatch and retry | Journal includes release; retry reads the saved bundle under its lock, then a receiving bundle relocks and reads fresh progress; lane, record and watch children use the bundle paths |
| `dispatch/record-worker.mjs` | Mutable and foreign-source CLI admissions select the project named by `--cwd` (also through `release.sh exec`); capture and its record child then use the absolute bundle. External launchers must save this admitted root in their existing job receipt and use it for retries; this short capture command does not own their job journal |
| Watch direct entry, detach/spawn and cold-start re-arm | Mutable/foreign-source entry selects the project named by `--cwd`; mutable re-arm of a dispatched run first re-enters its saved dispatch bundle. Self/record children derive from import.meta.url; detached startup receipt includes release; supervisor cold-start re-arm uses the dispatch journal's saved bundle |
| Settlement and retry | Journal includes release; existing receipt re-enters that bundle before locking; review, dispatch, record and validation adapters derive from its bundle |
| Validation library/adapter | Gate and onStart evidence include the producing bundle; tree, command and fingerprint identify reusable validation across bundle roots and tiers. Canonical lane CLI, watchdog and slot children use the executing bundle |
| Foreground notice/inbox/autopilot | Existing module-relative owner/children remain in their launch bundle; new autopilot receipt includes release (no policy/notice-format change) |
| Other foreground tools (board, brain, sessions, verify, request, tidy, test-slot) | Admit through `release.sh exec MODULE`; their module-relative children stay in the resolved bundle. Explicit immutable invocations remain supported |
| Direct imports | Internal imports (supervisor entry/context/autopilot, promotion enqueue/train/completion, settlement helpers and reconciliation) run in the importing admitted bundle; journals/receipts use `bundleRelease()` there. An external importer must first resolve and retain an absolute bundle, then import from that root. Importing a module via mutable `current` alone is not project admission; BCH's external imports remain BCH adapter work below |

Overrides such as a test adapter's `--lane-cli` remain explicit command choices;
they are recorded by their existing receipts. They do not change project pin
selection. A bare direct immutable path is likewise an explicit bundle choice.

## Compatibility and retention

The event log fold, promotion queue, train/completion receipts, notice inbox and
housekeeping owner/config retain their existing schemas and lock locations.
Release fields are additive. Older pin-aware releases ignore new fields and
read newer state; each operation keeps its own version through recovery. The
same Git-common-directory worker, queue, promotion, validation and housekeeping
locks prevent concurrent writers. A new release cannot start housekeeping over
another runtime's live owner; the existing different-runtime refusal requires
inspection and a controlled stop before restart.

`.release-manifest.json` is the new distribution-only `herdr-release/v1` format,
with operation protocol 1 and runtime file hashes. Releases built before this
format (including frozen A') are **not eligible project pins**. They keep working
through unpinned global current, including rollback/activation. A pin-aware
maintenance build is needed before a project can explicitly pin that lineage.
Build and pin verify every runtime hash; each new launch checks the manifest
schema, commit, mandatory entry files and acceptance evidence, without rehashing
the runtime payload. New manifests add acceptance fields without changing schema
or operation protocol; older `checkBundle` readers still accept them. Older
installed routers do not acquire the new enforcement until the supervisor installs
the new release's content-addressed router. Read-back should use the new tooling.
No project state migration is introduced. A future incompatible record, queue,
receipt or host protocol requires a bounded project migration and an explicit
coordinated protocol exception; changing a pin alone cannot authorize one.
For first adoption, finish legacy jobs that lack release evidence while their
original runtime is still available, and stop legacy housekeeping before
starting the pinned runtime. Today's `current` cannot prove an older job's
original bundle. Mutable watcher/supervisor recovery refuses legacy dispatch or
promotion receipts that lack a release binding; use the identified original
absolute runtime or obtain a reviewed handoff. New protocol-1 operations retain
that evidence on admission.

The host test slot, ticket queue and occupancy identity remain shared across
versions, with their existing paths, environment contract and identity rules.
No version namespace is added to host resources. Offline fixtures use scratch
HOME, fleet and resource paths.

The release tool has **no pruning command or automatic deletion**. Builds,
activation, project pin changes and rollback retain all complete releases and
all content-addressed routers, so pinned, live and recoverable operations retain
their files. Any future pruning feature must inventory canonical pins and all
live/recoverable operation evidence before deleting; unknown evidence must keep
the release. Manual deletion is outside this lifecycle contract.

## BCH adapter work (read-only appendix)

Read-only inventory on 2026-10-17 found these direct mutable callers. No BCH
files are changed here. BCH owns accepting a pin and updating its adapters.

| BCH caller | Required adapter change |
| --- | --- |
| `scripts/auto-promote/auto-promote.mjs:10` and `review-receipt.mjs:9` | Replace global BRAIN with project admission, persist resolved root per job/receipt, use it for all record/lane/reconcile children |
| `.lane/supervisor/auto-promote.mjs:10`, `review-receipt.mjs:9` and `.pre-reuse-promote.sh:15` | Same installed-runtime changes; remove inherited HERDR_BRAIN_ROOT as implicit selection |
| `scripts/lane/launch-supervisor.mjs:12` | Admit the watcher from the project pin and retain its immutable contrib path with the run; preserve model/effort flags |
| `.lane/supervisor/dispatch.sh:272` and `continue-run.sh:16` | Resolve record-worker once for dispatch and continuation; save the root in existing evidence |
| `.lane/supervisor/focused-checks.mjs:32` and `scripts/cycle-time/reuse-supervisor/focused-checks.mjs:32` | Pass the admitted immutable root to validation, retain it in evidence |
| `scripts/supervisor-bundle/files/` copies of auto-promote, review-receipt, dispatch, continue-run, focused-checks and `.pre-reuse-promote.sh` | Update source templates with the runtime adapters, keeping them synchronized |
| Auto-promote and cycle-time tests that realpath global current | Supply scratch releases and assert per-project admission, adoption and rollback |

`contrib/settle-watch.mjs`, `supervisor/reconcile.mjs`, `lib/cli-help.mjs` and all
notice formats stay byte-identical. The supervisor owns the real Brain/lab demo,
activation and BCH's later agreement; the lane's demonstrations are offline.
