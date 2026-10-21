# Config home and adoption

**Status: authority review PASS, 2026-10-21, `lr-71a3c141321ab342b6d4fa5c3ff9c03f`.**
ENG-514 implementation follows this reviewed contract. This document authorizes
no live enrollment, native action, sandbox edit or release.

The governing design is [PLAN-20261021, sections 2 and 3.1](/Users/rewt/development/rewt/.org/proposals/PLAN-20261021.md),
agreed with the operator on 2026-10-21. The reader inventory below was checked
against `7174d4c7`. “Brain” names the product; examples use `brain` as in the
plan, without renaming today's command. All implementation remains dependency-free,
foreground and model-free. Config is policy input; item/run status remains
derived from record events.

## Home, link and project identity

```text
~/.herdr-monitor/
  <identity>/
    identity.json
    .org/                    identity config history, not a project record
    <project>/
      project.json           canonical binding and migration origins
      lane.json
      lane.validation.json   existing separate validation file, when present
      promote.json
      routing.json           when the project has a separate routing file
      housekeeping.json      existing overrides, when present
      pin
      sessions/              project sessions launched by Brain
<canonical-checkout>/.brain -> ~/.herdr-monitor/<identity>/<project>/
```

The four named policy files `lane.json`, `promote.json`, `routing.json` and
`pin` retain their existing content and key meanings. Adoption copies accepted
source bytes unchanged, including the closed `{"release":"TAG"}` or
`{"release":null}` pin object; `pin` is not a bare tag string.
The separate validation file is required by plan section 4 step 0. Existing
housekeeping overrides also have a separate home location so their reader and
editor cannot disagree after adoption. Neither sidecar is merged into
`lane.json`; absent optional files need not be created.

`.brain` is a local directory symlink whose target identifies exactly one
identity/project pair. The target is inside this user's config home; a basename
or a link to an arbitrary directory cannot establish ownership. Adoption adds
`/.brain` to the canonical Git common directory's `info/exclude`, preserving
existing entries. A directory-only `/.brain/` pattern is insufficient for a
symlink. Never commit the link, add it to shared `.gitignore`, overwrite a
tracked `.brain`, or replace an unrelated existing path.

`project.json` is per-project binding metadata, not an index or merged policy
file. Its versioned envelope (`config-home-project/v1`) names the identity and
project components, absolute canonical Git common directory, canonical checkout,
existing record, resolved worktree root, original config source paths and path
bases, and the adoption's record reference. It also identifies which files were
present at adoption and the compatible Brain release required for this binding.
It stores no item status. Names are single safe directory components, with no
traversal, separators or reserved hidden names. A name collision with another
common directory holds and requires an explicit different project name.

Every lookup proves the Git common directory through Git and canonical paths,
using `lib/project.mjs`'s ownership rules. Names, remotes, workspace labels,
session sidecars and environment identity strings never substitute for that
proof. Linked worktrees resolve through their common directory to the canonical
checkout and the same home binding; they need no `.brain` link and their local
config copies cannot replace canonical policy. Missing canonical checkouts,
re-clones with a different common directory, conflicting links, duplicate record
claims or ambiguous folder bindings hold for owner repair.

Records stay at their existing paths, including records outside the checkout.
The home points to them; adoption neither moves nor silently initializes a
replacement project record. For a genuinely new project with no prior record,
the detected adoption scope may include normal record initialization at the
canonical checkout's `.org`; a missing previously bound record is damage, not
a new project. Relative settings preserve their former meaning:
the binding retains each migrated file's original declaring directory for
layer-relative paths such as `archive.dirs` and `worktree_root`; paths already
defined as checkout-relative, lane-relative or command-cwd-relative keep that
base. A move into the home must not redirect archives, worktrees, preparation,
Node pins or context files into the home. New project declarations use the same
documented project bases; identity defaults use the bound identity root.

### Discovery without an index

Discovery enumerates identity folders and their project folders, validates
`identity.json` and each selected `project.json`, and matches canonical common
directories. A link is a local convenience and a cross-check of that binding.
It cannot grant access. Hidden runtime/history directories and the reserved
`brain/` directory are not projects.

Until all entries in the existing `fleet.json` have been adopted, the directory
view is the union of validated home bindings and legacy fleet entries.
An adopted binding wins over its matching legacy entry; contradictory ownership
is an error, never a second project. Unadopted projects retain fleet and legacy
ancestor discovery. Keep reading `fleet.json` for them, including its existing
validation and installation-limit semantics. `HERDR_MONITOR_FLEET` remains the
legacy fleet-directory selector, not authority to select another identity's home.

After the last legacy entry is adopted, fleet views and any exported
`fleet.json` are derived from folders; the export is never a new source of
ownership or a required index. Reads never enroll projects or repair mappings.
An invalid unrelated folder is visible in a fleet view; local operations may
isolate it only when ownership non-overlap is provable, as with today's scoped
fleet reads. Inability to isolate an ownership conflict holds the affected
operation. No discovery loop or new service is introduced.

## Source selection and partial moves

**Home first, repo second, then existing defaults.** Select a whole file at each
scope before applying the existing identity-to-project layering rules. Do not
fill missing keys of a present home file from its stale repo copy: removing a
home key must not resurrect an old setting. Identity defaults come from
`identity.json` first, otherwise the project's currently eligible parent/fleet
`.lane.json` layers. Project values override identity defaults; existing
whole-object replacement and per-route merge semantics remain unchanged.

The metadata records source provenance and bases without rewriting policy bytes.
Routing preserves the selected mode: ordinary discovery uses the existing
identity/project lane layers; a separately selected routing declaration replaces
that one logical route-config file unchanged. Its authority and original path
are explicitly bound at adoption; do not guess a `routing.json` by basename or
add inherited routes to a formerly standalone explicit file. Full config reads
must retain non-routing `dispatch` keys needed by cap consumers, even when
route selection uses its narrower projection.

These are the required reader and editor integrations. “Repo” means the verified
canonical checkout, or the explicitly bound existing source for a separate
routing declaration; it never means the invoking lane's copy.

| Current reader / writer | Home first, repo second | While migration is incomplete |
| --- | --- | --- |
| `lanes/lane.mjs` config layers; `lanes/routes.mjs` discovery and route selection | `identity.json` before eligible legacy parent layers; project `lane.json` before `.lane.json`; `routing.json` before the bound legacy routing file | Each absent home file uses its own legacy source. Both entry points produce the same layers, effective routes and source bases. |
| `lanes/validation.mjs` (`resolveValidation`, `canonicalValidation`) | Home `lane.validation.json` before canonical `.lane.validation.json`; selected lane `validation` / `validate` retains its existing lower precedence | A sidecar can move before or after lane settings. Commands, watchdogs, environment salt and promotion planner remain together with their provenance. |
| `herdr/release.sh` release-tier declaration reader | Owning canonical project's home `lane.validation.json` before its tagged snapshot's `.lane.validation.json` | Resolve/freeze the selected declaration and digest at build admission, before entering the Git-less release snapshot. Release execution/acceptance remains supervisor-only and is not redesigned here. |
| `promote/promote.mjs` promotion settings; `promote/gate-profile.mjs` host profile | Home `promote.json` before committed canonical `.promote.json` | Missing home uses the same fixed committed Git snapshot as today. Present home is validated and frozen once per admission/batch; working-tree or lane copies never become fallback policy. |
| `herdr/releases.mjs` pin/unpin/status; `lib/releases.mjs` pin precheck, `projectPin`, `selectRelease`, forwarding and installed launchers | Home `pin` before committed canonical `.herdr-release.json` | An absent home pin uses the accepted committed repo pin. The fast absence precheck must first check home ownership/presence; it cannot declare an adopted project unpinned by looking only in Git. |
| `dispatch/dispatch.mjs`, `dispatch/session-cap.mjs`; route previews in `bin/org.mjs` | Effective home identity/project `dispatch`, routes and selection policy before legacy lane/routing sources | Resolve one validated config for route and cap checks before opening a lane or launching. ENG-516's additional cap keys stay available under `config.dispatch`; this lane does not implement admission or counting. |
| `settle/settle.mjs`, `settle/config.mjs`, `settle/desks-command.mjs`; `settle/test-plan.mjs` via canonical validation | Home lane/routing and validation files before their respective repo sources | Desk policy, route resolution and validation use the same selected project. `path.dirname(routes.target)` must no longer infer the project root when the edit target is in the home. Frozen job route snapshots remain frozen. |
| `lanes/routes-command.mjs` route/config edits and the desk editor it supplies | Selected home project files before canonical repo files | Once the home binding exists, edits target the home, with the existing lock, revision check and atomic replacement guarantees. Never write a compatibility repo copy by following ambient `LANE_CONFIG`. |
| `lib/archive.mjs`; archive consumers in lane briefs and project summaries | Selected home lane/identity declaration before repo/parent declarations | Carry original declaring-directory provenance through `resolveArchive`; preserve explicit empty arrays and existing default discovery. |
| `lib/lane-removal.mjs` protected paths; `lib/retire-archive.mjs` archival policy; `lib/closeout.mjs` queue policy | Project home `lane.json` before canonical `.lane.json` | These remain project-only safety declarations. Neither inherited identity settings nor caller overrides may activate retirement or weaken protection. Invalid selected policy keeps the project. |
| `lib/fleet.mjs` record/layer/worktree discovery and fleet join/view; `discovery/client.mjs`, `supervisor/chats.mjs`, `lib/retire-runtime.mjs` consumers | Home project binding and selected home layers before legacy fleet/repo discovery | Union discovery deduplicates by common directory. Preserve explicit record ownership checks; no ancestor record leakage or automatic registration. |
| `sessions/sessions.mjs`, `setup/setup.mjs` profile/validation diagnostics and session launch consumers | Home lane/routing, validation and pin before their repo counterparts | Inspection and action see the same canonical binding. Do not mistake home paths for checkout paths or claim native trust from config. |
| `housekeeping/config.mjs`, `housekeeping/housekeeping.mjs`, `housekeeping/command.mjs` | Home `housekeeping.json` before canonical `.housekeeping.json` | Snapshot, editor and each foreground tick agree on the selected file. Existing owner locks bind their original path until a controlled owner restart; migration never starts a schedule or creates a second owner. |
| `supervisor/autopilot.mjs`, `supervisor/status.mjs`, `supervisor/context.mjs`, `promote/guard.mjs`, `lib/project-summary.mjs`, `lib/retire-runtime.mjs` housekeeping readers | Home `housekeeping.json` before canonical `.housekeeping.json` | Pause checks, diagnostics, publication freshness and `release_sessions` must use the same selected settings. Invalid home policy cannot become an enabled/default policy at any of these direct call sites. |
| `messages/journal.mjs` / `messages/mirror.mjs` identity discovery; `supervisor/request.mjs` desk launch integration | The verified owning home identity binding before legacy custom-root discovery; absent home retains existing marker behaviour | Reuse canonical marker checks and add the default identity. Do not change notice formats, desk addressing or infer cross-identity permission from `BRAIN_IDENTITY`. |
| `supervisor/green-manifest.mjs` and reviewed config-input inventories | Selected home files/digests before repo config inputs | A home policy change remains an authority-input change even though it is outside Git; it cannot inherit a source-only review or validation witness. |

Indirect record consumers are inventoried in
[discovery/README.md](../../discovery/README.md#record-resolver-inventory).
`lib/store.mjs` continues to call the discovery seam in `lib/fleet.mjs`; the
BCH-stable store needs no rewrite. Likewise `supervisor/reconcile.mjs` continues
through its existing canonical record checks, without changes to that file.
Installed content-addressed routers must ship the home-aware release resolver
and its dependency closure; pointing only the mutable `current` symlink at new
code is insufficient for an older copied router.

Existing explicit single-file inspection flags remain available and validate
the named file. For an adopted project's effects, a legacy source path recorded
in its migration resolves to the corresponding home file first. Ambient
`LANE_CONFIG`, `ORG_DIR`, Git selectors or a copied routing file cannot bypass
invalid selected home policy or select a config write destination. Explicit,
already admitted per-job snapshots and release bindings retain their existing
immutable meaning; adoption does not silently re-resolve them.

### Validation on every read

Validate file type, bounded UTF-8 JSON, duplicate keys, supported envelope/version,
known key types/ranges and cross-references on every read, including direct
policy readers and command displays. Reuse each domain's validators; extend
them where they currently validate only a projection. Schema-specific handling
of extension fields remains explicit; an unknown permission or executable key
cannot acquire meaning by being ignored. The pin and controller shapes remain
closed. No model, shell evaluation or declared policy-command execution is part
of validation.

Only genuine absence permits the fallback in the table. A present invalid,
unreadable, symlinked policy file, dangling link, wrong binding or unsupported
version holds that project and names the exact file and key in plain words:
for example, `.../lane.json: dispatch.max_sessions must be a positive integer;
this project is held. Fix that value and read the config again.`
For syntax errors name the file and line/location (the root key if none can be
parsed); for cross-file errors name both sources. Never substitute defaults,
an older cached value or repo bytes after an error.

During a partial move, genuinely absent home files use their independently
validated repo sources. Once adoption has recorded a required home file as
published, its unexpected loss is damaged adoption evidence and holds; it is
not an implicit rollback. Files absent in the recorded source inventory retain
normal optional-file defaults/fallback. A valid present home file always wins
even if a compatibility repo copy differs. Show that difference as rollback
information, not as effective config. Holds are derived diagnostics, never stored
project status. Repair is a fresh validated read, not clearing a status flag.

## Identity and permissions

With no custom marker, use one identity named after the operating-system user.
Use their ordinary Git, GitHub CLI, keychain and native harness configuration.
Do not require a marker, wrapper, Git account or visible identity setup for this
case. Folder names and a supplied actor string alone cannot prove the caller's
authority to write.

For a custom setup, find the nearest regular, non-symlinked `.identity-root`
above the canonical checkout/common-directory ancestry, as in
`messages/journal.mjs:identityRootAt`. The canonical marked directory is the
identity root; its directory name selects the identity folder. Ambiguous or
conflicting roots/bindings hold. A linked worktree's physical parent cannot
switch its identity. A home binding is checked against this detection, not used
to relabel a checkout into another identity.

`identity.json` retains the existing parent lane-default keys at their current
level and adds identity-owned metadata: `identity_root` (canonical root),
`defaults_origin` (the migrated parent's original path/base),
`project_access` (explicit source-project to target-project write grants),
`brain_write` (per-project opt-in, default false), and optional `launch`.
Grant entries name canonical project bindings, not just labels. No grants is the
default. Existing project-only safety fields remain project-only.

`launch` is a nonempty array of literal argv words naming a user-provided
launcher prefix; absence means ordinary native launch. Validate it without
executing it, prepend it only at the existing owner launch seam, and record the
resolved prefix with the launch inputs. It is not a command string to evaluate,
a permission wrapper installed by Brain, or permission to replace native harness
profiles. All gates, trains and sessions execute in the project's directory as
that project's identity, including when another authorized identity wrote config.
Preserve the existing job's frozen release/launch inputs across continuations.
Brain never manages Git identities, credentials, native sandbox settings or
operator trust decisions.

| Folder | Permitted writer | Enforcement |
| --- | --- | --- |
| `~/.herdr-monitor/brain/` | Future `brain` identity only | Operator-owned native sandbox; that identity is out of this release |
| `~/.herdr-monitor/<identity>/`, including `identity.json` and identity history | That identity; Brain only for an explicitly opted-in project with a matching operator sandbox grant | Native identity sandbox write lines; Brain cannot grant or edit them |
| `<identity>/<project>/` | The project's agents; sibling projects only under an explicit `project_access` grant | Brain commands verify caller and canonical source/target bindings on every write |

Anyone may read the home. Nothing in it holds secrets: tokens, private keys,
credentials and secret environment values stay in native harness stores and the
keychain. Config may name native profiles or credential references, not copy
their contents. A legacy source containing secrets must be resolved by its owner
before moving; never silently scrub it or copy it into audit history.

Cross-identity grants exist only as native sandbox lines added by the operator,
not as agent-editable permissions in the home. `brain_write` is an additional
project consent requirement and cannot replace that native grant. Until the
`brain` identity exists, orchestration edits no other identity's config.
Brain writes for a project only on the operator's word or that project's own
request, never by relaying another project's request. A refused native action
goes to the operator, never another identity. Inside one identity these command
checks prevent mistakes, not hostile writes by an agent with the same native
filesystem rights; a hard wall requires a separate identity.

## Adopt: config migration and existing supervisor enrollment

`brain adopt <project>` runs from the project's canonical checkout as its own
identity, by that identity's own supervisor when enrolling a live pane. The
argument must resolve to this same canonical project; a linked checkout, foreign
identity, display label or arbitrary `--actor` cannot authorize adoption.
The command detects the record, current config sources, test declarations,
worktree root and suggested routes using existing discovery. Detection never
runs a detected test command or treats suggestions as owner approval.

Adoption is an explicit foreground operation:

1. Prove canonical Git and identity ownership, validate every selected source and
   destination, resolve the existing record, and present the exact detected
   migration and native enrollment scope. Refuse conflicting home folders/links,
   tracked links, unreadable policy, ambiguous records and prepared pin/promotion
   edits that differ from their accepted committed source.
2. Before enrolling live panes, verify the workspace owner's recorded
   authorization for this exact adoption. The operator-approved product design
   is not blanket authorization for every workspace. The owner can authorize the
   bounded enrollment once; an already valid authorization is not asked again.
   BCH's supervisor runs this itself as bastian (plan section 4.2); this lane and
   the orchestration identity never adopt bastian's panes.
3. Freeze the source inventory/digests and path origins, publish byte-identical
   home policy copies atomically, write the binding and excluded local link, and
   record the migration in the existing project record. Retain repo sources as
   readable rollback copies. Moving shared parent defaults into `identity.json`
   does not remove the parent layer while any unadopted project still needs it.
   An existing different identity default is a conflict to resolve, not a file
   to merge or replace during adoption.
4. Under the existing canonical controller lease, freshly prove the native
   workspace, selected standard tabs, every pane in those tabs and the live
   supervisor binding. Save adoption intent/evidence, write canonical
   `standard-slot-history/v1` `adopt` operations through
   `recordStandardSlot`, then acknowledge the observed binding in the controller
   journal. Record completion only after both durable enrollment and read-back
   agree. Partial config migration is not reported as completed adoption.
5. Read back the effective config, record binding, standard-slot receipts and
   controller binding. A fresh setup/session plan recognizes the existing
   supervisor and returns KEEP for it without replaying a prompt. Other holds
   (missing capabilities, native trust, STOP, unknown occupants) remain visible;
   enrollment removes `workspace-not-enrolled`, not every setup refusal.

### Native ownership proof and authority

Use [sessions/README.md, Canonical KEEP receipts](../../sessions/README.md#canonical-keep-receipts),
`sessions/observe.mjs`, `sessions/create-safety.mjs` and the existing
`lanes/lane.mjs` workspace guards. A complete fresh observation must agree on:

- Exact server endpoint, native workspace ID, canonical common directory
  (`worktree.repo_key`), repository root, canonical checkout path and non-linked
  home-workspace identity. The invocation's native supervisor binding must
  belong to this same project/identity/workspace.
- Exact tab-to-workspace membership and the entire tab layout: one primary pane
  for chat/supervisor or both declared viewer/triage panes for a logs layout.
  Every pane and pane-slot must be accounted for, with no unrelated extra pane.
- For each live Session, matching pane, terminal, native agent name and native
  conversation/session ID, checkout and owner. Cross-check workspace, tab, pane
  and agent observations; reject duplicate IDs, mismatches, missing IDs,
  incomplete observations, pending restore/launch and uncertain process ownership.
- Existing slot history, controller operations/incarnations, dispatch ownership
  and record references. Preserve all other tabs. Foreign/manual occupants not
  explicitly covered by the owner's adoption are not claimed; ambiguous or
  competing ownership holds rather than creating beside it.

The authorization evidence binds the common directory, owner identity, record,
exact server/workspace/checkout, selected standard-slot UIDs and tab/pane/live
bindings, purpose “adopt existing workspace and supervisor”, requester, decision
and bounded validity. Verify an affirmative workspace-owner/operator decision
with the existing human-answer transaction checks; agent-authored prose, session
metadata and an unscoped decision ID are insufficient. Capture this scope before
the answer. Changed native bindings require fresh scope/authorization.
The command makes no native input, prompt, spawn, close, reset or resume.

### KEEP receipts, controller journal and sessions authorize

KEEP history alone is insufficient: at `sessions/reconcile.mjs:174` a workspace
without it is unenrolled, while a live manual occupant with only that history
still holds as “unknown or changed standard-slot occupant”. Adoption must solve
both, without turning a KEEP receipt into action permission.

Keep `standard-slot-history/v1` and its closed operation shape unchanged:
stable UID, exact common directory, server/workspace/checkout/tab,
`standardSlot`, every `{pane,paneSlot}`, actor, reason, ordered sequence and
timestamp. Use its lock, full-history validation, atomic write and fsync.
KEEP protection remains after panes disappear. Never fabricate one from labels,
hand-edit history, withdraw another slot or treat withdrawal as a close grant.

Extend the closed `session-controller-journal/v1` operation union with an
explicit `adopt-standard-slot` variant, distinct from start/create. It has
durable intent and acknowledgement, an immutable observed native binding,
the matching KEEP adoption sequence, owner-authorization/evidence references
and hashes, and the inspected desired UID/generation/spec digest at adoption.
The desired spec is a comparison baseline, not a claim about instructions or
model settings already loaded in a manual conversation. Mark the origin as
observed adoption. Existing acknowledged starts remain their original operations
and are verified/reused rather than relabelled.

The reconciler and unowned-workspace guard must recognize a valid acknowledged
adoption as ownership sufficient for KEEP. It is never a synthetic
`validLaunchReceipt`, adapter acknowledgement, launch-context receipt or
successfully executed start. Do not invent the manual pane's original
instructions, route, model or context hash. Unknown launch/context evidence stays
unknown; lifecycle operations requiring it continue to hold until independently
satisfied through the existing authorized lifecycle path. An unresolved adoption
intent holds; repeat adoption observes and reconciles exact durable evidence and
never repeats a native action. Existing pending controller operations, abandoned
locks, STOP or canonical close holds cannot be cleared by adoption.

`sessions authorize` remains a separate step after original enrollment exists.
Its existing closed `session-authorization-scope/v1` action list is unchanged:
do not slip `adopt` into it or manufacture an answer transaction. Enrollment's
owner decision grants enrollment only. Subsequent start/create/close/respawn/
resume/transfer actions need their own valid existing scope receipt, original
enrollment digest, expiry and fresh saved plan. Existing matching authorizations
remain valid only if their original enrollment is unchanged; adoption cannot
silently widen or renew them. Controller effects retain single-action execution,
intent-before-effect and exact acknowledgement checks.

### Idempotence and interruptions

A second adopt of the same config sources, binding and native enrollment changes
nothing: no duplicate record event, KEEP operation, controller operation, link
replacement, timestamp refresh or authorization renewal. New native occupants or
conflicting policy are not “idempotent success”; they hold for explicit owner
disposition. A later config change belongs to `config set` or hand-edit history.
Read-back of an already completed, unchanged adoption needs no renewed write
authorization, even after the original authorization expires; it performs no
new enrollment or other effect.

Use the existing config/record/controller locks for their respective resources;
do not take over unresolved locks. Publication and audit use stable operation
identities so an interrupted pass can recognize exactly what became durable.
A half move keeps valid legacy fallbacks for unpublished files, and protects any
already adopted slots. Resume only missing steps after revalidation; never erase
evidence to restart. No success is acknowledged until config audit and enrollment
are complete. No background migration, fleet-wide adoption or setup auto-enrollment.

## Config commands, provenance and history

`brain config` shows each effective value, its scope (`default`, `identity`
or `project`), exact source file/key and one plain line describing its effect.
Also show canonical project/record and any explicit invocation override or
rollback-copy drift. Report invalid config as held instead of displaying fallback
values as effective. Inspection of a separately named file is labelled as such.

`brain config set <key> <value>` defaults to a project override. An explicit
`--scope identity` selects identity defaults/grants; project commands cannot
silently edit shared defaults. Parse values by their documented type, validate
the complete resulting file and effective cross-references, check owner/grants
and expected source revision under the shared config lock, atomically replace,
fsync and record the change before effects consume it. No shell evaluation.
Invalid input changes no policy. An identical value is a no-op. Existing
routes/desks/housekeeping/pin editors use the same target, validation and audit
path rather than retaining independent repo writers. Pin writes also preserve
the installed/built/acceptance-READY verification before taking effect.

The configuration reference must expose the current keys without renaming them:

| File / keys | Meaning and reference |
| --- | --- |
| `lane.json`: `main`, `worktree_root`, `prepare`, `validate`, `validation`, `registry`, `seams_doc`, `archive.dirs` | Integration, lane preparation/validation and display locations; [lane reference](../../lanes/docs/REFERENCE.md#configuration). Preserve documented relative bases. |
| `lane.json` / `routing.json`: `dispatch`, `routes`, `selection_policy` | Launch defaults, named routes and task-class selection; same lane reference. `dispatch.max_sessions` retains its current cap; ENG-516 owns additional dispatch-cap key definitions/defaults, including the planned default of eight unlanded items. The home loader must carry them intact under `config.dispatch`. |
| `lane.json`: `settle`, `retirement.protected_paths`, `retirement.archival_retirement`, `retirement.closeout_queue` | Review desks/correction bounds and canonical-project retirement controls; [settle settings](../../settle/README.md), [closeout](CLOSEOUT.md). Preserve safety opt-ins and review requirements. |
| `lane.validation.json`: `fast`, `promotion`, `release`, `promotion_tests`, `environment`, `timeout_seconds`, `idle_timeout_seconds` | Declared validation/planner, environment salt and watchdogs; [validation reference](../../lanes/docs/REFERENCE.md). ARCH-38 owns gate selection/execution changes. |
| `promote.json`: `to`, `delivery_attempts`, `retry_seconds`, `validate`, `max_batch`, `gate` | Queue delivery, batch settings and host gate profile; [promotion reference](../../promote/README.md#existing-project-gate-profile). Keep validators for all nested gate fields. |
| `housekeeping.json`: `enabled`, `resume`, `tick_seconds`, `cleanup_seconds`, `release_sessions` | Existing scheduler overrides; [housekeeping reference](../../housekeeping/README.md). Config edits never start the scheduler. |
| `pin.release` | Exact accepted release ID or null for global current; [release contract](REGISTRY.md#host-occupancy-and-installed-releases) and [run ownership](RUN-OWNERSHIP.md). |
| `identity.json`: existing lane defaults; `identity_root`, `defaults_origin`, `launch`, `project_access`, `brain_write` | Identity binding/provenance, optional owner launcher and consent/grants defined above. Native cross-identity grants are displayed, never written here. |

Keep the effective-value descriptions and type/default reference together as one
user-facing config reference when implementing the commands; domain references
above define existing nested keys. Legacy accepted-but-ignored fields
(`entry`, `chat`, `always_args`, validation `host_suites` / `tier_suites`)
retain that compatibility treatment and say “no effect”, rather than acquiring
new behaviour during migration. Adoption metadata is inspected separately,
not edited through arbitrary policy keys.

`brain config history` reads the **existing project's record** for project
changes. Each entry records file and key/scope, old value, new value, old/new
content digests, timestamp, caller/actor, who asked (request/run/item or explicit
operator reference when known), and origin (`command`, `hand-edit` or
`adopt`). Initial adoption records the existing values as its baseline, not
as settings newly chosen by the adopting agent. A revert sets the old value
through the same command and creates normal history; no Git repo is required
in the home.

All identity-level changes go to exactly one record:
`~/.herdr-monitor/<identity>/.org/`, initialized once through the existing
record machinery. They never go to whichever project happened to read shared
defaults first. `config history --scope identity` reads that record; project
history may refer to its identity revision without duplicating the change.
This creates an identity audit record and moves no existing project record.

On each owning-identity config read, compare content digests with the last audited
revision in the relevant record. Record hand edits with the same old/new fields
before using changed policy. The observer is known; the editor/requester is
`unknown (hand edit)` unless independently evidenced, never guessed from mtime.
Repeated reads of the same revision add no duplicate entry. For malformed JSON
or unreadable bytes, record an explicit invalid/unavailable new-value marker,
available content digest and the validation error; do not invent a parsed value
or store raw secret-bearing input. The next valid edit gets its own entry.

This is a declared config-audit side effect of an owning config read, including
display/planning commands; it does not mutate panes or controller runtime or
invoke a model. Implementation must update existing “no record write” claims
where this audit applies. A reader without authority to append the owning record
may inspect/validate and report an unaudited revision, but cannot impersonate the
owner or activate changed policy. An unavailable audit record holds effects.
File replacement and record append must be recoverable across interruption with
the original requester preserved; an unresolved pair holds effects until
reconciled exactly once, rather than losing history or claiming a failed write
succeeded. Older record folds ignore unknown config/adoption event types.

## Compatibility, pin admission and rollback

Unadopted projects keep existing file formats, paths, committed pin/promotion
semantics and discovery, including older Brain releases. This release neither
deletes their config nor requires a home link. Older code need not understand
this contract for an unadopted project.

Adoption is an explicit compatibility boundary. Before completing it, stop new
old-version admissions and account for existing jobs/writers using
[run ownership](RUN-OWNERSHIP.md). Already admitted jobs retain their immutable
release/config snapshots and may finish only where compatible; drain conflicting
writers rather than transfer them implicitly. Retain the current release and
record its compatible home-aware router/bundle binding. Every new launcher reads
back the home pin before admission, verifies the installed immutable bundle and
READY acceptance, and records the resolved release in the existing job receipt.
Do not accept a home pin pointing at a release that cannot read the home.

An older release does not understand `.brain` or home policy. It reads the
retained repo/fleet rollback snapshot and cannot see later home edits. Its session
controller encounters the new closed `adopt-standard-slot` operation and
holds/keeps, as for today's unknown create operation. Other old entry points
cannot be presumed to recognize adoption or enforce a downgrade hold.
Therefore concurrent old writers/direct old launches on an adopted project are
unsupported; the owner must drain/disable them. Supported home-aware launchers
refuse an incompatible downgrade. Do not advertise transparent old-writer
compatibility or fabricate older-readable launch receipts to obtain it.

The rollback path remains available because original repo config, parent layers,
legacy fleet mapping and pin stay readable until a separately reviewed cleanup:

1. The owning supervisor stops new admissions and accounts for bound jobs and
   controller operations. Preserve home files, history, authorization and KEEP
   evidence; do not delete journals to make an older reader proceed.
2. Explicitly choose the retained repo snapshot, or restore the desired values
   from audited history to the legacy paths using their existing validation and
   commit requirements. Report any home/repo differences before selecting it.
3. If old controller code cannot read newer operation evidence, keep session
   mutation held and use forward recovery/a compatible home-aware release.
   Restoring legacy policy does not grant permission to discard enrollment or
   reset the live supervisor.
4. Only after checking policy, record ownership and release admission does the
   owner explicitly disable the home binding/local link and resume compatible
   legacy operations. Record the rollback; a missing file or broken link alone
   never triggers it automatically.

No release swap, adoption or rollback edits native harness config, credentials,
hooks or another identity's files. Required in-repo harness files (including
`.codex/hooks.json`) and `AGENTS.md` stay in place.

## Scope and implementation proof

This stage changes only this contract and its registry row. The authority review
must assess live-pane owner consent, canonical ownership, truthful adoption
evidence, config-audit effects and downgrade/rollback boundaries before product
code starts. The continuation must prove file-by-file partial moves, invalid
home refusal without fallback, unchanged relative bases, linked-worktree
resolution, config provenance/history (including hand edits and interruptions),
default/custom identities, authorized native binding, negative ownership controls,
idempotent second adoption and compatible rollback using offline fixtures.
No live enrollment or model call is a contract-stage test.

Other release lanes own `promote/test-plan.mjs`, `promote/train.mjs` and gate
execution (ARCH-38); terminal-reason changes in `lib/retire.mjs` and the worker
chain at `sessions/reconcile.mjs:136` (ENG-515); and `dispatch/` admission/caps
(ENG-516). Coordinate their interfaces; do not implement those policies here.
The BCH-stable files `contrib/settle-watch.mjs`, `supervisor/reconcile.mjs`,
`lib/cli-help.mjs`, `lib/store.mjs`, `lib/state.mjs`, `lib/report.mjs` and
notice formats stay byte-identical. Changes use their existing extension seams.

Out of scope: public `install`, `scan`, product/command/home rename, merging
config files, creating/activating the `brain` identity, native sandbox/profile
edits, cross-identity live adoption, gate redesign and automatic enrollment by
setup. The operator separately adds any sandbox write lines and verifies native
profile protection. Nothing in this contract performs those actions.
