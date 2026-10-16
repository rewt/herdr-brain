# Session manifests

Stages 1–4 of ARCH-33: a desired format, an **offline inspector**, KEEP-only
retirement evidence, and foreground single-pass reconciliation with an
**inspect-only live planner** and **fake-only reset/recovery**. Node built-ins only. The CLI never launches a
session, prompts a model, enrolls a live workspace, runs a loop, or writes the record.
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

Without explicit files, every project gets chat, supervisor, logs viewer and
home logs triage templates. `--workspace REF` selects a non-home workspace's
model-free triage-status template instead. Defaults receive deterministic UIDs
from canonical common-directory identity plus workspace reference and role;
they are stable across linked-lane invocations. Explicit files are inspected
as written, with no interpolation or UID replacement.

Projects may commit `.sessions/*.md` in the **canonical checkout**. Discovery
uses `git ls-tree` and reads blobs with `git show` from a fixed snapshot of that
checkout's committed `HEAD`. Matching template filenames override defaults, and
other committed filenames add desired objects. For a non-home selection,
override `triage-status.md` rather than `logs-triage.md`.
All project files are validated as written; a project that
declares multiple workspace layouts supplies their distinct references/UIDs.
Working-tree edits and index changes are ignored, including staged new files or
deletions. Each affected path receives a warning diagnostic. Untracked
`.sessions/*.md` files are also ignored with a warning naming the path.
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
| Missing tab/pane, prior incarnation gone, or uncertain launch | `Hold` unless stage 4's exact transition evidence resolves it |
| Start withheld after intent because evidence changed; delegate never invoked | `Hold` with the durable reason, pending an explicit later operator disposition; stage 4 does not resolve it |
| Post-close respawn or inbox delegate provably never invoked after a final check failed | `respawn-pending` / `inbox-pending` with the durable reason; observe while blocked, then retry that stage once with fresh evidence |
| Missing viewer/triage occupant | `KEEP`; activation belongs to later service/rollout stages |
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
empty-process evidence may set a pane's `emptyConfirmed`. The live adapter
leaves it unset: snapshot/agent reads alone do not prove an unregistered shell
safe to launch into. This stage exercises starts solely through offline fakes.

The offline runner requires an explicit `{offline: true, start(operation)}`
action adapter. That narrow delegate represents the existing launch owner;
the controller constructs no native argv, readiness probe, record-worker call,
watcher or prompt. The future authorized adapter must delegate those to the
existing launch/dispatch paths, preserving native readiness, record-worker
evidence and watcher-before-prompt ordering. There is no live implementation or
CLI connection to any action. Workers are never dispatched/re-prompted here.
Stage 4 adds only fake close, respawn, resume and inbox-handover delegates.

## Offline reset and recovery (stage 4)

`lifecycle.mjs` extends the single-pass planner; `lifecycle-evidence.mjs`
verifies handoff bytes and closed journal/receipt shapes. There is **no live
apply path, native mutation implementation, enrollment, loop or transport**.
The live observer still uses only snapshot and exact agent reads. It cannot
infer process exit, empty-process safety, native restore state, quiescence or
handoff completion from absence or agent readiness. Those unknowns hold.
Positive stage 4 evidence is supplied by offline fake record/Herdr adapters;
the future live adapters and disposable-workspace experiment belong to A2.

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
| `sessions/controller-status.json` | Disposable recomputed projection; only the offline reconciler writes it in this stage |

The runner holds the lease for one pass, re-observes before intent and after
intent, fsyncs intent before calling the fake action adapter, then re-observes
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
