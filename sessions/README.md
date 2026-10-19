# Session manifests

Stages 1–4 of ARCH-33: manifests, an offline inspector, KEEP-only receipts,
foreground planning, and an explicitly authorized single-action apply path for
starting adopted panes or creating never-adopted chat/supervisor positions.
Node built-ins only. `inspect` and `plan` are read-only. `authorize` writes only a
scope receipt; `apply` can act only on an explicitly enrolled workspace with a
valid receipt and fresh matching saved plan. There is no enrollment CLI, default
apply workspace in this CLI, controller loop, background process, or record writer.
[`setup apply`](../setup/README.md#apply) composes bounded create/start steps from
a saved workspace dry run and defaults its workspace reference to `home`.
All model work is declared as a Herdr session on the subscription; the service
and controller remain model-free. Native harness settings retain permission
ownership. Assertions in a document grant no authority or capability.

```sh
node sessions/sessions.mjs inspect --project /path/to/checkout
node sessions/sessions.mjs inspect --project /path/to/linked-lane --workspace lane/topic
node sessions/sessions.mjs inspect chat.md logs-viewer.md logs-triage.md --project /path/to/checkout
```

The JSON output contains the canonical checkout and Git common directory,
route-layer files, parsed manifests, resolved specs and diagnostics. Invalid
input exits 1. Inspection reads Git, route declarations, manifest files and
context-file metadata (and the folded record for work-item references); it never
expands environment variables or secrets,
evaluates Markdown prose, reads native conversations, or invokes Herdr.
`LANE_CONFIG` retains the existing route loader's explicit-file semantics.

## Format and ownership

One UTF-8 Markdown document contains one `## Manifest` heading and exactly one
fenced block within that section (backticks or tildes), labelled exactly `json`.
Additional fences of any kind in that section are rejected, including `JSON`,
`jsonc` and unlabelled fences. Other prose is opaque.
The root has only `apiVersion: brain.herdr.dev/v1alpha1`, `kind`,
`metadata` and `spec`. JSON documents are limited to 1 MiB and nesting to 64.
Duplicate decoded keys, including escaped equivalents, are rejected before
`JSON.parse`; object scopes have independent key sets.

`metadata` contains `name`, stable `uid`, `namespace` and positive `generation`.
IDs use letters, numbers, dots, underscores and hyphens, start with a letter or
number, and cannot contain `..`; namespace and workspace references allow slash
separated ID components. Generation changes when desired configuration changes,
not on restart. UID uniqueness is checked across the canonical project's
inspected set regardless of human namespace. `status` is never tracked here;
future observed status belongs to the reconciler's own store.

The [templates](templates/) and [example fixtures](../test/fixtures/sessions/)
show every nested field. Fields are closed at every level. In particular,
`command`, `exec`, shell/argument/environment payloads and unknown executable
fields are invalid. `spec` declares:

- `workspaceRef`: `home` for the canonical project's home workspace, or an
  opaque reference such as `lane/topic`. These are desired references, never
  live workspace handles or inferred paths. Future enrollment must bind them.
- `role`, optional `standardSlot` and `paneSlot`: chat and supervisor have one
  `primary` pane (the default when omitted); logs has exactly the declared
  `viewer` and `triage` positions. Duplicate tab/pane positions in the inspected
  set are rejected. A subset of manifests can be inspected independently;
  inspection does not require all slots to be supplied at once.
- `intent`: a typed purpose, with `item` required for an engineer/reviewer
  `work-item`, and an optional authority reference which grants no authority.
- `context`: typed entries with explicit `required` booleans and optional
  positive `limit`. Approved sources are identity instructions, project cold
  start, chat/supervisor/item handoffs, supervisor protocol, run brief, item
  lessons, latest review, workspace event filter, triage contract, committed
  project log cursor, materialized batch/cited reports, project triage status,
  and `file` / `product-file` (the exact serialized names appear in `manifest.mjs`).
  An explicit `path` is project-relative, except `product-file` resolves against
  the installed Herdr Brain product root (or this checkout when running from source).
  Both file sources require a path. Absolute paths, traversal, environment/shell
  expansion syntax, dangling symlinks and symlink escapes are rejected, even
  for optional files. Required missing files fail; optional missing files
  produce visible diagnostics. The inspector checks file presence/type only.
  Calling the validator without a canonical project for a path produces an
  explicit validation error.
  Symbolic sources, bounded materialization/hashes and
  native identity/memory readiness require later context/enrollment adapters.
- `memory`: record-lesson and handoff intent, an optional `claudeMem` domain
  reference with `off`, `optional` or `required` mode, or model-free `none` /
  triage `cursor-only` intent. No adapter is started or credential inspected.
- `permissions`: native owner and profile reference; optional read-only service
  access. This asserts requirements without changing native permissions.
- `logs`: service reference, approved subscriptions, delivery policy, scope,
  cursor start and optional batch policy reference. This starts no log service.
- `lifecycle`: scope, retirement/reset/restart policy, refusal hold and recovery
  handling. Standard slots require `automaticRetirement: never`. Engineer
  sessions park after report, reuse the same session for corrections, retain
  through landing or explicit disposition, and never reset while open/parked.
  Reviewers retain through verdict ingestion and use a new session each round.

`kind: Session` additionally requires a personality profile plus explicit native
instruction text, a named `route`, and
`execution: {"host":"herdr","billing":"subscription","modelApi":"forbidden"}`.
`launch`, when supplied, contains only `harness`, `model` and/or `effort`
**assertions**. Each must equal `resolveLaunchRoute` from the existing layered
routes; they never override it. Shipped defaults omit those assertions so a
project's routes select its model. Example fixtures intentionally assert the
reference routes. A future dispatch freezes resolved settings in its journal;
editing a manifest cannot alter a warm session.

`kind: LogViewer` has no route, model, execution, launch, personality or tools.
Its `viewer` names a product adapter, `brain-structured-events` or
`project-triage-status`, with memory `none`. The latter is the **model-free**
non-home logs/triage reference view; it cannot occupy the home triage position.

The `logs-triage` Session requires home `logs/triage`,
`singletonScope: canonical-project`, lifecycle `replicas: 1`, native
`triage-output-only` profile and exactly
`tools: {"input":"preloaded-scoped-files","allowed":["write-own-triage-output"]}`.
Only one may appear per canonical project, including across different declared
namespaces. Its default is the existing `monitor` route. The record-hygiene
`triage` route and aliases resolving to its preset harness/model/effort are
rejected. No final triage model is hard-coded; replay can choose another route.
These are validated declarations. Later native adapters must enforce the tool
and subscription constraints before activation; inspection never activates it.

## Discovery and defaults

`kind: Workspace` composes complete Session and LogViewer files by reference.
See the [setup module](../setup/README.md#workspace-composition) for its closed
schema, canonical `.sessions/` containment, committed reference rules and
[`templates/workspace.md`](templates/workspace.md). Inspection expands resources
into `entries` and exposes compositions separately in `workspaces`. A valid
committed composition suppresses implicit templates only when its `workspaceRef`
matches the selected workspace. Independently committed top-level resources
remain validated. This adds no enrollment or authority.

Without explicit files or a valid committed Workspace for the selected workspace,
every project gets chat, supervisor, logs viewer and home logs triage templates.
`--workspace REF` selects a non-home workspace's
model-free triage-status template instead. Defaults receive deterministic UIDs
from canonical common-directory identity plus workspace reference and role;
they are stable across linked-lane invocations. Explicit files are inspected
as written, with no interpolation or UID replacement.

Projects may commit `.sessions/*.md` in the **canonical checkout**. Discovery
uses `git ls-tree` and reads blobs with `git show` from a fixed snapshot of that
checkout's committed `HEAD`. Matching template filenames override defaults, and
other committed top-level filenames add desired objects. Nested Markdown is
discovered only at exact paths referenced by a valid committed top-level
Workspace; unrelated nested files remain opaque. For a non-home selection,
override `triage-status.md` rather than `logs-triage.md`.
All project files are validated as written; a project that
declares multiple workspace layouts supplies their distinct references/UIDs.
Working-tree edits and index changes are ignored, including staged new files or
deletions. Each affected discovered path receives a warning diagnostic. Untracked
top-level `.sessions/*.md` files and nested paths referenced by a valid committed
Workspace are also ignored with a warning naming the path. Other nested files
produce no diagnostics, including untracked files.
A linked lane's copies do not affect discovery; only canonical `HEAD` supplies
project manifests. A project without a first commit uses the shipped defaults.
Explicit `FILE` arguments remain file previews read as written. No user
configuration is needed. Canonical ownership comes from Git common-directory
identity and the primary worktree, never a basename, remote or display label.
The engineer-worker and reviewer templates are examples for one authorized item,
never automatically discovered or dispatched.
Explicit worker inspection also verifies that the item exists in the discovered
project record (including the existing `ORG_DIR` selection). Missing/unreadable
records or incomplete tails fail validation; inspection never writes that record.

## Reviewer example and future integration

[`templates/reviewer.md`](templates/reviewer.md) declares a `reviewer` Session
with a `work-item` intent and illustrative item ENG-232. Its `review` route is a
reference resolved through the existing route layers, with no model assertion.
`review-codex`, `review-max` and project-defined routes also use that resolver;
settle can select a project route through `review_route` or `--review-route`.
Validation checks route resolution without imposing a separate route-name list.

The `lane-reviewer` personality points to
[`lanes/docs/REVIEW_TEMPLATE.md`](../lanes/docs/REVIEW_TEMPLATE.md) as the
authoritative instructions. No personality text or receipt schema is copied.
Context declares required identity instructions, the run brief (or review
supplement), item lessons and that template as a required `product-file` source;
reviewer validation requires this exact product source and path. The latest
review is optional for the first round. Projects never copy the personality
template: it is read from the product asset in the installed release or source
checkout, independent of the consuming project's files. Product-relative paths
use the same containment, symlink and file-type checks as project-relative paths;
inspection checks metadata only and never evaluates the file contents.

Reviewers require the native `read-only` profile assertion and exactly
`tools: {"input":"preloaded-scoped-files","allowed":["write-own-review-output"]}`.
This declares read-only context and the designated private review record as the
sole repository output. It installs no profile and changes no native permissions.
A future adapter must enforce that exception at the exact output path or hold;
the authoritative template still controls any separately authorized check budget.

Reviewer lifecycle uses `afterReport: park-awaiting-verdict-ingestion`,
`retainUntil: verdict-ingested-or-explicit-disposition` and
`reset: never-before-verdict-ingestion`, with `resetWhileParked: false` and
known-session recovery only (otherwise explicit recovery disposition).
`corrections: new-reviewer-session` means each review round gets a fresh reviewer
session and distinct UID. It never reuses the reviewer for engineer corrections;
the warm correction chain belongs to the engineer.

The future controller integration point is where settle calls `lane review`
today: start the reviewer manifest there after rendering the authoritative
personality with the fixed target, private output path and review supplement.
Settle keeps owning the verdict, receipt and ingestion. This example changes
neither settle nor `lane review` launch behavior nor the `lane-review/v1` format;
the current inspector and planner cannot launch this reviewer. The planner emits
an explicit `Observe` row for reviewers, without matching engineer runs, freezing
bindings or fencing other slots.

## Canonical KEEP receipts

`receipts.mjs` exports `readStandardSlots(common)`, `slotReceiptFile(common)` and
`recordStandardSlot({cwd, action, uid, actor, why, slot?})`. These are offline
storage helpers, with **no live enrollment CLI**. A future authorized enrollment
must first prove native workspace/tab/pane ownership using the existing checks.
Nothing in this lane writes a real receipt.

History lives at `<git-common-dir>/sessions/standard-slots.json`, outside the
display registry and tracked manifests. Schema `standard-slot-history/v1`
binds the exact canonical common directory and an ordered operation list.
An `adopt` operation carries a stable UID and a `slot` with server endpoint
reference, workspace ID, canonical checkout path, tab ID, standard slot and
every `{pane, paneSlot}` binding (one primary or both logs positions). Every
operation records actor, reason, sequence and timestamp. `withdraw` names an
existing UID, records explicit disposition, and preserves adoption history.
The writer validates the full history, takes a directory lock, atomically
persists it and fsyncs the file and directory before acknowledging; an abandoned
lock needs inspection, not automatic reclamation.

Reads are KEEP-only. Missing receipts preserve existing retirement behavior;
unknown schema, malformed/duplicate JSON, symlinked/unreadable evidence or wrong
canonical identity keep the project. Active slots keep their tab/panes and
enclosing workspace/lane, even after panes disappear. Server references cannot
grant release: a receipt conservatively keeps matching IDs across endpoints.
Withdrawal only removes this KEEP input and never bypasses holds, warm chains,
native identity, live references, focus, processes or guarded Git removal.
The executor freshly observes both receipt and record evidence before acting.

An acknowledged `create-standard-slot` in the existing controller journal also
derives a protected adopted slot, with `controllerOperation` naming its source.
An intent alone never enrolls a tab. These derived slots and replacement KEEP
layouts are excluded from the original enrollment digest, so a scoped
authorization survives successful creation. An entirely unenrolled workspace
still stays `workspace-not-enrolled` in setup; this is no implicit enrollment.

Offline tests: `node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/sessions.test.mjs test/retire.test.mjs test/retire-paths.test.mjs`.

## Foreground reconciliation and planning

```sh
node sessions/sessions.mjs plan --project /path/to/checkout
node sessions/sessions.mjs plan --project /path/to/linked-lane --workspace lane/topic
node sessions/sessions.mjs plan chat.md worker.md --project /path/to/checkout
```

`plan` reuses `inspect` for discovery, parsing, committed overrides, routes and
item validation. It reads canonical slot receipts, the event fold, dispatch
journals and their watcher receipts, report availability through `readReport`,
the existing watch notice inbox, declared references and promotion queue. It
checks the discovered record's `STOP` and the canonical checkout's
`.lane/supervisor/STOP` and `HOLD-WORKER-TAB-CLOSE`. Hold existence includes
dangling symlinks; uncertainty holds. It never reads hold contents. Dispatch
and report reads are limited to desired work items in this canonical project.

`observe.mjs` uses the existing dependency-free Herdr socket client. Its live
surface consists of `session.snapshot` and `agent.get` for named agents. It
compares pane, terminal, tab, workspace, name, native ID and checkout between
the two reads; a race or incomplete snapshot holds. It reads no pane content,
native conversation or credentials, and subscribes to no events. The server
identity is the exact socket path (`HERDR_SOCKET_PATH`, otherwise the existing
client default); `plan({env})` applies that resolution to its supplied environment,
including the default observer. An endpoint label is not an alias granting ownership.

Enrollment starts with the active canonical standard-slot history. Bound
replacement layouts add KEEP from the validated controller incarnation journal;
the original layout receipt remains protected. `home`
means its canonical checkout. Other workspace references resolve to an exact
native workspace ID or a Git-verified branch at the receipt's checkout. A
branch with multiple enrolled workspace IDs is ambiguous and holds. Labels,
tab names, display sidecars and phase strings never enroll or authorize work.
A slot receipt binds a layout, **not** an arbitrary native occupant. A live
standard session needs an exact controller operation receipt; a work item needs
the matching folded run and dispatch receipt. Unknown occupants are retained.

The JSON contains each desired resolved spec/generation/digest, observed binding
and record/chain evidence when proven, decision and reason, pending generation,
and at most one proposed start or lifecycle action. Reset eligibility/vetoes,
recovery evidence and journal operation state are included when available. Invalid manifests exit 1; holds and
unenrolled workspaces are inspectable decisions. There is no `--apply` option.
Planning creates no lease, directory, journal, status, record event or Herdr
mutation. The status cache is not read at all.

| Evidence | Decision / effect |
| --- | --- |
| No canonical enrollment | `NotEnrolled` / observe; no action |
| Invalid/unknown evidence, lease contention, duplicated identity, changed topology or occupant | `Hold`; fence starts throughout this pass |
| STOP or canonical close hold | Observe only; keep exact occupants |
| Exact live standard incarnation, including idle | `KEEP`; no brief/prompt replay |
| Missing occupant in an existing adopted chat/supervisor pane, confirmed empty with no prior intent | At most one `WouldStart`; later candidates defer |
| Never-adopted chat/supervisor position in an enrolled, exactly owned workspace, with no prior operation | At most one `WouldCreate`; later candidates defer; recorded `never-started` operations do not claim the position |
| Missing adopted tab/pane, prior incarnation gone, or uncertain launch | `Hold` unless stage 4's exact transition evidence resolves it |
| Unacknowledged create without an exact receipt | `Hold`: create intent unresolved; inspect retained tab; never create twice |
| Missing logs/triage layout | Non-fencing `Observe`: creation unsupported: logs layout awaits triage activation |
| Unowned live workspace agent before creation | `Hold`: preserve, never create beside it; exact controller or recorded work-item bindings required |
| Start withheld after intent because evidence changed; delegate never invoked | `Hold` with the durable reason, pending an explicit later operator disposition; stage 4 does not resolve it |
| Post-close respawn or inbox delegate provably never invoked after a final check failed | `respawn-pending` / `inbox-pending` with the durable reason; observe while blocked, then retry that stage once with fresh evidence |
| Missing model-free structured viewer with positive empty-process evidence | At most one `WouldStart`; renders the existing foreground viewer once |
| Missing triage occupant | `KEEP`; activation belongs to later rollout stages |
| Work item with no recorded run or an abandoned latest run | `Undispatched` / `Observe`; leave unrelated authorized slot starts available |
| Matching live work-item run/dispatch | `NoOp` while running; observation only |
| Report available and quiet worker, including ingestion delay or malformed report | `ParkedAwaitingReview` / `KEEP`; show folded review/correction/integration chain |
| Supervisor `dispatch --reuse`, new run/report, same item/native ID/terminal/checkout/route | Observe running correction, then re-park after its report |
| Changed spec/generation during an existing incarnation | Show `pendingGeneration`; freeze the recorded generation and occupant |

`reconcile.mjs` contains the read-only `planSessions` policy and the test-only
`reconcileOffline` single-pass runner. Observation input is
`{server, complete, workspaces, tabs, panes, agents, receipts, errors}`; receipt
claims contain `{operationId, uid, generation, specDigest, binding}`. A complete
binding contains server, workspace, tab, pane, terminal ID, native session ID,
agent name and canonical checkout. Only an observation adapter with positive
empty-process evidence may set a pane's `emptyConfirmed`. The default socket
observer leaves it unset. An explicit `--evidence FILE --workspace REF` enables
`live-observe.mjs`: it checks the scoped experiment descriptor and enrolled
endpoint, then sandwiches `pane process-info` between matching `pane get`
reads. Only a sole foreground shell in the exact enrolled checkout can be empty.
The shared launcher subsequently proves shell readiness before input.

`reconcileOffline` still requires `{offline: true, start(operation)}` and a fake
`create(operation)` when testing creation. `apply`
uses the same journal executor with `live.mjs` adapters. Native arguments and
readiness remain owned by `supervisor/chats.mjs`, whose existing argument builder
also serves the exact chat/supervisor opener and native resume. The adapters never
invoke lane dispatch, start a worker, create a recorded run or replay a work brief;
worker dispatch retains record-worker and watcher-before-prompt ordering.
All new physical Herdr calls pass through `supervisor/herdr-edge.mjs`.

## Reset and recovery (stage 4)

`lifecycle.mjs` supplies the single-pass policy; `lifecycle-evidence.mjs` verifies
handoff bytes and journal shapes. The offline harness can exercise the full
lifecycle contract. The authorized apply path supports chat and supervisor
standard slots, a one-shot structured viewer render, and a stage-8 logical-role
inbox transfer. Reviewers remain `DeclarativeOnly`; **all work-item sessions are
observation-only in apply**, including recovery. Triage and multi-pane logs
rotation remain held until their own activation stage. No native profile is
installed or changed. Unsupported required context or memory enforcement holds;
optional memory is explicitly disabled in materialized context.

Snapshot absence alone cannot prove process exit, restore ownership, quiescence
or a completed handoff. Experiment evidence must record those assertions with
source references; fresh native process/topology checks still apply. Known-native
resume additionally verifies the prior launch owner's immutable context receipt,
route, manifest digest and native reference. For Claude, planning checks only
the known session ID's transcript file metadata under the launch configuration's
`projects/<checkout-slug>/<session-id>.jsonl`; it never opens the file or searches
other projects. An absent file holds with
`native session has no persisted conversation; resume impossible; use declared-boundary reconstruct`.
Apply rechecks before native input. Codex has no equivalent cheap direct-ID file
check in this adapter; its recovery behavior is unchanged. The new
terminal/incarnation is observed before acknowledgement. Unknown/lost acknowledgements hold without an
automatic retry.

A reset request in `facts.resetRequests[uid]` names a boundary and a handoff.
`persistHandoff({file, markdown, recordRefs, unresolvedMessageIds, inboxCursor})`
writes a Markdown file and fsyncs it and its directory. Its descriptor contains
the absolute `.md` path, content SHA-256, references, unresolved IDs, cursor and
a canonical digest over that complete descriptor. Use a separate retained path
for each handoff. The planner re-reads the regular file, rejects symlinked paths,
checks its content hash, checks the metadata digest and resolves record IDs.
It never reads a native transcript. Supplied prose grants no authority.

Each participant needs `facts.quiescence[uid]`: an exact `binding`, receipt
`ref`, current `recordSeq`, `callbacksQuiesced: true`, explicit empty `openWork`,
`openReviews` and `inFlightDeliveries` arrays, `pendingInboxIds`, `recordRefs`,
`unresolvedMessageIds` and `inboxCursor`. Handoff coverage must agree, pending
inbox IDs must be retained among the unresolved IDs, and live callback/delivery
references veto the operation. Exact `recordSeq` equality is required only for
initial eligibility. Preparation copies these receipts and handoff coverage
into the durable operation. Subsequent steps recheck callbacks, open work/review
and deliveries tied to the frozen incarnation, exact topology and handoff bytes;
they do not require the project-wide revision or the full quiescence snapshot
to stay unchanged. Unrelated record events and new logical-inbox arrivals do
not strand a closed tab or change the operation's frozen pending message set.

Chat/supervisor require a boundary `{kind: "handoff", ref, declared: true}`.
A supervisor also requires `draft: "complete"` or `"fallback"`; the latter is
the explicit failed-draft fallback with authoritative references still present.
An idle response or arriving report is not a boundary. A work-item reset request
always holds; an open review/correction/integration chain vetoes reset even
when the worker is idle and the supplied quiescence claims otherwise.

The home logs rotation is requested by the `logs-triage` UID with
`{kind: "committed-batch", ref, committed: true, batchRef, cursor, viewerCursor}`.
The cursor must match the handoff's service cursor. Both declared manifests,
both exact owned panes, committed batch evidence and quiescent delivery are
required. Respawn recreates both panes and carries the viewer position and
service cursor. No logging service is stopped or second triage replica created.
An extra or foreign pane vetoes the entire tab close.
The target must also have another tab in the same workspace. Herdr removes a
workspace when its last tab closes, so a last-tab close plans Hold with
`last-tab close refused` before any lifecycle intent. Any other tab (including
a second owned standard slot) preserves the workspace; ownership of the target
tab remains mandatory. Apply repeats this check before intent and at the physical
close edge. If a workspace nevertheless vanishes after close, the controller
names `unexpected workspace removal`, holds, and never respawns into a substitute
workspace. Exact tab/pane/agent absence alone cannot acknowledge that close.

The fake executor rechecks before and after journaling intent, closes only the
fully owned exact tab, and requires both an exact close receipt and an observed
absence of that tab, its panes and its processes. Only a later pass may respawn
the same manifest generations/specs with the verified handoff. New tab, pane,
terminal and native-session identities are required for a context reset.
Every new binding is fsynced in `incarnations` before the fake `transfer`
delegate receives pending inbox IDs. The original slot receipt, start operation,
work-item run and frozen historical binding are retained. A consumed boundary
cannot reset again. A new boundary needs new evidence.

Recovery takes an exact-binding entry in `observation.losses` with
`state: "confirmed-exit"`, `ref`, `processConfirmedGone: true`, explicit
`restore: {state: "none" | "pending" | "resumed" | "unknown"}`, nonnegative
`failures` and `backoffReady: true`. Disconnect, absence, unknown restore,
pending native restore, repeated failures (two or more), missing backoff or
any refusal holds. `facts.recovery[uid]` provides a mode, verified context
receipt (`contextRef`, `contextHash`, `contextVerified: true`), exact native
session reference and matching frozen route. The adopted restart policy must
authorize native resume; no per-crash permission question is introduced.
The viewer uses its saved cursor/context receipt and backoff, without a native
model-session reference. A viewer restart leaves its sibling process intact.

When Herdr has resumed the known reference, `restore.operationId` correlates
an exact `native-restore` receipt. The controller binds that observed new
incarnation without invoking `resume`. Otherwise it may invoke the fake resume
once, requiring the known native ID and a new terminal/process receipt.
Parked review intent and open chain remain attached; no correction dispatch
or brief replay occurs. Fresh `mode: "reconstruct"` is labelled **context
loss** and follows guarded close/respawn. Standard sessions require their
declared boundary and complete handoff; an open worker additionally requires
`disposition: {ref, run, contextLossAccepted: true}` from its record adapter.
Reconstruction preserves the outstanding review intent and never claims the
same warm process survived.

Fake actions extend `{offline: true, start}` with `close`, `respawn`, `resume`
and `transfer`, each receiving the journaled operation. At most one delegate
is invoked per pass. Returned values never acknowledge anything. Observation
receipts carry the operation ID and UID: `close` includes exact `target` and
owned `bindings`; `respawn`, `resume` and `native-restore` include `contextHash`
and all `incarnations` with IDs, previous incarnation IDs, frozen generation,
spec digest, binding, route and verified context hash; `inbox` includes exact
message IDs, cursor and destination incarnation IDs. Duplicate, missing or
conflicting receipts hold. An ordinary lost reply stays an intent until fresh
exact evidence resolves it, with **no second close/spawn/resume/transfer**.
An error carrying `refused: true` is a durable terminal failure. Before close,
a missing delegate or changed final evidence is durably `withheld`, pending an
explicit later operator disposition. After confirmed close, if the respawn or
inbox delegate was provably never invoked, the runner journals `respawn-pending`
or `inbox-pending` with its reason. STOP/close holds remain observe-only. Once
the brake or evidence issue resolves, a later pass can invoke that stage once;
it never re-closes the tab or rebinds an already-created replacement. The plan
explicitly shows a closed session awaiting respawn and the pending reason.
Uncertain adapter outcomes and actual refusals still hold after close too;
they never gain this retry path.

## Controller runtime evidence

All paths are under the **canonical Git common directory**, shared by linked
checkouts, next to the earlier slot receipts:

| Path relative to common directory | Purpose |
| --- | --- |
| `sessions/controller.lock/owner.json` | One project lease; contention or abandoned ownership holds, with no automatic stale-owner reclamation |
| `sessions/controller-journal.json` | Durable start/reset/recovery intent, transition history, handoff hashes, quiescence receipts, exact acknowledgements, immutable historical bindings and new incarnation receipts |
| `sessions/controller-status.json` | Disposable recomputed projection; Disposable; written by the journal executor after a permitted pass |

The runner holds the lease for one pass, re-observes before intent and after
intent, fsyncs intent before calling the selected action adapter, then re-observes
the exact receipt and live binding before acknowledging. A lost reply remains
an unresolved intent until fresh receipt evidence proves that incarnation.
An adapter return alone is insufficient. No intent is retried, even when its
target appears empty; ambiguity fences other starts too. Each pass invokes the
delegate at most once. Status loss/corruption cannot launch or grant ownership:
it triggers ordinary observation from manifests, receipts and record facts.
Journal loss with a live occupant yields unknown ownership and holds.

Start operation states are `intent` (invocation/acknowledgement may be uncertain),
`acknowledged` (fresh exact receipt and binding agree), and `withheld` (the final
evidence check prevented delegate invocation). A withheld start is fsynced with
its reason before returning and surfaces that reason in subsequent plans. It
still holds, even if later evidence changes, pending an explicit later operator
disposition. Stage 4 supplies no resolution command and never clears or retries
that start. An undispatched work item has no ambiguous
incarnation and does not engage the project-wide ownership/launch hold fence.

Lifecycle history starts at `reset-prepared` or `recovery-required`, then uses
`close-intent` → `closed-for-reset` → `respawn-intent`, or `resume-intent` /
observed native restore, followed by `restarted` → optional `inbox-intent` →
`acknowledged`. A provably uninvoked post-close delegate can move from
`respawn-intent` to `respawn-pending`, or `inbox-intent` to `inbox-pending`, then
back to that intent after fresh checks. Missing post-close delegates use the
same pending states. Every pending edge retains a reason and requires the
prior close/binding receipts. `withheld` and `failed` retain their reasons and
hold pending an explicit later operator disposition, including pre-close
lifecycle failures; they are not automatically resolved here. Intent
is fsynced before each delegate. `readControllerJournal` rejects unknown states,
invalid transition order, malformed handoff metadata/receipts and broken
incarnation links. Older stage 3 journals without `incarnations` remain readable.
Status remains disposable; these states record operation evidence, never item
status or permission. STOP and the canonical close hold fence every action,
including respawn, native resume and inbox handover after a successful close.

The first exact work-item observation freezes its spec in the operation
journal; it does not dispatch or adopt a new worker. The record and dispatch
receipt remain necessary on every pass. When no earlier manifest evidence
exists, the observed generation is unknown until that first observation;
an edited generation above 1 or native route disagreement stays pending and
cannot establish the live spec. A terminal
record disposition remains subject to every existing safe-retirement check;
this observer never grants retirement. ENG-338's KEEP-only protections and
all existing watcher/notice paths remain unchanged.

Focused fixtures (at most four files per group):

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/session-lifecycle.test.mjs test/session-reconciler.test.mjs test/sessions.test.mjs test/retire-paths.test.mjs
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 test/retire.test.mjs
```

Run under Node 20.19.4 both in the lane and a git-archive snapshot of the final
commit outside any Git/identity-root ancestry. All mutations target fixture roots.

## Explicit authorization and single-action apply (Wave A2)

These commands are implementation surfaces, **not authorization for live use**.
This lane enrolls no workspace and runs no live action. The operator must first
approve one disposable-workspace experiment after independent review and gate.
Only the supervisor, from the canonical checkout and on that recorded say-so,
runs `authorize`. `--operator-decision ID:SEQ` names the **answer note's sequence**
on a human question in this project's record. Accepted evidence is the three
adjacent events emitted by the operator's `record answer ID yes`: a `note.added`
with `decision: true`, `kind: answer`, followed by `item.updated` with
`meta.answer: yes`, `meta.answered_by: human`, then `item.closed` as `done`.
All three must have `by: human`, the same timestamp and consecutive sequences,
and no `unattributed` flag. The question must still be human, closed by that exact
answer, with the same affirmative human answer. Auto-category answers
(`answered_by: auto`), named agent answers, supervisor `note --decision`, other
decision kinds, negative answers, reopened or superseded answers are refused.

Before the operator answers, record the exact scope as a JSON **string** in the
question's `meta.session_authorization`, using existing `record set`:

```sh
record set "$operator_decision_id" "meta.session_authorization=$scope_json"
```

`scope_json` has exactly these fields, with values taken from the canonical
project and original enrollment (the following values are illustrative):

```json
{"schema":"session-authorization-scope/v1","common":"/canonical/project/.git","server":"/exact/herdr.sock","workspace":"native-workspace-id","checkout":"/canonical/disposable-checkout","actions":["start-standard-slot","close","respawn","resume","transfer"]}
```

Present this scope with the question for the operator to inspect before answering.
Only the listed action names are accepted; requested actions must be a nonempty
subset. The additional accepted name `create-standard-slot` must also be in the
scope before the answer, and in `authorize --actions`, when workspace apply will
create a position; it is never inferred from start permission. Common directory,
server, native workspace ID and checkout must match
exactly. Scope missing at answer time or changed afterward is refused. The receipt
binds the record path and hash of the answer transaction and approved scope;
every use rechecks that evidence, including a later overrule or reopening.
No approval is inferred from question or note prose, or from a decision reference
alone. `authorize` never observes Herdr,
launches, withdraws enrollment, clears STOP/holds, or writes a record event.

```sh
node sessions/sessions.mjs authorize --project "$experiment_project" \
  --workspace "$experiment_workspace" --role supervisor --actor "$supervisor_actor" \
  --actions start-standard-slot,close,respawn,resume,transfer \
  --operator-decision "$operator_decision_id:$operator_decision_seq" --expires "$expiry_utc"
```

Use the returned `file` as `authorization_file`. Receipts are durable private JSON
under `<common>/sessions/authorizations/`, scoped to common directory, explicit
workspace reference, exact native workspace/server/checkout, original enrollment
digest, allowed actions, actor, operator decision and expiry. Replacement KEEP
receipts may extend layout protection without changing scope. Withdrawing or
changing the original enrollment invalidates authorization. Renewal requires a
new explicit command; there is no automatic extension or fallback authorization.

`--evidence FILE` is a supervisor-captured descriptor with closed top-level fields:
`schema: session-experiment-evidence/v1`, `common`, `server`, `workspace`,
`resetRequests`, `recovery`, `quiescence`, `losses`, and optional
`inbox: {root, recipient}`. Its lifecycle maps use the evidence shapes above;
empty maps/array suffice for a start. It confers no action authority. Exit evidence
must distinguish confirmed process loss from disconnect, explicitly record native
restore state and source reference, refusal/failure count and backoff. No automatic
restore-state inference is made. For resume use
`contextRef: <common>/sessions/contexts/<prior-operation-id>.json` and its canonical
JSON `digest` as `contextHash`. These launch-owned receipts bind UID, generation,
spec digest, resolved route, native ID and actual instruction SHA-256. Missing or
changed launch evidence holds.

```sh
node sessions/sessions.mjs plan "$experiment_manifest" --project "$experiment_project" \
  --workspace "$experiment_workspace" --evidence "$experiment_evidence" > "$saved_plan"
node sessions/sessions.mjs apply "$experiment_manifest" --project "$experiment_project" \
  --workspace "$experiment_workspace" --evidence "$experiment_evidence" \
  --authorization "$authorization_file" --plan "$saved_plan"
```

The saved plan is valid for at most 60 seconds and must match the freshly observed
selection exactly. Apply repeats receipt, expiry, enrollment, manifest, record,
STOP and canonical close-hold checks under the controller lease, after intent and
at the physical mutation edge (including shell-readiness input). Each invocation
considers at most one action: close does not respawn in the same invocation;
respawn binds before a later inbox transfer. Without authorization, output is the
read-only plan plus an explicit refusal, and no controller lease/journal/status
or launch context is created. Expired/mismatched scope, plan drift, STOP, close
hold, unknown occupants and abandoned locks refuse or hold without native input.

`adapter-receipts.json` contains exact post-observation acknowledgements. A lost
native reply leaves intent unresolved, even if an apparent agent exists. Do not
repeat `agent start`, close, resume or delivery to repair it. Inspect evidence and
use an explicit disposition; there is no automatic retry command.

### Disposing a start that was never invoked

`losses` and recovery require a previously bound incarnation. They cannot resolve
an initial start intent with no receipt. For that narrow case, the supervisor can
run `dispose-start`, declaring **never started**, with the full operation ID, a
digest of its exact intent, exact target/terminal, hashed source files, actor,
reason and fresh observation time. Every claim below is required; missing,
unknown or contrary evidence refuses the disposition. A missing agent alone
does not prove that the launcher was never invoked: inspect the failure's place
in the launch path and the recorded evidence first. If an agent may have started
and exited, or a start reply was lost, retain Hold and investigate.

The command requires the canonical checkout, an explicit workspace, supervisor
role and the actor's current `start-standard-slot` authorization. It rechecks
scope, enrollment, STOP/holds, evidence hashes, no receipt/context/binding or
competing operation, exact topology and a sole foreground shell. It reads native
pane/process/agent state twice without sending input, and refuses any agent,
session, pending launch, restore error, changed terminal or uncertain process.
Stability covers the target workspace's identity/worktree, tab, panes, matching
agents and pane/process facts; unrelated workspace and agent churn is ignored.
It keeps the original operation, adds the supervisor evidence and observation
digest, and changes only that operation to `never-started`. No launch occurs.
The next plan may propose a **new** start; normal saved-plan, authorization and
physical-edge checks still apply. A contrary later receipt or occupant holds.

For the stopped A2 trial, operation
`9fc82490-e2d6-4001-8c31-f5b6b33bcc5e`, the source evidence is
`.org/evidence/A2-EXPERIMENT-20261017/` in the identity root. Inspect `RESULT.txt`,
`step1-apply.json`, `controller-journal.json`, `step1-panes-after.json` and
`step1-pane-after.txt`: the parse error occurred in `waitForShell`'s marker call,
before `agent start`; the marker executed and the retained pane was shell-only.
These historical files are not a fresh absence check. The following steps are
for the supervisor after this fix is installed; lane workers must not run them.
Do not change the real journal by hand or reuse an expired authorization.

1. From the canonical checkout, use the existing experiment enrollment and a
   current authorization for `lane/a2-experiment` (the original receipt
   `396e229c-6da6-47cd-bb71-fabccd8dfe90` expires at `2026-10-17T22:30:00Z`).
   If renewal is needed, use the `authorize` command above with the still-valid
   recorded scope/answer `HUM-33:6857`; the receipt actor is `supervisor-herdr`.
2. Capture fresh **read-only** `herdr pane get w3C2:p1`,
   `herdr pane process-info --pane w3C2:p1`, and `herdr agent list` replies into
   separate new files. Inspect them together with the historical failure and
   marker evidence. Stop if launcher non-invocation or present absence is uncertain.
3. Write the descriptor below to a new private JSON file. Use `digest` exported
   by `sessions/lifecycle-evidence.mjs` on the exact current intent for
   `operationDigest`; use the fresh pane's terminal ID and observation UTC time.
   Each `evidence` entry is `{ "file": "/absolute/source/file", "sha256": "<SHA-256 of file bytes>" }`.
   Include all five historical files named above and the three fresh captures.
   The command re-reads the source bytes and performs its own fresh native checks.

```json
{
  "schema": "session-start-disposition/v1",
  "common": "/Users/rewt/development/rewt/herdr-brain/.git",
  "operationId": "9fc82490-e2d6-4001-8c31-f5b6b33bcc5e",
  "operationDigest": "<digest of exact current intent>",
  "target": {
    "server": "/Users/rewt/.config/herdr/herdr.sock",
    "workspace": "w3C2", "tab": "w3C2:t1", "pane": "w3C2:p1",
    "checkout": "/Users/rewt/development/rewt/.worktrees/herdr-brain/lane-a2-experiment",
    "terminalId": "<fresh observed terminal ID>"
  },
  "outcome": "never-started", "launchInvoked": false, "shellOnly": true,
  "agentPresent": false, "sessionPresent": false, "launchPending": false,
  "role": "supervisor", "actor": "supervisor-herdr",
  "observedAt": "<fresh ISO UTC time>",
  "reason": "Marker execution observed; adapter parse failed inside waitForShell before agent start; fresh pane is sole shell with no agent/session/pending launch.",
  "evidence": [
    { "file": "<absolute historical or fresh capture path>", "sha256": "<file SHA-256>" }
  ]
}
```

After inspecting those captures, this helper writes the descriptor with exact
hashes (use `pane.json`, `process.json`, `agents.json` in `capture_dir`). It uses
the oldest fresh capture's mtime as `observedAt`; stale captures must be repeated.
It does not observe or mutate Herdr or change the controller journal.

```sh
node --input-type=module - "$historical_dir" "$capture_dir" "$never_started_evidence" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readControllerJournal } from './sessions/runtime.mjs';
import { digest } from './sessions/lifecycle-evidence.mjs';
const [historical, captures, output] = process.argv.slice(2);
const common = '/Users/rewt/development/rewt/herdr-brain/.git';
const op = readControllerJournal(common).operations.find(o => o.id === '9fc82490-e2d6-4001-8c31-f5b6b33bcc5e');
if (op?.state !== 'intent') throw Error('exact unresolved intent required');
const fresh = ['pane.json', 'process.json', 'agents.json'].map(f => path.resolve(captures, f));
const pane = JSON.parse(fs.readFileSync(fresh[0], 'utf8')).result.pane;
const files = ['RESULT.txt', 'step1-apply.json', 'controller-journal.json', 'step1-panes-after.json', 'step1-pane-after.txt']
  .map(f => path.resolve(historical, f)).concat(fresh);
const d = { schema: 'session-start-disposition/v1', common, operationId: op.id, operationDigest: digest(op),
  target: { ...op.target, terminalId: pane.terminal_id }, outcome: 'never-started', launchInvoked: false,
  shellOnly: true, agentPresent: false, sessionPresent: false, launchPending: false,
  role: 'supervisor', actor: 'supervisor-herdr',
  observedAt: new Date(Math.min(...fresh.map(f => fs.statSync(f).mtimeMs))).toISOString(),
  reason: 'Marker executed; parse failed in waitForShell before agent start; fresh captures show sole shell and no agent/session/pending launch.',
  evidence: files.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })) };
fs.writeFileSync(output, JSON.stringify(d, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
JS
```

4. Within 60 seconds of the observation, run this explicit disposition command,
   using the current canonical authorization path and descriptor path:

```sh
node sessions/sessions.mjs dispose-start \
  --project /Users/rewt/development/rewt/herdr-brain \
  --workspace lane/a2-experiment --role supervisor --actor supervisor-herdr \
  --authorization "$authorization_file" \
  --operation 9fc82490-e2d6-4001-8c31-f5b6b33bcc5e \
  --disposition "$never_started_evidence"
```

5. Re-run `plan` with the experiment manifest and `--evidence` as above. Inspect
   the fresh `WouldStart` selection, then use a separate authorized `apply` with
   that saved plan. Do not loop or automatically renew/dispose/retry after a failure.

Inbox transfer goes through `messages/session-transfer.mjs` and the stage-8
`Receiver.transaction` journal, preserving pending IDs, unanswered threads and
logical-role addresses without a prompt. It holds the receiver's existing
delivery lock as well as its writer lock, excluding an active offer. The committed cursor is
`transport:<journal-sequence>`. Coverage changes or refused/uncertain delivery hold.
The enrolled role must name `project-chat` or `project-supervisor` and bind its
`bindingRef` to the manifest UID. Exact-session replies are never redirected. The receiver still enforces its
existing temporary `brain-transport-*` fixture boundary: **this change does not
activate live transport or install a live inbox importer**. A disposable experiment
must use an explicitly enrolled fixture receiver, or the transfer holds.

## Disposable experiment runbook: research experiments #1 and #3

Do not execute until the operator's reviewed experiment decision is recorded.
Use one isolated disposable workspace and throwaway native conversation, never a
parked worker, home workspace, open review chain, BCH desk, or another identity.
The research requires: “Record version/route/identity tuple before and after every
step; preserve timestamps and source receipts.” Archive the source revision and
installed product/Herdr/harness versions; manifests and resolved route; canonical
common directory, explicit enrollment receipt and authorization; exact server,
workspace, tab, pane, terminal, name and native session IDs; record revision,
callbacks, queue references, STOP/hold observations, saved plans, controller and
adapter journals, context receipts and command results. Save evidence outside any
workspace that teardown may remove. No transcript or credential read is needed.

The layout must contain at least **two owned standard slots in separate tabs of
the same workspace**, for example a chat plus a logs viewer in its owned logs
layout. Preserve the second tab throughout the chat/supervisor reset. In the
HUM-33 trial on 2026-10-18 UTC, Herdr 0.9.3 removed workspace `w3C2` when step 3a
closed its only tab. The controller held, but the exact enrollment and operator
authorization could no longer support respawn. Source finding:
`.org/evidence/A2-EXPERIMENT-20261017/RESULT-step3a.txt` in the identity root.
Do not reuse that vanished workspace's authorization for a replacement workspace;
new exact enrollment and scoped operator authorization are required.

1. **Setup and start (#1).** After approval, the supervisor creates the disposable
   workspace through the existing native workspace opener, proves exact Git and
   native ownership, and adopts both owned standard-slot layouts with
   `recordStandardSlot`. Capture a scoped experiment descriptor and record the
   exact `session_authorization` scope above on a human question. Obtain the
   operator's `record answer ID yes` for that scope, then authorize only those
   workspace/actions until a short explicit expiry. Inspect one chat or
   supervisor manifest; save a fresh plan and apply once. Capture the complete
   observed binding and launch context receipt. Idle must subsequently plan KEEP,
   without a replayed prompt. The research says: “Make at most one missing
   occupant.” Existing launch code owns argv and readiness; worker dispatch stays
   outside this experiment.
2. **Safe boundary (#1).** Save/hash a Markdown handoff, references, every unresolved
   inbox ID and committed receiver cursor. Finish the supervisor draft or record
   its explicit fallback. Quiesce old callbacks; prove no open work/review or
   in-flight delivery depends on the old incarnation. Capture quiescence with its
   binding and record revision. The research's step 7 says: “Persist and verify the
   Markdown handoff, record references, unresolved message IDs and inbox cursor.”
   Commit that exact boundary in the experiment evidence. Independently inspect
   that every pane in the target tab belongs to this layout and that the second
   owned slot's tab is still present in this same workspace.
3. **Close and respawn (#1).** Save a fresh plan and apply only the exact-tab close.
   Capture the close receipt and a fresh snapshot proving old tab/panes/agents are
   absent while the exact enrolled workspace and second owned tab remain present.
   A last-tab refusal or unexpected workspace removal stops the experiment for
   inspection. The research says: “A tab containing another owner or an unrelated pane
   must hold for disposition.” Re-plan, then apply one respawn from the same frozen
   manifest and verified handoff. Capture new tab/pane/terminal/native ID, generation,
   resolved model/effort/route and context hash; inspect handoff inclusion. Bind
   the incarnation before re-planning and applying logical-role inbox transfer.
   Verify the same pending IDs, cursor and unanswered questions survive; exact
   worker replies retain their old address. Do not use native `/clear`.
4. **Exit and recovery (#3).** First give the respawned throwaway conversation
   one minimal recorded turn: type the operator-visible greeting
   `Hello. Reply with hello only.` and wait for its reply and idle readiness.
   This is a real turn in the disposable conversation; capture its completion
   and, for Claude, the known ID's transcript file existence by metadata only.
   HUM-35 trial 2 on 2026-10-18 UTC reached this step without a turn: Claude
   had not persisted the conversation, so `--resume` printed “No conversation
   found with session ID” and the 30 s launch timed out. Source finding:
   `.org/evidence/A2-EXPERIMENT-20261017/RESULT-trial2.txt` in the identity root.
   Determine the installed harness's supported exit command from its own help;
   exit only this throwaway conversation. Capture
   confirmed process exit plus agent and shell evidence without retrying work.
   Distinguish disconnect/readiness uncertainty and native restore
   pending/resumed/none; designate exactly one spawn owner. The research's step 8
   says: “Exactly one layer owns the spawn.” Supply the known native reference,
   prior context receipt/hash, frozen route, failure count and satisfied backoff.
   Save a fresh plan; apply one native resume. Capture the same native conversation,
   new process/terminal/incarnation and rechecked route/context evidence. Verify
   historical bindings and pending intent are preserved. A failed resume holds;
   never substitute fresh context implicitly.
5. **Stop and teardown.** Stop invoking apply on any refusal, timeout, uncertain
   acknowledgement, identity mismatch, missing handoff/context, multi-owner tab,
   STOP/close hold, native restore ambiguity, repeated failure, unexpected model
   wake, changed pending-ID coverage, or any reference to work outside the
   disposable setup. Preserve journals and inspect; never run a second spawn to
   diagnose a lost reply. A HOLD from the supervisor also stops new test runs.
   At completion let the authorization expire (or remove only its exact receipt
   after preserving it); disable further applies. Archive receipts/handoffs and
   transfer state. After explicit experiment disposition, withdraw only the
   disposable slots' adoptions via `recordStandardSlot`, then use existing guarded
   retirement with freshly verified identities and no live references. Never bulk
   close tabs/workspaces, remove another receipt, clear shared holds, delete unique
   work/evidence, or stop the shared server. If guarded teardown refuses, retain
   the disposable resources for supervisor inspection.

Offline validation uses the real adapters with fixture CLI/socket endpoints in
`test/session-live.test.mjs`; it is not evidence that either live experiment ran.
