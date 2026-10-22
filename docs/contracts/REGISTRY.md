# Shared contracts registry

Source audit: `main` at `cc6f8a26e428df234a07fa0ed8c3b2a513a9aac1`
(2026-10-18). Paths and line numbers below refer to that revision. This inventory
describes implemented writers and readers, including their limits; roadmap
schemas are labelled separately. It does not grant another identity access to a
record, authorize a lifecycle action, or activate a transport.

Versioned documents may add optional fields: readers ignore fields they do not
understand, and writers retain the meaning of existing fields. Removing required
fields, changing their meaning/type, or otherwise breaking a reader requires a
new version. Unknown **versions** are not unknown fields; their handling is
specified below. The unversioned release pin and session-controller evidence
are deliberately closed to extra keys. Identity desks are a procedural protocol,
not a versioned JSON document. These exceptions must not be described as
extensible JSON schemas.
Other local rows marked `closed` reject extra fields or compare complete
inventories.

## Directory and display contracts

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `fleet.json`, `version: 1` <!-- persisted: fleet.json --> | Each project's explicit `monitor fleet join`, under the installation fleet lock. `$HERDR_MONITOR_FLEET/fleet.json`, default `~/.herdr-monitor/fleet.json`; the variable selects a directory. | Record discovery/ownership checks, lane/routes discovery, fleet views, retirement and project conversations. | `lib/fleet.mjs:188` (`joinFleet`), atomic write at `lib/fleet.mjs:282`; load/header validation `lib/fleet.mjs:25`, project/uniqueness validation `lib/fleet.mjs:39`, `readFleet` at `lib/fleet.mjs:57`, scoped ownership checks at `lib/fleet.mjs:62`. | Unknown fields are accepted; version must be 1. Full reads validate every project; scoped reads still prove that unrelated entries cannot claim the selected identity/record. Malformed or ambiguous ownership is an error, not a guessed mapping. |
| `project-summary/v1` (`schema`) <!-- persisted: project-summary/v1 --> | The owning project's canonical-checkout publisher, normally its housekeeping tick (`housekeeping/housekeeping.mjs:195`) or `record summary publish`. `<record>/published/summary.json` and `summary.md`, switched together by a generation symlink. | `supervisor/status.mjs:173` reads freshness; record summary reads freshness; human/operator consumers read the published projection. A cross-project reader reads this publication, not the owner's event log. | Allowlisted projection `lib/project-summary.mjs:58`; collector at `lib/project-summary.mjs:116`; atomic publisher `lib/project-summary.mjs:162`; freshness/schema/project validation `lib/project-summary.mjs:221`; Markdown consumer `lib/render.mjs:575`. | Extra fields are ignored by these consumers. Missing/invalid/future observation times, wrong schema or wrong expected project are not fresh. Age beyond `stale_after_seconds` is stale. Additive `archive.dirs` publishes resolved archive directory paths, an explicit exception to editorial path redaction. Older readers ignore it. The status reader validates the envelope, not every payload field; the renderer expects the complete publication. |
| `lanes-status/v1` (`schema`) <!-- transient --> | Each project observes its own runtime; `supervisor/retire.mjs status --json`. `--out FILE.md` publishes Markdown, not a JSON file. No stored lane status. | Terminal/Markdown renderer, the summary collector, operator, housekeeping retirement diagnostics. | Projection/class counts `lib/retire-status.mjs:145` (document at `lib/retire-status.mjs:232`); observer `lib/retire-runtime.mjs:797`; CLI at `lib/retire-runtime.mjs:850`; renderer `lib/retire-status.mjs:238`; summary consumer `lib/project-summary.mjs:85`. | Readers use known fields and ignore extras. There is no independent full-document/schema validator: the renderer and summary consume an internally produced object. Do not treat rendering as acceptance of an arbitrary external schema version. New breaking output needs a new schema. |
| `board-rows/v1` (`schema`) <!-- transient --> | Each project owns its read-only source script. Brain's built-in writer projects that project's promotion queue; `board --source NAME=SCRIPT` admits a per-project adapter. JSON stdout, not a shared status database. | Promotion board and the lanes view; the summary collector consumes validated built-in rows. | Brain writer `board/brain.mjs:56`, asynchronous API `board/brain.mjs:122`, synchronous API `board/brain.mjs:141`; adapter envelope check `board/source.mjs:46`; document/field validators `board/rows.mjs:79`, `board/rows.mjs:42`; board reader `board/board.mjs:51`, lanes reader `lib/retire-runtime.mjs:835`. | Extra document/row fields are ignored. Older rows without `clocks` produce an empty list; clocks without `legacy` default to false. Unknown schema becomes a `source-schema` diagnostic row. Invalid presentation fields become `withheld`; paths/panes require independently supplied roots/inventory. |
| `closeout-entry/v1` (`schema`) <!-- persisted: closeout-entry/v1 --> | Owning project's record CLI, optional `lane ready`, settle and explicit recovery; `<git-common-dir>/closeout/entries/<key>.json`. Opt-in via canonical `.lane.json` `retirement.closeout_queue`, default off. | The single finite `supervisor/closeout.mjs` consumer; guarded retirement supplies all effect authority. | `lib/closeout.mjs`, `lib/closeout-consumer.mjs`; [contract and recovery](CLOSEOUT.md); [format entry](formats.json); offline acceptance `test/closeout.test.mjs`. Source event contains the original target binding; outcomes and deferrals are record events. | Unknown fields ignored; unknown schemas/versions keep and require explicit recovery. Older releases ignore this directory, and older folds ignore `review.*`/`closeout.*` events. Activation transfers ownership from legacy retirement ticks under the shared claim; it does not enable two executors. The compatibility probe publishes a real ready entry and invokes the OLD queue reader only; effects, native identity and ownership-transfer recovery remain outside that probe. |
| `run-ownership/v1` (`run.claimed`) <!-- persisted: run-ownership/v1 --> | Owning record, `record claim`; Brain dispatch admission. | Watch, settle, supervisor and run-bound promotion; BCH adapter must consult `.owner` or drain old writers. | [Run ownership](RUN-OWNERSHIP.md), `lib/run-owner.mjs`, `lib/state.mjs`; offline `test/run-ownership.test.mjs`. | Additive event/JSON fields; unknown fields/events remain readable. Old writers require explicit drain. Complete owner plus event generation fences transfer and outstanding effects hold it. |

Fleet v1 requires `session_limit` and a `projects` map. Each project maps an
absolute canonical Git common-directory `identity` to `checkout`, `record`,
`worktrees` and `layers`. Names, remotes and workspace labels are not ownership.
It is a directory, never a status channel. The board takes explicit project/source
paths rather than deriving them from the fleet (`board/board.mjs:11`).

Summary v1 publishes project identity/name, observation time and freshness limit,
status counts, today's landings/decisions, lane counts and oldest unresolved
rows, release IDs, named exceptions and additive `archive.dirs` (resolved absolute
archive directory paths; empty when none resolves). This explicit path allowlist
bypasses editorial `line()` redaction; all other path exclusions remain. Archive
directories use the owning project's layer-relative declaration or the existing
sibling `archive/` default, as documented in [the summary contract](../PROJECT-SUMMARY.md).
They grant no access or cleanup authority; older readers ignore them. The
`project-summary/v1` persisted marker above and `formats.json` entry cover this
field without a schema bump. Freshness defaults to at least 300
seconds (`lib/project-summary.mjs:21`, `lib/project-summary.mjs:156`). At the
audited revision the release helper reports installed `current` and **always
returns `pinned: null`** (`lib/project-summary.mjs:48`); the implemented pin
selector below must not be confused with summary integration that has not landed.

Lanes v1 has `generatedAt`, `project`, `held`, `counts` and `rows`. The six classes
are `TERMINAL`, `ACTIVE`, `WAITING`, `IDLE-NONTERMINAL`, `UNKNOWN` and `PROTECTED`
(`lib/retire-status.mjs:7`). Worktree inventory rows can have `class: null` and
are excluded from class counts. These are display facts, never cleanup authority.

## Validation evidence

| Identifier / version | Owner and declaration | Intended readers | Contract and implementation status | Compatibility |
| --- | --- | --- | --- | --- |
| `declared-gates/v2` <!-- transient --> | Project-authored commands, coverage and optional reuse inputs in the owner's resolved `.lane.validation.json`; one authority, independent of config-home storage. | Planned lane, queue/train, host and canonical-planner adapters; no capable implementation claimed. | [R-732 redesign amendment](DECLARED-GATES.md), contract only, pending authority review on `review-sol-max` by 2026-10-23 and the operator's single `receipt_reuse` A/B choice (B recommended). Opaque named commands and declared coverage replace launch/scope inference. No project is opted in. | New closed version; requires explicit capable-worker admission and refuses old workers/receipts. Legacy behavior is unchanged. Identity-root checks remain; the native sandbox is the wall. Crash recovery uses captured declarations. B would use separate `declared-gate-receipt/v2` evidence and does not weaken `exact-validation/v1`. |
| `declared-gates/v1` <!-- transient --> | Superseded, unlanded declaration/runner design in lane `declared-gates` at `a98dadb4`. | Parked lane implementation; historical reviews/receipts. | Original contract PASS `af96a9a-r1`; subsequent implementation reviews found launch-recognition bypasses. ARCH-38 parked it on 2026-10-21 (seq 13232); the linked redesign identifies code to delete/replace. | Not acceptance of v2 or authority to activate v1. Preserve historical evidence; do not reinterpret v1 typed selections, runtime/scope bindings or passes as v2 coverage/reuse. |

This section describes the ENG-419 implementation based on source revision
`ad97e531073dd31e4e6cc885773415a4b55e5b40`. It uses symbol names for the new
implementation; existing line numbers elsewhere in this registry still refer to
the source audit at the top. The runner exclusion's historical line number in
the linked contract refers explicitly to `ad97e531`.

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `exact-validation/v1` (`exact.schema` and identity `schema`) <!-- persisted: exact-validation/v1 --> | Engineer-attested green `validateTree` execution; `<common>/lane-validation/exact/<key>.json` plus the existing receipt, immutable log and execution sidecar. | `lane check --gate` and the promotion train, only when current canonical base commits `.validation-receipts.json`. | `lanes/exact-validation.mjs`: `readReceiptDeclaration`, `restrictEnvironment`, `exactIdentity`, `explainMiss`; `lanes/validation.mjs`: `validateTree`, `reusableExact`. Full semantics: [exact-validation.md](exact-validation.md). | Receipt envelope additions are allowed. Every core identity field is mandatory; adapters may add bound fields and cannot remove core ones. Unknown identity schema cannot reuse. The separate `validation-receipts/v1` declaration is closed to unknown keys, schemas and exclusions. Absence preserves legacy behavior; older releases ignore the file. New exclusions require T2. Opt-in explicitly changes prepare/planner/check execution to the allowlisted environment plus closed runner pass-through. No project is activated by this row. |

## Host occupancy and installed releases

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `occupancy/v1` (`schema`) <!-- persisted: occupancy/v1 --> | Each shared-work process owns its file in `<compat-lock>.occupancy/`. Atomic creation and updates; only its owner releases the file. | Slot diagnostics/wait display, board, retirement's keep references. Occupancy grants no exclusive admission or queue position. | `test-slot/occupancy.mjs:102` (`sharedOccupancy`); owner/liveness validation `test-slot/occupancy.mjs:51`; directory reader `test-slot/occupancy.mjs:82`; slot consumers `test-slot/test-slot.mjs:315`, `test-slot/test-slot.mjs:660`; board `board/facts.mjs:51`; retirement `lib/retire-runtime.mjs:140`. | Extra fields are accepted. Older records can omit birth identity, cwd and newer display fields. Missing/uncertain live identity is reserved conservatively. Unknown schema versions are skipped and never pruned; malformed files surface as unknown. `prune` is opt-in and only removes proven-gone v1 records with unchanged bytes. |
| `host-reservation/v1` (`schema`) <!-- persisted: host-reservation/v1 --> | Each proving step owns a 0600 file in `<compat-lock>.occupancy/`, beside shared occupancy. | Launch gates, board and retirement; only live/unexpired proving pauses launches. | `test-slot/reservations.mjs` writer, state validator, reader and foreground wait; `test-slot/memory-floor.mjs` EXCLUSIVE-only floor wait; [contract](HOST-RESERVATIONS.md#proving-step-admission). | Floor waits share the lock deadline and expire there; execution renewal follows grant only. Zero-duration immediate-attempt rows are expired (older strict-duration readers show nonblocking unknown). Older occupancy readers skip this separate schema and never prune it. Missing expiry or malformed fields are unknown and nonblocking; expired live owners retain their bytes. Six-hour cap; exact-byte opt-in gone pruning; legacy holder keys unchanged. |
| `herdr-release/v1`, `protocol: 1` <!-- persisted: herdr-release/v1 --> | Brain's release build writes `.release-manifest.json` beside `.release-commit` in an immutable installed bundle, normally `~/.local/share/herdr-monitor/releases/TAG/`. Live builds retain `.release-acceptance.json` and add compact `acceptance` evidence and its summary SHA-256; offline builds explicitly record acceptance did not run. | Launch admission, explicit project pin acceptance and immutable job continuations through `lib/releases.mjs`. | Manifest writer and legacy `attest` writer `herdr/releases.mjs`; inventory `lib/product-files.mjs`; header/mandatory entries/hash validation `checkBundle`, immutable path validation `checkRelease`, acceptance validation `releaseAcceptance`, continuation identity check `operationFile` in `lib/releases.mjs`. | Extra manifest fields remain additive and are ignored by older readers; schema/protocol/commit must match. Build and pin verify all runtime hashes; new pin/admission resolvers also require READY acceptance for that commit. Legacy protocol-1 bundles without an acceptance field may use write-once installation evidence `acceptance/TAG.json` (`herdr-release-acceptance/v1`). Legacy **unpinned** current bundles may lack a manifest; this is not permission to accept a bad project pin. The project pin remains exactly `{release: id|null}`. |
| `herdr-release-acceptance/v1` (`schema`) <!-- persisted: herdr-release-acceptance/v1 --> | The installation owner uses `herdr/releases.mjs attest HOME TAG SUMMARY` to publish write-once `<installation>/acceptance/TAG.json` for a legacy protocol-1 bundle without a manifest acceptance field. The immutable bundle is unchanged. | Pin and launch admission through `releaseAcceptance` in `lib/releases.mjs`. | Writer `herdr/releases.mjs`; summary validation `acceptanceRecord`, attestation validation `releaseAcceptance`, admission `requireReadyAcceptance` in `lib/releases.mjs`. | Unknown fields are ignored; schema, release ID and commit must match the selected bundle. READY acceptance must bind that commit, valid counts, elapsed time and summary SHA-256. Older readers may ignore this installation evidence; that does not prove acceptance admission or attestation recovery compatibility. A manifest acceptance field takes precedence and cannot be repaired by a legacy attestation. |
| `.herdr-release.json`, **unversioned** <!-- persisted: .herdr-release.json --> | The project's owner writes `{"release":"TAG"}` or `{"release":null}` with `herdr/releases.mjs pin/unpin` in its canonical checkout, then commits it to accept the choice. | Project-aware launchers, dispatch/settle/promotion/housekeeping admission. | Writer `herdr/releases.mjs:33`; committed canonical HEAD reader and closed-key validation `lib/releases.mjs:120` (keys checked at `lib/releases.mjs:152`); selection `lib/releases.mjs:194`; immutable continuation `lib/releases.mjs:254`. | Exactly one key, `release`; **unknown keys are rejected**. Absence/null selects current. Lane edits and uncommitted canonical edits do not select a release. An invalid accepted pin fails closed. A breaking extension needs an explicitly coordinated new config contract/reader, not an extra field in this file. |

Occupancy v1 contains shared class, PID/start/birth identity, optional group
identity, label, cwd, host, informational project identity, acquisition/start
times, reason and optional `profile_id` (`test-slot/occupancy.mjs:109`).
**Occupancy v2 remains planned.** Proving reservations use the separate
`host-reservation/v1` schema in the compat occupancy directory, with expected end,
mandatory capped expiry and optional display GiB. Shared v1 keys remain unchanged.
An occupancy/v2 document is still unknown and survives untouched.

## Journals and hook delivery

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| [Continuation and revision cap](CONTINUATION-AND-REVISION-CAP.md), additive metadata/receipt fields <!-- transient --> | herdr: `dispatch/dispatch.mjs` writes continuation metadata and refusal codes; `settle/settle.mjs` writes cap decisions, correction receipts and route-change reuse skips. | Supervisor autopilot, context and status consume results; BCH supervisor adopts the parity contract. | Dispatch preflight plus authoritative `record start --if-current-run`; settle `reviewPolicy`, capped decision and explicit `--retry --fix-findings` recovery. | Existing messages and fields retain meaning; new `continuation_of`, `same_session`, `code` and `reuse_skipped` fields are optional for older readers. Session metadata grants no authority. Release identity and phase B parity evidence remain pending in the linked cutover row. |
| `session-controller-journal/v1` (`schema`) <!-- persisted: session-controller-journal/v1 --> | The authorized foreground session controller owns `<git-common-dir>/sessions/controller-journal.json`. | Session plan/apply, lifecycle evidence, canonical standard-slot KEEP derivation and bounded setup apply. | Durable intent writers `sessions/reconcile.mjs:305`, `sessions/reconcile.mjs:346`; closed journal reader `sessions/runtime.mjs:17`, start/create validator `sessions/lifecycle-evidence.mjs:68`. | These operation shapes are closed. `create-standard-slot` adds an operation with a workspace-only target plus `standardSlot`; its exact receipt supplies the new tab/pane binding, and only acknowledgement derives enrollment. Older readers fail closed (hold/keep) on the unknown operation, preserving work; this is not transparent old-reader compatibility. The consuming project's release pin must move with this writer/reader extension. |
| `session-adapter-receipts/v1` (`schema`) <!-- persisted: session-adapter-receipts/v1 --> | The session controller's live adapter owns `<git-common-dir>/sessions/adapter-receipts.json` beside the controller journal. | Session plan/apply, lifecycle evidence, canonical standard-slot KEEP derivation and bounded setup apply. | Adapter writer `sessions/live.mjs:59`; receipt reader/validator `sessions/live.mjs:41`. | These operation shapes are closed. `create-standard-slot` adds an operation with a workspace-only target plus `standardSlot`; its exact receipt supplies the new tab/pane binding, and only acknowledgement derives enrollment. Older readers fail closed (hold/keep) on the unknown operation, preserving work; this is not transparent old-reader compatibility. The consuming project's release pin must move with this writer/reader extension. |
| `brain.log/v1` (`schema`) <!-- persisted: brain.log/v1 --> | Producers own origin events; the identity-owned foreground journal adds stream/cursor/received time. `logs/journal.mjs` writes `segment-N.jsonl`; legacy shadow mirrors write `shadow.jsonl` in the same partition convention. | Log input/view/detector tools, shadow reader and addressed-message receiver. | Record/source envelopes `logs/inputs.mjs:30`, `logs/inputs.mjs:93`; segment writer `logs/journal.mjs:161`, append validation `logs/journal.mjs:174`, segment reader `logs/journal.mjs:91`; desk/notice origin writer `messages/mirror.mjs:71`, shadow append/read `messages/journal.mjs:99`, `messages/journal.mjs:65`; shared structural validator `messages/schema.mjs:107`, parser `messages/schema.mjs:166`. | Extra JSON fields are accepted within size/type bounds; duplicate JSON keys are rejected. Optional origin/cursor fields can be absent in origin envelopes. Unknown event types remain inert, but must have a valid v1 envelope. An unknown schema version is rejected. Identical event/producer keys deduplicate; changed content under a key is a conflict, not an update. |
| `brain.transport/v1` (`schema`) <!-- persisted: brain.transport/v1 --> | The local receiver exclusively appends acceptance, receipts, owner and fence records to explicit `ROOT/transport.jsonl`. Current mutations are **fixture-only**, not a live cross-identity broker. | Receiver state/status, transfer rehearsal, hook handoff and consumption. | Transaction writer `messages/receiver.mjs:103` (record envelope at `messages/receiver.mjs:109`); synchronous intent writer `messages/receiver.mjs:306`; JSONL/header/sequence reader `messages/receiver.mjs:43`; fold `messages/receiver.mjs:58`; embedded events validated at `messages/receiver.mjs:63`. | Extra fields are ignored by the fold; unknown record types are inert. Schema and contiguous sequence remain mandatory; torn/corrupt journals fail closed and preserve evidence. The init-only historical shape remains readable. Adding a record cannot grant new enrollment or clear a refusal. |
| `hook-pull/v1` (`receipt.transport`) <!-- persisted: hook-pull/v1 --> | Receiver `claimNext` owns the durable claim receipt; `messages/hook-pull.mjs` renders Stop/UserPromptSubmit JSON for the harness. Receipts live inside `brain.transport/v1`, not in a separate hook schema file. | Harness reads hook output; receiver/handoff reads receipts; subsequent `Receiver.consume` records exposure. | Claim/receipt writer and enrollment guards `messages/receiver.mjs:243` (receipt at `messages/receiver.mjs:263`); hook input guards/output writer `messages/hook-pull.mjs:20`; handoff reader `messages/hook-pull.mjs:38`; consume reader/verification `messages/receiver.mjs:224`. Related launch-descriptor writer/validator `messages/hook-session.mjs:12`, `messages/hook-session.mjs:47`. | Unknown hook input and receipt fields are ignored. Stop continuation guard, exact `inbox` nudge and cwd/consumer/session checks still apply. A claim is delivered with processing unknown; no automatic replay or exactly-once understanding claim. A breaking receipt/adapter meaning requires a new transport version. |

The continuation/cap row is a contract overview with transient result output,
not an independent persisted format. Its durable metadata and receipts belong to
the existing `record-events`, `dispatch-journal` and `settle-journal` inventory
entries; the transient marker does not classify those stored fields as transient
or claim coverage of their cap/reuse recovery behavior.

Default journal partitions are
`<identity-root>/.herdr-brain/logs/<identity>/SHA256(commonDir)` when marked,
otherwise `~/.local/state/herdr-brain/logs/<identity>/SHA256(commonDir)`;
`BRAIN_SHADOW_ROOT`/explicit root override that base (`messages/journal.mjs:39`).
The shared envelope requires event ID, producer ID/epoch/sequence, UTC occurrence
time, type, level, identity, project common directory and object payload.
`session.message.v1` adds validated sender/recipient addresses, message kind,
qualified references, reply/correlation data and optional body/decision references
(`messages/schema.mjs:132`). These references convey no decision authority.

Transport mutation requires a canonical private temporary `brain-transport-*`
root and a fixture marker (`messages/fixture.mjs:7`). Hook delivery preserves
that boundary. The separate `brain.hook-session/v1` launch descriptor is private
launch plumbing, not another inbox protocol. Claude opt-in is project-local;
Codex launch integration remains disabled at this revision. Native harness trust
and permissions are not installed or bypassed by these schemas.

## Declared references and identity desks

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `herdr-reference/v1` (`schema`) <!-- persisted: herdr-reference/v1 --> | The claiming supervisor/tool atomically publishes its own `<record>/references/JOB.json`, then removes it when finished. **No bundled writer is required or implemented.** | Retirement observation/planner, with keep-only authority. | External writer format/atomic-rename requirement and example `supervisor/README.md:277`; actual validator/reader `lib/retire-runtime.mjs:53`; integration `lib/retire-runtime.mjs:75`. | Unknown fields are accepted. Required owner/kind/job/state/item/creation/expiry fields cannot be removed; run/lane/cwd/pane/tab/terminal and native pane_id/tab_id/terminal_id aliases are optional. The pristine creation-tab exception checks native resource scopes separately from lane work and keeps unclear ownership. Expired valid references are ignored with a diagnostic. Invalid/unreadable/unknown-schema references hold the project, even if apparently expired. Only non-hidden `*.json` entries are read as references; other entries are ignored without deletion, and invalid or non-regular `*.json` entries still hold the project. They never release resources. |
| Identity desks, **unversioned procedural contract** <!-- transient --> | Requester invokes `node supervisor/request.mjs IDENTITY TEXT`; the owning identity receives at `desk-IDENTITY` in `~/development/IDENTITY` and records/implements its own work. No shared request JSON file. | Herdr's native agent CLI and the receiving identity's instructions/human-readable request. The optional shadow mirror is a separate brain.log observation. | Request validation/CLI writer `supervisor/request.mjs:10`; name/cwd `supervisor/request.mjs:18`; strict Herdr response reader `supervisor/request.mjs:20`; native creation/readiness/delivery `supervisor/request.mjs:32`; mirror origin `messages/mirror.mjs:91`. | Herdr inventory/result extra fields are ignored. Identity is a single safe directory name; request text is passed literally as one argv value. Requester explains what/why/done/evidence; no machine validator exists for that prose. Existing desk naming/CLI semantics must stay compatible or be coordinated with owners. Never edit the recipient's files or forward a harness refusal. |

## Review desks and scope

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `brain.review-scope/v1` (`schema`) <!-- persisted: brain.review-scope/v1 --> | The owning project's foreground settle intake; `job.reviewScope` in `<record>/settle/R-n.json`, exposed as additive `review_scope` in the result and escalation handoff JSON. | Settle decides whether to launch review; supervisors inspect the receipt. | Read-only Git writer `settle/review-range.mjs` (`reviewScope`); validate-stage consumer and result/handoff projection `settle/settle.mjs`. [Desk/scope contract](review-desk-and-scope.md). | Internally generated receipt; consumers use known fields and ignore extras. Older settle results omit it. No arbitrary external-document reader or unknown-version acceptance is implied. Breaking field semantics require a new schema; contract acceptance, release, activation and parity remain separate. |

## Offline conformance and existing drift coverage

`test/contracts-conformance.test.mjs` has one current-writer and one
installed-writer case for each originally audited row above. The continuation
and revision-cap row uses its linked dispatch, settle and supervisor fixtures.
The conformance file feeds actual writer output to the
current reader, then checks an older-shaped or extra-field document and relevant
unknown-version behavior. The reference case uses the published external-writer
example; the desk case checks literal CLI bytes with a fake physical Herdr seam.
The hook case checks real durable claim receipts, handoff and consumption; it
does not claim to validate an external harness implementation.

The installed cases resolve the source project's **committed canonical pin**
first, or the installed `current` once when unpinned. They report the exact bundle
and never write into it. No installation produces explicit skips; an installed
bundle predating a contract writer produces a named per-contract skip. An absent
pinned bundle skips explicitly with its release name; a present but invalid bundle
is an error, not a skip or fallback. All writes, enrollments and
process-presence fixtures are disposable and offline; the in-process fleet path
is also explicitly isolated. Promotion includes this file in
the `promotion` list in `test/helpers/tier.mjs` as
`test/contracts-conformance.test.mjs`, so release preparation's promotion coverage
includes it too. New files otherwise default to release-only.

Keep these existing drift witnesses as the authorities for their own scope:

- `test/release-pins.test.mjs:51`: independent project pins, lane/uncommitted
  selector resistance, invalid-pin refusal, immutable continuations, release
  inventory and mixed-version slot behavior. The conformance file adds schema
  witnesses without repeating those lifecycle scenarios.
- `test/bch-cloak-contract.test.mjs:12`: BCH CLI commands, output parsers, event
  fields and installed compatibility paths, plus legacy event folding. BCH's
  `contrib/settle-watch.mjs`, `supervisor/reconcile.mjs`, `lib/cli-help.mjs` and
  `watch/notice.mjs` remain stable surfaces.
- `test/retire-status.test.mjs:163`: enumeration of every planner reason expression
  and its class mapping, including a source-drift failure. This registry does
  not maintain a second reason enumeration.

Project-local record events, promotion queues/receipts, lane bindings, private
launch descriptors, controller state and housekeeping state retain their owning
module's contract. Their inventory below does not turn that state into a
cross-project coordination API.

## Project-local persisted formats

The machine-readable companion is `docs/contracts/formats.json`. Each persisted
table row is tagged with its stable id; transient/procedural rows are tagged
separately. `test/formats.test.mjs` checks both directions, required metadata and
writer paths. These local formats remain owned by their modules; listing them
does not make them cross-project coordination APIs. The external reference row
is included to make its lack of a bundled writer explicit. Versions on untagged
files describe the current contract and do not add schema fields to those files.

`additive` preserves existing field meaning and ignores unknown fields in the
named readers. `closed` requires coordinated changes; do not append fields and
assume compatibility. The lane archive verifier compares complete inventories,
and session authorization/controller/slot documents use exact-key validation.
Runtime mutexes, generated prose, ordinary diagnostic logs, user-authored policy
and transient projections are outside this state/receipt inventory. Embedded
receipts have their own rows when they have an independent version/consumer.

| Identifier / version | Owner (writer) and location | Compatibility |
| --- | --- | --- |
| `record-events`, unversioned <!-- persisted: record-events --> | `lib/store.mjs`; `<record>/events.jsonl`, including `lane.*`, `review.*`, `closeout.*` and `closeout_targets` source bindings. | Additive. Closeout completion, effect, deferral, invalid-entry and retry receipts remain in this log after request pruning; there is no separate pruned-request receipt file. Older folds ignore unknown event types. The event probe exercises a real ready source binding and completion/pruning receipt, not native effects or reviewer release. |
| `record-config`, unversioned <!-- persisted: record-config --> | `lib/store.mjs`; `<record>/config.json` | additive; owned by the named module. |
| `promotion-queue`, unversioned <!-- persisted: promotion-queue --> | `promote/promote.mjs`; `<common>/promote/queue.json` | additive; owned by the named module. |
| `promotion-closeout-outbox`, unversioned <!-- persisted: promotion-closeout-outbox --> | `promote/promote.mjs`; embedded `closeout_pending[]` in `<common>/promote/queue.json`. Each notification binds completed job id, record, topic, run and tip until its targeted enqueue is acknowledged. | Additive to the queue envelope; the completion consumer owns retry/acknowledgement. Pre-closeout readers ignore the field and cannot acknowledge it. Named `notCovered` in the machine inventory; the ordinary pending-queue probe does not cover this recovery path. |
| `promotion-train/v1`, 1 <!-- persisted: promotion-train/v1 --> | `promote/promote.mjs; promote/train.mjs`; `<common>/promote/batches/*/train.json` | additive; owned by the named module. |
| `promotion-completion`, 1 <!-- persisted: promotion-completion --> | `promote/completion.mjs`; `<common>/promote/batches/*/train.json.record.json` | additive; owned by the named module. |
| `lane-evidence/v2`, 2 <!-- persisted: lane-evidence/v2 --> | `lib/lane-removal.mjs`; `<common>/lane-archive/<topic>/*/sha256.json` | closed; owned by the named module. |
| `lane-scratch-sweep/v1`, 1 <!-- persisted: lane-scratch-sweep/v1 --> | `lib/scratch-sweep.mjs`; first eligible `<archive>/lane-sweeps/*.json`, else beside `<common>/lane-archive/<topic>/*/` preservation bundles | Additive diagnostic manifest; no OLD or current runtime entry consumer. Archive and resolved destination must be outside every Git worktree or ignored in each containing worktree; the closing lane remains forbidden. Records ownership, match method, byte size, disposition, reason, topic-only cross-project risk and external-evidence warnings before effects. Removals, pending intents, uncertain observations and ownership failures stay in full in `entries`; ordinary keeps use additive `kept_summary` with exact counts by reason and at most 16 sample paths / 4096 serialized path bytes. Additive `counts` totals detailed and summarized entries. Older v1 manifests omit both summaries and retain every entry; path/recovery readers need no version change. Refused/deferred closes end as `not-executed`; after duplicate evidence disposal, fallback manifests are deleted and declared archives retain one overwritten per-topic refusal manifest. Partial-removal recovery writes a linked manifest and uses the same sweep. Interrupted intents or failed manifest updates may remain unfinished on disk; update failures warn and log removed paths without blocking workspace closure. |
| `herdr-scratch/v1`, 1 <!-- persisted: herdr-scratch/v1 --> | External scratch creator; `<scratch>/.herdr-scratch.json` | Additive; NEW validates common-directory identity, run/topic and schema before disposal. OLD has no external scratch sweeper. Invalid or foreign markers keep the directory without topic fallback. |
| `lane-validation/v1`, 1 <!-- persisted: lane-validation/v1 --> | `lanes/validation.mjs`; `<common>/lane-validation/<key>.json` | additive; owned by the named module. |
| `lane-gate`, 1 <!-- persisted: lane-gate --> | `lanes/lane.mjs`; `<lane>/.lane/gate.json` | additive; owned by the named module. |
| `lane-open/v1`, 1 <!-- persisted: lane-open/v1 --> | `lib/initial-shell.mjs`; `<common>/retirement/lane-opens/*.json` | additive; owned by the named module. |
| `initial-shell/v1`, 1 <!-- persisted: initial-shell/v1 --> | `lib/initial-shell.mjs`; `<common>/retirement/initial-shells/*.json` | additive; owned by the named module. |
| `retirement-request/v1`, 1 <!-- persisted: retirement-request/v1 --> | `lib/retire-trigger.mjs`; `<record>/retirement/request.json` | additive; owned by the named module. |
| `retirement-handled/v1`, 1 <!-- persisted: retirement-handled/v1 --> | `lib/retire-trigger.mjs`; `<record>/retirement/handled.json` | additive; owned by the named module. |
| `retirement-occupant/v1`, 1 <!-- persisted: retirement-occupant/v1 --> | `lib/retire-runtime.mjs`; `<record>/retirement/occupants/*.json` | additive; owned by the named module. |
| `retirement-review/v1`, 1 <!-- persisted: retirement-review/v1 --> | `lib/retire-runtime.mjs`; `<record>/retirement/reviews/*.json`, including optional `tab`, process/shell birth and `followup_expected` fields. | Additive envelope; compatible retention behavior needs the named native-identity/follow-up probe gap in the machine inventory. Structured `review.verdict` and follow-up-end facts are separately carried by `record-events`. |
| `retirement-exit/v1`, 1 <!-- persisted: retirement-exit/v1 --> | `lib/retire-runtime.mjs`; `<record>/retirement/exits/*.json` | additive; owned by the named module. |
| `dispatch-journal`, unversioned <!-- persisted: dispatch-journal --> | `dispatch/dispatch.mjs`; `<record>/dispatch/<attempt>.json` | additive; owned by the named module. |
| `run-timing`, unversioned <!-- persisted: run-timing --> | `lib/run-timing.mjs`; `<record>/dispatch/<attempt>.json.events.jsonl` and separate `<attempt>.json.admission.jsonl`; run metadata `dispatch_waits`, `dispatch_admission_waits`, `process_end` | The legacy journal retains `memory_open`, `memory_worker`, `process_end`; `dispatch_waits` contains only memory gates. Admission uses the separate companion and additive metadata field, which old readers ignore; old metrics retain memory totals and process end. The probe writes both shapes and checks OLD's actual readers. |
| `settle-journal`, unversioned <!-- persisted: settle-journal --> | `settle/settle.mjs`; `<record>/settle/R-n.json` | additive; owned by the named module. |
| `report-ingest/v1`, 1 <!-- persisted: report-ingest/v1 --> | `settle/report-evidence.mjs`; `<record>/settle/R-n.json reportIngest` | additive; owned by the named module. |
| `housekeeping-owner`, unversioned <!-- persisted: housekeeping-owner --> | `housekeeping/housekeeping.mjs`; `<housekeeping-state>/lock/owner.json` | additive; owned by the named module. |
| `housekeeping-config`, unversioned <!-- persisted: housekeeping-config --> | `housekeeping/command.mjs`; `<canonical>/.housekeeping.json` | closed; owned by the named module. |
| `housekeeping-actions`, unversioned <!-- persisted: housekeeping-actions --> | `housekeeping/housekeeping.mjs`; `<housekeeping-state>/actions.jsonl` | additive; owned by the named module. |
| `housekeeping-resume`, unversioned <!-- persisted: housekeeping-resume --> | `housekeeping/housekeeping.mjs`; `<housekeeping-state>/resume-attempts.jsonl` | additive; owned by the named module. |
| `brain-distill/v1`, 1 <!-- persisted: brain-distill/v1 --> | `brain/lib/signals.mjs`; `<brain-state>/distill/<record-hash>/pending.json` | additive; owned by the named module. |
| `brain-distill-cursor`, 1 <!-- persisted: brain-distill-cursor --> | `brain/lib/signals.mjs`; `<brain-state>/distill/<record-hash>/cursor.json` | additive; owned by the named module. |
| `gate-watchdog/v1`, 1 <!-- persisted: gate-watchdog/v1 --> | `test-slot/limits.mjs`; `<common>/gate-watchdog/*.json (or <history-root>/<project-hash>/*.json)` | additive; owned by the named module. |
| `test-slot-wait/v1`, 1 <!-- persisted: test-slot-wait/v1 --> | `test-slot/test-slot.mjs`; `<explicit-wait-receipt>` | additive; owned by the named module. |
| `test-slot-owner`, unversioned <!-- persisted: test-slot-owner --> | `test-slot/test-slot.mjs`; `<slot-lock> (owner JSON)` | additive; owned by the named module. |
| `test-slot-ticket`, 1 <!-- persisted: test-slot-ticket --> | `test-slot/ticket-queue.mjs`; `<slot-lock>.queue/*` | additive; owned by the named module. |
| `gate-execution`, unversioned <!-- persisted: gate-execution --> | `test-slot/test-slot.mjs`; `<explicit-execution-receipt>` | additive; owned by the named module. |
| `test-slot-measurement/v1`, 1 <!-- persisted: test-slot-measurement/v1 --> | `test-slot/measurement.mjs`; `<explicit-measurement-receipt>` | additive; owned by the named module. |
| `promotion-host-gate/v1`, 1 <!-- persisted: promotion-host-gate/v1 --> | `promote/host-gate.mjs`; `<common>/promote/batches/*/host-gate.json` | additive; owned by the named module. |
| `standard-slot-history/v1`, 1 <!-- persisted: standard-slot-history/v1 --> | `sessions/receipts.mjs`; `<common>/sessions/standard-slots.json` | closed; owned by the named module. |
| `session-native-context/v1`, 1 <!-- persisted: session-native-context/v1 --> | `sessions/live.mjs`; `<common>/sessions/contexts/*.json` | closed; owned by the named module. |
| `session-authorization/v1`, 1 <!-- persisted: session-authorization/v1 --> | `sessions/authorization.mjs`; `<common>/sessions/authorizations/*.json` | closed; owned by the named module. |
| `brain.hook-session/v1`, 1 <!-- persisted: brain.hook-session/v1 --> | `messages/hook-session.mjs`; `<common>/sessions/hook-pull/*/session.json` | additive; owned by the named module. |
| `verify-queue/v1`, 1 <!-- persisted: verify-queue/v1 --> | `verify/verify.mjs`; `<trusted-verify-store>/queue.json` | additive; owned by the named module. |
| `verify-inbox/v1`, 1 <!-- persisted: verify-inbox/v1 --> | `verify/verify.mjs`; `<trusted-verify-store>/inbox.json` | additive; owned by the named module. |
| `verify-receipt/v1`, 1 <!-- persisted: verify-receipt/v1 --> | `verify/verify.mjs`; `<trusted-verify-store>/jobs/*/receipt.json` | additive; owned by the named module. |
| `supervisor-cursor`, unversioned <!-- persisted: supervisor-cursor --> | `supervisor/supervisor.mjs`; `<record>/supervisor/<identity-hash>/cursor.json` | additive; owned by the named module. |
| `supervisor-handle`, unversioned <!-- persisted: supervisor-handle --> | `supervisor/supervisor.mjs`; `<record>/supervisor/<identity-hash>/R-n.json` | additive; owned by the named module. |
| `supervisor-autopilot`, unversioned <!-- persisted: supervisor-autopilot --> | `supervisor/autopilot.mjs`; `<record>/supervisor/<identity-hash>/autopilot/*.json` | additive; owned by the named module. |
| `supervisor-inbox`, unversioned <!-- persisted: supervisor-inbox --> | `supervisor/prompt-supervisor.mjs`; `<record>/supervisor/inbox*` | additive; owned by the named module. |
| `brain.message-pointer/v1`, 1 <!-- persisted: brain.message-pointer/v1 --> | `messages/receiver.mjs`; `<fixture-receiver>/envelopes/*.json` | additive; owned by the named module. |
| `log-watermarks`, 1 <!-- persisted: log-watermarks --> | `logs/journal.mjs`; `<journal-partition>/watermarks-<sha256>.jsonl` | closed; owned by the named module. |
| `lane-session-registry`, unversioned <!-- persisted: lane-session-registry --> | `lanes/board/registry.mjs`; `<canonical>/.lane/sessions.json and .d/*.json` | additive; owned by the named module. |
| `route-snapshot`, unversioned <!-- persisted: route-snapshot --> | `dispatch/dispatch.mjs; settle/settle.mjs`; `<record>/{dispatch,settle}/*.routes.json` | additive; owned by the named module. |
| `promotion-tests/v1`, 1 <!-- persisted: promotion-tests/v1 --> | `promote/test-plan.mjs`; `<common>/promote/batches/*/train.json attempts[].test_plan` | additive; owned by the named module. |
| `promotion-tests/v2`, 2 <!-- persisted: promotion-tests/v2 --> | `promote/declared-selection.mjs; promote/train.mjs`; `<common>/promote/batches/*/train.json attempts[].test_plan` | Closed typed plan with bound whole-file and runner/argv requirements, finite budgets and deferred evidence. V1 receipts cannot cover typed obligations; old workers must refuse the owner declaration. |
| `declared-gate-execution/v1`, 1 <!-- persisted: declared-gate-execution/v1 --> | `promote/declared-gates.mjs; lanes/validation.mjs`; embedded in attempt `declared_spec` and gate `declared_gate`, including exact identities | Closed literal executor input binds declaration/source, base/candidate, identity roots, canonical orchestration, full selection, installed dependencies and runtime facts. Core exact-validation fields/exclusions remain intact. |
| `declared-gate-attempt/v1`, 1 <!-- persisted: declared-gate-attempt/v1 --> | `promote/declared-gates.mjs; promote/train.mjs; promote/declared-planning.mjs`; `<common>/promote/batches/*/train.json attempts[].declared_execution` and `<common>/promote/planning/*/planning.json` | Additive diagnostic execution facts: preparation/planner clocks and exits, canonical/runtime bindings, limits and ordered command outcomes, including red attempts. Settle planning uses the same host admission but never runs the candidate gate or creates green proof. Retained on restart; never independently authorizes integration. |
| `promotion-selector-shadow/v1`, 1 <!-- persisted: promotion-selector-shadow/v1 --> | `promote/selector.mjs`; `<common>/promote/batches/*/train.json attempts[].selector_shadow` | additive; owned by the named module. |
| `project-cycle-time/v1`, 1 <!-- persisted: project-cycle-time/v1 --> | `supervisor/cycle-time.mjs`; `<record>/published/cycle-time.{json,md}` | additive; owned by the named module. |
| `slot-handoff`, unversioned <!-- persisted: slot-handoff --> | `lib/handoffs.mjs`; `<record>/handoffs/<workspace>/<slot>/*.md and handoff.recorded events` | closed; owned by the named module. |

## Offline old-reader evidence

Run `node herdr/compat.mjs OLD_BUNDLE NEW_ROOT [--json] [--out FILE]`. NEW's
format list is authoritative, including when OLD predates this inventory. The
checker invokes NEW writers and OLD readers with absolute module paths in
subprocesses, isolated HOME, fleet, record, Git repositories and resource paths,
with a refusing native Herdr stub. It never invokes `release.sh` or acceptance.

Each row reports `pass`, `fail` with subprocess diagnostics, or a named
`not-covered`. Coverage scopes distinguish a status read or refused train from
recovery of a successfully integrated job. A nonzero reader result fails even
when the CLI itself can render other data. Missing reader modules and explicit
gaps stay visible. Any failure exits nonzero and requires KEEP/forward recovery;
zero failures do not certify the named gaps or authorize a project switch.
Every switch still accounts for live/queued owners, affected formats and entry
points, admission stop, bound-job drain and the recovery action.
