# Session manifests

Stages 1–2 of ARCH-33: a desired format, an **offline inspector**, and KEEP-only
retirement evidence. Node built-ins only. Nothing here launches a session,
prompts a model, enrolls a live workspace, runs a controller, or writes the record.
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

The [templates](templates/) and five [adopted example fixtures](../test/fixtures/sessions/)
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
  and `file` (the exact serialized names appear in `manifest.mjs`). An explicit
  `path` is project-relative; absolute paths, traversal, environment/shell
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
  handling. Standard slots require `automaticRetirement: never`. Work-item
  sessions park after report, reuse the same session for corrections, retain
  through landing or explicit disposition, and never reset while open/parked.

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
The engineer-worker template is an example for one authorized item, not an
automatically discovered worker to dispatch.
Explicit worker inspection also verifies that the item exists in the discovered
project record (including the existing `ORG_DIR` selection). Missing/unreadable
records or incomplete tails fail validation; inspection never writes that record.

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
