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
specified below. The unversioned release pin is deliberately closed to extra
keys. Identity desks are a procedural protocol, not a versioned JSON document.
These two exceptions must not be described as extensible JSON schemas.

## Directory and display contracts

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `fleet.json`, `version: 1` | Each project's explicit `monitor fleet join`, under the installation fleet lock. `$HERDR_MONITOR_FLEET/fleet.json`, default `~/.herdr-monitor/fleet.json`; the variable selects a directory. | Record discovery/ownership checks, lane/routes discovery, fleet views, retirement and project conversations. | `lib/fleet.mjs:188` (`joinFleet`), atomic write at `lib/fleet.mjs:282`; load/header validation `lib/fleet.mjs:25`, project/uniqueness validation `lib/fleet.mjs:39`, `readFleet` at `lib/fleet.mjs:57`, scoped ownership checks at `lib/fleet.mjs:62`. | Unknown fields are accepted; version must be 1. Full reads validate every project; scoped reads still prove that unrelated entries cannot claim the selected identity/record. Malformed or ambiguous ownership is an error, not a guessed mapping. |
| `project-summary/v1` (`schema`) | The owning project's canonical-checkout publisher, normally its housekeeping tick (`housekeeping/housekeeping.mjs:195`) or `record summary publish`. `<record>/published/summary.json` and `summary.md`, switched together by a generation symlink. | `supervisor/status.mjs:173` reads freshness; record summary reads freshness; human/operator consumers read the published projection. A cross-project reader reads this publication, not the owner's event log. | Allowlisted projection `lib/project-summary.mjs:58`; collector at `lib/project-summary.mjs:116`; atomic publisher `lib/project-summary.mjs:162`; freshness/schema/project validation `lib/project-summary.mjs:221`; Markdown consumer `lib/render.mjs:575`. | Extra fields are ignored by these consumers. Missing/invalid/future observation times, wrong schema or wrong expected project are not fresh. Age beyond `stale_after_seconds` is stale. The status reader validates the envelope, not every payload field; the renderer expects the complete publication. |
| `lanes-status/v1` (`schema`) | Each project observes its own runtime; `supervisor/retire.mjs status --json`. `--out FILE.md` publishes Markdown, not a JSON file. No stored lane status. | Terminal/Markdown renderer, the summary collector, operator, housekeeping retirement diagnostics. | Projection/class counts `lib/retire-status.mjs:145` (document at `lib/retire-status.mjs:232`); observer `lib/retire-runtime.mjs:797`; CLI at `lib/retire-runtime.mjs:850`; renderer `lib/retire-status.mjs:238`; summary consumer `lib/project-summary.mjs:85`. | Readers use known fields and ignore extras. There is no independent full-document/schema validator: the renderer and summary consume an internally produced object. Do not treat rendering as acceptance of an arbitrary external schema version. New breaking output needs a new schema. |
| `board-rows/v1` (`schema`) | Each project owns its read-only source script. Brain's built-in writer projects that project's promotion queue; `board --source NAME=SCRIPT` admits a per-project adapter. JSON stdout, not a shared status database. | Promotion board and the lanes view; the summary collector consumes validated built-in rows. | Brain writer `board/brain.mjs:56`, asynchronous API `board/brain.mjs:122`, synchronous API `board/brain.mjs:141`; adapter envelope check `board/source.mjs:46`; document/field validators `board/rows.mjs:79`, `board/rows.mjs:42`; board reader `board/board.mjs:51`, lanes reader `lib/retire-runtime.mjs:835`. | Extra document/row fields are ignored. Older rows without `clocks` produce an empty list; clocks without `legacy` default to false. Unknown schema becomes a `source-schema` diagnostic row. Invalid presentation fields become `withheld`; paths/panes require independently supplied roots/inventory. |

Fleet v1 requires `session_limit` and a `projects` map. Each project maps an
absolute canonical Git common-directory `identity` to `checkout`, `record`,
`worktrees` and `layers`. Names, remotes and workspace labels are not ownership.
It is a directory, never a status channel. The board takes explicit project/source
paths rather than deriving them from the fleet (`board/board.mjs:11`).

Summary v1 publishes project identity/name, observation time and freshness limit,
status counts, today's landings/decisions, lane counts and oldest unresolved
rows, release IDs and named exceptions. Freshness defaults to at least 300
seconds (`lib/project-summary.mjs:21`, `lib/project-summary.mjs:156`). At the
audited revision the release helper reports installed `current` and **always
returns `pinned: null`** (`lib/project-summary.mjs:48`); the implemented pin
selector below must not be confused with summary integration that has not landed.

Lanes v1 has `generatedAt`, `project`, `held`, `counts` and `rows`. The six classes
are `TERMINAL`, `ACTIVE`, `WAITING`, `IDLE-NONTERMINAL`, `UNKNOWN` and `PROTECTED`
(`lib/retire-status.mjs:7`). Worktree inventory rows can have `class: null` and
are excluded from class counts. These are display facts, never cleanup authority.

## Host occupancy and installed releases

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `occupancy/v1` (`schema`) | Each shared-work process owns its file in `<test-slot-lock>.occupancy/`. Atomic creation and updates; only its owner releases the file. | Slot diagnostics/wait display, board, retirement's keep references. Occupancy grants no exclusive admission or queue position. | `test-slot/occupancy.mjs:102` (`sharedOccupancy`); owner/liveness validation `test-slot/occupancy.mjs:51`; directory reader `test-slot/occupancy.mjs:82`; slot consumers `test-slot/test-slot.mjs:315`, `test-slot/test-slot.mjs:660`; board `board/facts.mjs:51`; retirement `lib/retire-runtime.mjs:140`. | Extra fields are accepted. Older records can omit birth identity, cwd and newer display fields. Missing/uncertain live identity is reserved conservatively. Unknown schema versions are skipped and never pruned; malformed files surface as unknown. `prune` is opt-in and only removes proven-gone v1 records with unchanged bytes. |
| `herdr-release/v1`, `protocol: 1` | Brain's release build writes `.release-manifest.json` beside `.release-commit` in an immutable installed bundle, normally `~/.local/share/herdr-monitor/releases/TAG/`. | Launch admission, explicit project pin acceptance and immutable job continuations through `lib/releases.mjs`. | Manifest writer `herdr/releases.mjs:13`; inventory `lib/product-files.mjs:12`; header/mandatory entries/hash validation `lib/releases.mjs:168`; immutable release path validation `lib/releases.mjs:186`; continuation identity check `lib/releases.mjs:261`. | Extra manifest fields are ignored; schema/protocol/commit must match. Build and pin verify all inventory hashes; ordinary admission checks headers and mandatory entrypoints without reading every payload. Legacy **unpinned** current bundles may lack a manifest (`lib/releases.mjs:194`); this is not permission to accept a bad project pin. |
| `.herdr-release.json`, **unversioned** | The project's owner writes `{"release":"TAG"}` or `{"release":null}` with `herdr/releases.mjs pin/unpin` in its canonical checkout, then commits it to accept the choice. | Project-aware launchers, dispatch/settle/promotion/housekeeping admission. | Writer `herdr/releases.mjs:33`; committed canonical HEAD reader and closed-key validation `lib/releases.mjs:120` (keys checked at `lib/releases.mjs:152`); selection `lib/releases.mjs:194`; immutable continuation `lib/releases.mjs:254`. | Exactly one key, `release`; **unknown keys are rejected**. Absence/null selects current. Lane edits and uncommitted canonical edits do not select a release. An invalid accepted pin fails closed. A breaking extension needs an explicitly coordinated new config contract/reader, not an extra field in this file. |

Occupancy v1 contains shared class, PID/start/birth identity, optional group
identity, label, cwd, host, informational project identity, acquisition/start
times, reason and optional `profile_id` (`test-slot/occupancy.mjs:109`).
**Occupancy v2 is planned, not implemented here**: there is no current writer or
validator for reservation GiB, expected end or expiry. A v2 document is an unknown
version to the current reader; the conformance case proves it survives untouched.

## Journals and hook delivery

| Identifier / version | Owner (writer) and location | Readers | Writer and validation code | Compatibility |
| --- | --- | --- | --- | --- |
| `brain.log/v1` (`schema`) | Producers own origin events; the identity-owned foreground journal adds stream/cursor/received time. `logs/journal.mjs` writes `segment-N.jsonl`; legacy shadow mirrors write `shadow.jsonl` in the same partition convention. | Log input/view/detector tools, shadow reader and addressed-message receiver. | Record/source envelopes `logs/inputs.mjs:30`, `logs/inputs.mjs:93`; segment writer `logs/journal.mjs:161`, append validation `logs/journal.mjs:174`, segment reader `logs/journal.mjs:91`; desk/notice origin writer `messages/mirror.mjs:71`, shadow append/read `messages/journal.mjs:99`, `messages/journal.mjs:65`; shared structural validator `messages/schema.mjs:107`, parser `messages/schema.mjs:166`. | Extra JSON fields are accepted within size/type bounds; duplicate JSON keys are rejected. Optional origin/cursor fields can be absent in origin envelopes. Unknown event types remain inert, but must have a valid v1 envelope. An unknown schema version is rejected. Identical event/producer keys deduplicate; changed content under a key is a conflict, not an update. |
| `brain.transport/v1` (`schema`) | The local receiver exclusively appends acceptance, receipts, owner and fence records to explicit `ROOT/transport.jsonl`. Current mutations are **fixture-only**, not a live cross-identity broker. | Receiver state/status, transfer rehearsal, hook handoff and consumption. | Transaction writer `messages/receiver.mjs:103` (record envelope at `messages/receiver.mjs:109`); synchronous intent writer `messages/receiver.mjs:306`; JSONL/header/sequence reader `messages/receiver.mjs:43`; fold `messages/receiver.mjs:58`; embedded events validated at `messages/receiver.mjs:63`. | Extra fields are ignored by the fold; unknown record types are inert. Schema and contiguous sequence remain mandatory; torn/corrupt journals fail closed and preserve evidence. The init-only historical shape remains readable. Adding a record cannot grant new enrollment or clear a refusal. |
| `hook-pull/v1` (`receipt.transport`) | Receiver `claimNext` owns the durable claim receipt; `messages/hook-pull.mjs` renders Stop/UserPromptSubmit JSON for the harness. Receipts live inside `brain.transport/v1`, not in a separate hook schema file. | Harness reads hook output; receiver/handoff reads receipts; subsequent `Receiver.consume` records exposure. | Claim/receipt writer and enrollment guards `messages/receiver.mjs:243` (receipt at `messages/receiver.mjs:263`); hook input guards/output writer `messages/hook-pull.mjs:20`; handoff reader `messages/hook-pull.mjs:38`; consume reader/verification `messages/receiver.mjs:224`. Related launch-descriptor writer/validator `messages/hook-session.mjs:12`, `messages/hook-session.mjs:47`. | Unknown hook input and receipt fields are ignored. Stop continuation guard, exact `inbox` nudge and cwd/consumer/session checks still apply. A claim is delivered with processing unknown; no automatic replay or exactly-once understanding claim. A breaking receipt/adapter meaning requires a new transport version. |

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
| `herdr-reference/v1` (`schema`) | The claiming supervisor/tool atomically publishes its own `<record>/references/JOB.json`, then removes it when finished. **No bundled writer is required or implemented.** | Retirement observation/planner, with keep-only authority. | External writer format/atomic-rename requirement and example `supervisor/README.md:277`; actual validator/reader `lib/retire-runtime.mjs:53`; integration `lib/retire-runtime.mjs:75`. | Unknown fields are accepted. Required owner/kind/job/state/item/creation/expiry fields cannot be removed; run/lane/cwd/pane are optional. Expired valid references are ignored with a diagnostic. Invalid/unreadable/unknown-schema references hold the project, even if apparently expired. They never release resources. |
| Identity desks, **unversioned procedural contract** | Requester invokes `node supervisor/request.mjs IDENTITY TEXT`; the owning identity receives at `desk-IDENTITY` in `~/development/IDENTITY` and records/implements its own work. No shared request JSON file. | Herdr's native agent CLI and the receiving identity's instructions/human-readable request. The optional shadow mirror is a separate brain.log observation. | Request validation/CLI writer `supervisor/request.mjs:10`; name/cwd `supervisor/request.mjs:18`; strict Herdr response reader `supervisor/request.mjs:20`; native creation/readiness/delivery `supervisor/request.mjs:32`; mirror origin `messages/mirror.mjs:91`. | Herdr inventory/result extra fields are ignored. Identity is a single safe directory name; request text is passed literally as one argv value. Requester explains what/why/done/evidence; no machine validator exists for that prose. Existing desk naming/CLI semantics must stay compatible or be coordinated with owners. Never edit the recipient's files or forward a harness refusal. |

## Offline conformance and existing drift coverage

`test/contracts-conformance.test.mjs` has one current-writer and one
installed-writer case for each row above. It feeds actual writer output to the
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
module's contract. Listing a reader of such state above does not turn that state
into a cross-project coordination API.
