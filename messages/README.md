# Session messages

Replies, status and milestones belong in the owning item/run record as notes or
the report. Routine notices go to the line and recorded owner through existing
callbacks, never to a chat. One operator chat writes authorized work directly to
the record; only genuine pending operator questions use push delivery. The
operator selected Quiet Chat (w3PD:p4) on ENG-933: genuine operator questions only,
one short message with a recommendation; status, milestones, logs and FYIs stay
in the record. ENG-939 owns applying that choice through the supported native
routing path. The native inbox adapter described below still names brain-chat;
this instruction does not activate the selected route, and the retired binding
is not a delivery fallback. Preserve saved callbacks, watchers and original
pending, refused or uncertain deliveries; do not replay them or add a chat relay.

The [operator record inbox](#operator-record-inbox) is a foreground record command
using the existing native inbox. The supervisor inbox and identity-desk helper
remain the delivery owners. Node built-ins only.

Worker exceptions use the brief's pinned source command for
[`supervisor/prompt-supervisor.mjs`](../supervisor/README.md) with
`--project-supervisor`, the recorded project address and one stable notice ID.
It appends to the existing `ORG/supervisor/inbox.log` before native input and
keeps missing supervisor bindings pending across a recycle. Retain an item/run
note and the actual receipt too. Do not use direct `herdr agent prompt`, resend
refused/uncertain input, change an existing callback or substitute operator
`messages send` for this internal path. The existing inbox owner and native
quiet/identity gates still own delivery.

The optional shadow writer and staged turn-hook delivery transport were retired
by ENG-934. No new shadow notice/body copy, hook enrollment, nudge or hook claim
is produced. Existing record envelopes, notices, unresolved claims and historical
bytes are preserved. The schema, classifier and private partition checks remain
shared with the foreground logs module; historical shadow reports stay readable.

## Envelope and validation

`schema.mjs` exports `validateEvent`, duplicate-key-aware `parseEvent`/`parseJSON`,
`canonical`, and the explicit `verifyBody` consumption helper. The version is
`brain.log/v1`; a message has `type: session.message.v1`. The whole event is
bounded to 16 KiB and JSON depth 32, including inert future fields. The schema is:

| Field | Contract |
| --- | --- |
| `eventId`, `producer` | One message ID; producer `{id, epoch, sequence}` with a positive safe integer sequence. Both the ID and producer tuple are deduplication keys. |
| `occurredAt`, `level`, `identity`, `project.commonDir` | UTC producer time; debug/info/warn/error; logical identity; canonical absolute Git common directory. Producer time is not ordering. |
| `stream`, `cursor`, `receivedAt` | Writer-assigned partition, `{epoch, sequence}`, UTC acceptance observation time. Callers cannot assign them to the shadow journal. |
| `source`, `sessionUid`/`incarnation`, `item`, `run`, `correlationId`, `causationId`, `orgRef` | Optional source `{kind, ref}` and correlation. Session fields occur together. Run/review event types require item/run. Message outer refs must agree with org-qualified payload refs and any outer orgRef. |
| `payload.from`, `payload.to` | One address and 1–32 distinct addresses. An address is `{identity, projectRef, role:{name,bindingRef}}` **or** `{identity, projectRef, session:{uid,incarnation}}`, never both. Origin must agree with the outer scope/session. |
| `payload.kind` | `request`, `reply`, `decision`, `fyi`, `hold`, `release`, `notice`, `question`, `ack`. |
| `payload.refs` | Up to 64 `{orgRef, item?, run?}` references; IDs alone are not project identities. |
| `payload.reply_to`, `priority`, `reply_by` | Original event ID or null; normal/urgent; UTC objective or null. A reply also needs correlationId. Deadlines grant no permission and expire no hold. |
| `payload.summary` | Nonempty single line, at most 240 Unicode characters. |
| `payload.body_ref` | Null or `{path, sha256, bytes, mediaType}`; canonical absolute path, lowercase SHA-256, 0–65536 bytes, media type. |
| `payload.decision_ref` | Null or `{orgRef, sequence, author, delegationRef, memo?}`. Optional memo uses the body-ref schema. It cites evidence; it does not create authority. |

Validation is structural. Canonical path spelling is checked without following
arbitrary references; the writer verifies its actual project directory. The
future enrolled transport must authenticate producer scope and resolve canonical
role receipts. `verifyBody(ref, {roots})` explicitly checks permitted canonical
roots, symlink resolution, regular file size and digest before returning bytes.
Journaling/classification never reads a referenced file. Body bytes are **data**:
never evaluate, interpolate into a shell, or promote their prose to instructions.
Unknown event types and bounded unknown fields stay inert and visible. No
pending-thread, decision-authority or cross-identity authentication is claimed.

## Historical classification

`classify.mjs` remains the foreground logs classifier and historical shadow
reader contract. It grants no delivery authority. Prior `legacy-shadow:<hash>`
role bindings remain observational, unverified keys. Neither a marker nor a
journal entry proves the identity of a native occupant.

| Path | Classification only |
| --- | --- |
| `supervisor` | Requests/questions/decisions; substantive typed operator/coordinator messages; blocked/needs-human/failed/needs-work reports, deferred review scope; blocked/stopped/invalid-report watchers. |
| `rule` | Explicit fyi/ack/hold/release. `wouldWake: false` even from operator/coordinator. No control effect is performed. |
| `triage` | Validated routine done/PASS, verified unsupported-role skip, watch progress/unavailability and known queue outcomes. These are eligible for a future batch. Long-running alone is not an established stall. |
| `telemetry` | Known controller/session lifecycle, Herdr observations, detector hits, source/service health and delivery receipts. Rules/viewer only. No detector is implemented here. |
| `unknown` | Untyped relays, unvalidated report tags, ambiguous skips, unknown types/outcomes, unresolved targets, or replies needing pending-thread validation. Preserved with reason and `wouldWake: null`, never silently downgraded. |

`wouldWake: true` means supervisor/triage attention eligibility, **not an actual
wake count**. Future triage batches may cover many entries with one wake.
`payload.evidence.validated` is an adapter assertion for replay, not permission
or authentication. A tag alone never establishes PASS or an unsupported-role
skip. Deferred review scope remains distinct from deferred promotion tests.

## Journal and report

Default partition:
`<identity-root>/.herdr-brain/logs/<identity>/<sha256(canonical-common-dir)>/`.
The identity root is the nearest ancestor of the canonical Git common directory
with a regular `.identity-root` file; a linked worktree uses the same root as its
canonical checkout. The `root` library option (or report's `--root`) wins over
`BRAIN_SHADOW_ROOT`, which wins over this default. Only an unmarked project
falls back to `~/.local/state/herdr-brain/logs`, for example with `BRAIN_IDENTITY`
set. Setting `BRAIN_IDENTITY` changes the logical identity, not marker discovery
for storage. `shadow-report` retains the original resolver, so historical
observations need no root override. No existing journal is migrated or deleted.

Symlinked markers and identity-root directories are refused. Existing storage
components from the selected root through the partition must be private real
directories; the default also checks `.herdr-brain` before descending into it.
`JournalScope` supplies only location and private-directory checks for the logs
writer. It has no shadow append method. `shadow.jsonl` and its body archives are
historical input, separate from record storage. Reads refuse symlink/nonprivate
files, report incomplete final lines by byte count/digest, and reject corrupt
middle lines. No lock removal, repair, truncation, retention or deletion is added.

```sh
node messages/messages.mjs shadow-report --identity rewt --json
node messages/messages.mjs shadow-report --identity rewt --root /tmp/shadow-fixture --common-dir /canonical/repo/.git --since 2026-10-15T00:00:00Z --json
```

Both forms output stable JSON (`--json` uses one line). `brain.shadow-report/v1`
contains accepted counts by kind/path, yes/no/unknown would-wake totals,
duplicate/conflict attempt counts and sorted IDs, unknown IDs, and torn-tail
evidence. `--since` filters **receivedAt**, including attempts, while deduplication
always uses the complete journal. This is an offline replay baseline; it does
not choose or launch a triage model. No mirror callbacks or flush API remain.

## Compatibility mapping (all section 7.8 channels)

| Channel | Envelope mapping and boundary |
| --- | --- |
| Claude `SendMessage` | Future common adapter publishes typed envelope with actual sender and explicit recipient. Native free text remains outside these guarantees; preserve native holds/refusals. Never duplicate a send through two edges or use a model-waking edge for control kinds. No native adapter is installed here. |
| Herdr direct prompts | Future envelope delivery owner alone uses the existing quiet/occupant gates for either harness. Work dispatch retains its inspected uncertain-prompt recovery and authorized reuse. The staged hook-pull writer is retired; no wrapper or direct-prompt daemon is added. |
| Pasted chat relays | Actual relayer as from; original question/decision in a scoped body; correlation/reply_to for answers; separately verified origin and decision_ref. Untyped relay stays unknown, never fyi by inference. A claimed operator origin is not authentication. |
| `[org-report]`, `[watch-*]`, `[promote-queue]`, literal `[watch]` | Preserve tags/text byte-for-byte. Attach original notice ID/source and org-qualified refs out of band, validated report/review evidence for classification. No new shadow projection is written; existing owned notices retain their original transport. |
| BCH `[auto-review]` and legacy `.msg` outbox | BCH-owned: **no BCH files or daemon are touched**. Future read-only mirror maps stable file identity/digest before original-owner removal/ack. Keep unsupported-role distinct from deferred scope and other skips. Its text delivery log is not Brain JSONL. Preserve PAUSED/backoff; never implicitly start a second daemon. |
| Identity desks | Existing `request.mjs <identity> <text>` retained. The receiving identity remains responsible for its own record and native binding. Canonically enrolled desk bindings and correlated responses belong to future transport. Receiving identity owns its record, files, lanes and reviews. Current helper still owns readiness, delivery and uncertainty. |
| Coordinator memos | Scoped body_ref plus decision_ref (record, sequence, author/delegation) and bounded recipients. Verify independently supplied hash/origin; a newly computed hash authenticates nobody. Retain permitted bytes before future transport acceptance. |
| Slot locks, tickets, wait files | Hold/release/ack describe advisory intent for resource+epoch+issuer+hold_id; preserve the owner-bound real lock and ticket protocol. Messages neither grant admission nor prove cleanup. Release tombstones and scope enforcement are future stage 9, not a shadow effect. |
| Record notes | Reference canonical org/item/run/decision sequence as evidence. Material dispositions still use the existing record CLI; record notes are not inbox deliveries. No transport events, routine ack notes or stored status are added to events.jsonl. |

Message data never grants authority. A hold/release never grants or deletes a
lock, releases another issuer's hold, or lifts `.org/STOP`, supervisor STOP,
PAUSED or `HOLD-WORKER-TAB-CLOSE`. Deadlines and restarts lift nothing. An actual
harness/sandbox/classifier refusal is never forwarded to another session,
identity, tool or transport to perform the refused action; take it to the
operator through an already permitted path and continue independent work.

Stages 8–10 must fence/watermark and reconcile in-flight IDs before changing a
delivery owner. Shadow data cannot authorize such a transfer. The shadow writer is retired; its journal remains preserved and existing
delivery stays intact.

## Stage 8: offline receiver and swappable transport

Stage 7 above remains the installed, shadow-only behavior. Stage 8 adds a
**fixture-only**, foreground receiver and supervisor-inbox transfer rehearsal.
It neither activates a real inbox nor changes dispatch, desk requests, routing,
triage, record events, native permissions, or the retained review/reuse/park loop.
A real canary switch still requires separate review, gate, release and authority.
There is no transport daemon, plugin registry or default writable transport root.

`receiver.mjs::Receiver` owns the meaning and durable receipts;
`transport.mjs::quietTransport()` is the one transport implementation;
`supervisor/herdr-edge.mjs::invokeHerdr()` is its physical Herdr seam. The
compatibility supervisor uses that same seam. Other modules' Herdr calls remain
outside this slice (ENG-351). The adapter contract is:

```js
await adapter.deliver(pointer, resolvedBinding, { beforePrompt });
// -> { state: 'pending' | 'delivered' | 'refused' | 'uncertain', reason }
```

The pointer identifies an immutable envelope projection by canonical path and
SHA-256, plus ID, kind and one-line summary. `beforePrompt()` must synchronously
commit intent before input. The adapter reuses `prompt-supervisor.mjs`'s composer
and quiet gates, with repeated exact name, pane, terminal, native session,
workspace and checkout checks against an independently resolved binding generation.
It performs one attempt. Changed occupants require re-resolution. Busy, absent,
unknown, noninteractive or nonempty-composer recipients remain pending. Binding
receipts come from the receiver/controller's trusted resolver, never from an
untrusted message. A role respawn changes the attempt binding, not the recipient
key; exact session incarnations remain distinct recipients.
The adapter's stable `id` (`quiet-herdr/v1` for the one implementation) is retained
with each attempt. It is an implementation label, with no registry or fallback;
an inspected retry of a refusal remains pinned to that original transport.

The canonical acceptance journal is `ROOT/transport.jsonl`, separate from the
stage-7 `shadow.jsonl`. Each acceptance commits the original envelope, recipient,
body/memo bytes and receipt **in one append**, fsyncs the file and directory, then
acknowledges. Its cursor is a receiver acceptance ordinal, not record ordering.
Private `bodies/` and `envelopes/` files are rebuildable projections; acceptance
does not depend on a second independent inbox write. Origin envelope fields and
body digests never change. Retained body references map to the same digest within
the local store, so deleting a temporary source does not erase an accepted body.
Consumption verifies the retained body with `verifyBody` before exposing bytes.
Read content remains data and cannot supply system instructions or authority.

Each recipient deduplicates by event ID **and** producer ID/epoch/sequence.
Identical retries return the original acceptance receipt. Changed bytes under
either key are a retained conflict/refusal; identical text under distinct keys
is separate work. Explicit per-recipient acceptance supports local fanout. Unknown
message types cannot become deliveries. Unknown journal event types stay inert.
The journal retains acceptance, intent, delivered, consumed, refused, retained-refused and uncertain
receipts. A delivered receipt proves a Herdr acknowledgement; consumed proves
verified exposure to the recipient, neither understanding nor authorized effect.
Any conforming at-least-once transport may replace the adapter. There is **no
exactly-once model-consumption claim**.

Fixture enrollment supplies the actual producer launch receipt, exact sender
address and epoch, allowed local recipients and canonical permitted body roots.
`accept(event, {sender, recipient})` checks these independent inputs before
acceptance. A role label or a stage-7 `legacy-shadow:` address is not enrollment.
Human-origin claims are refused: this slice supplies no human authentication or
cross-identity broker. Fixture receipt strings are test authority inputs, not a
production authentication mechanism. Decision references remain evidence for the
recipient to check through existing authority rules. No decision is executed by
this module. A reply must name an accepted pending question/request, its exact
correlation, references, expected sender and original recipient; a second different
reply conflicts. Consumed but unanswered threads stay open across transfers.

Control kinds `fyi`, `ack`, `hold`, `release` are retained and rule-consumed without
a binding lookup, adapter call, model wake, or ack-for-ack. This is no new routing
or admission policy: no control message changes a lock, STOP, PAUSED or hold file.
A refusal holds the action even if a caller supplies another adapter. An unknown
prompt result, lost acknowledgement, or abandoned durable intent is uncertain;
restarting or changing owners cannot replay it. `resolveUncertain` requires an
explicit inspected disposition and evidence; only verified non-delivery can make
the same ID pending again. `resolveRefused(id, recipient, {disposition, evidence})`
also requires nonempty inspection evidence. `pending` records verified non-delivery
and allows the same ID to retry through the original transport and quiet gate
after the refusal has been resolved through its owning path. It grants no new
permission. A different adapter cannot perform that retry. `retained-refused`
keeps the envelope, bodies and refusal as a known terminal delivery disposition,
without another offer or a consumed/delivered claim. It permits later messages
and a fenced transfer to proceed. Historical refusals with no recorded transport
identity can be retained, but cannot retry through a guessed edge.
Dispatch's separate `--accept-delivered`/`--resend`
recovery and authorized `--reuse` remain unchanged.

### Offline transfer runbook

This is text for a rehearsal, **not a live activation procedure**. Only a private,
canonical, disposable `os.tmpdir()/brain-transport-*` root with a regular `FIXTURE`
file containing `brain.transport-fixture/v1` plus newline can mutate state. There
is no environment-variable or live-path bypass. Tests create this root and explicit
local enrollments with `Receiver.initialize`. All body roots must be within it.
The absence of a new default root keeps `offline-herdr`'s existing containment
intact; tests also prove missing/foreign roots cannot create transport state.

1. Initialize the fixture receiver with its supervisor enrollment and a scoped
   legacy-inbox importer with an explicit target name, referencing only
   `ROOT/inbox.log`. Do not use shadow
   observations as delivery/authority evidence.
2. `SupervisorTransfer.enroll()` acquires the original inbox's owner, drain and
   journal locks. A live/unidentified compatibility or autopilot-policy owner
   blocks enrollment before any fence marker or import, so a policy result can
   finish recording its existing escalation text before retrying enrollment.
   An absent fixture
   inbox is created and its directory entry fsynced before intake can spool.
   It durably fences
   the compatibility delivery entrypoints with an explicit fixture marker and
   imports notices with stable source/notice IDs and original ordinal. Import
   commits known sent/handled or uncertain dispositions atomically with
   acceptance. A legacy retry with `may_have_delivered: false` remains pending
   under its original notice ID; `true` remains uncertain. A dead unresolved
   autopilot owner also imports as uncertain.
3. After enrollment, compatibility enqueue still durably appends original notice
   bytes. Its policy, resume and direct drain paths cannot send. The foreground
   fixture controller is the sole dispatcher for both owner phases, using the
   same adapter. `syncIntake()` projects newly spooled notices into the receiver;
   it neither acknowledges/removes originals nor creates fresh IDs on retries.
4. `switch` fences intake under the original inbox lock at a durable receiver and
   legacy watermark. Later arrivals spool durably, in either accepted receiver
   entries or the compatibility log. The old owner can drain only entries through
   that watermark; new arrivals cannot be sent by either owner during the drain.
5. Call the foreground fixture controller's `drain(adapter, resolveBinding)` until
   old work has known delivered/consumed or inspected `retained-refused` receipts.
   Pending, refused or uncertain old work holds cutover. Inspect a refusal and use
   `resolveRefused` with `pending` only after verified non-delivery and resolution
   of the original refusal; then re-drain through the same transport. Otherwise
   explicitly retain it with `retained-refused` and the inspection evidence.
   An active offer excludes owner commits with the separate
   delivery lock. Acceptance can continue during an in-flight offer.
6. Retry `switch`. It commits exactly one replacement owner only after the drain.
   The replacement reads the same journal, then can deliver spooled work. Repair
   compatibility sent projections from receiver receipts; never reverse that
   evidence direction or reset a hold from an old pending entry.
7. `reverse` repeats the fence, spool and drain, returning to the legacy **fixture
   controller** phase on the same journal. It does not remove the fixture fence or
   reactivate the old automatic retry worker. Open threads, exact IDs, bodies,
   dedup state, recipient incarnations, authority evidence and holds are retained.
   This intentionally bounds the rehearsal; enabling the real compatibility or
   replacement worker is the later live adoption step.

Use the canonical root returned by the test fixture setup as
`transport_fixture_root` (the temporary directory varies by host):

```sh
node messages/messages.mjs status --root "$transport_fixture_root" --json
node messages/messages.mjs switch --root "$transport_fixture_root" --json
node messages/messages.mjs reverse --root "$transport_fixture_root" --json
```

`status` is inspect-only (owner, last watermark, active fence, pending/spooled,
uncertain, refused, retained-refused, open threads and retained receipts). `switch`/`reverse` never
invoke Herdr or drain implicitly; they return held IDs until the explicit fixture
drain has completed. Repeating a completed direction is idempotent. These commands
require an explicit root; `shadow-report` and its default roots are unchanged.
Legacy wake text is the original bytes (or its already-recorded policy escalation
summary) plus its existing ` notice-id=...` suffix, including multiline notices. New wakes contain an escaped one-line summary and
permitted pointer only. Neither renderer reinterprets body text.

Crash recovery is inspect-first: a torn journal tail blocks reads/mutations without
truncating bytes; an exclusive writer/delivery lock left by a crash is never
stolen. Inspect ownership and archive evidence before explicitly repairing a tail
or removing a stale fixture lock. A crash after intent without a result holds
uncertain even if no input happened. No compaction, expiration, automatic repair,
retention deletion, alternate-transport retry or live importer is installed.

## Retired hook-pull transport

Lane worker/reviewer launches no longer read `.hook-pull.json` or issue hook
settings/descriptors. The Codex template, hook nudge, launch adapter and receiver
`claimNext` writer are removed. Ordinary native arguments and current owned
callback delivery retain their original owners. No saved runtime, pin, hook trust
or long-lived session is edited.

`hook-pull.mjs` remains a read-only compatibility entry for issued descriptors.
Saved Stop/UserPromptSubmit invocations are silent and inert. Explicit inspection
still works:

```sh
node messages/hook-pull.mjs handoff --session /absolute/session.json
```

The handoff reader retains exact committed-but-unprocessed IDs until the existing
explicit `Receiver.consume` records exposure. `persistHandoff({...,hookSession})`
continues including them in its hashed metadata. Inspection never re-enqueues,
retries, repairs, acknowledges or resets an old claim. Invalid explicit inspection
fails visibly; old hook invocations never claim pending work.

Lifecycle reset/reconstruction, manual settle-watch and retirement drivers remain
unchanged during the closeout proof. Their consumer migration and removal must
be scheduled after that proof, preserving saved attempts and native ownership.

# Operator record inbox

`record messages` is a foreground record command. It does not activate the
offline receiver/transfer below, install a controller, or call a model. Ordinary
status, fyi, done and needs-decision messages addressed to the operator stay as
`session.message.v1` envelopes in the owning record's existing event log. They
never produce pane input. Status/done use `notice`, fyi uses `fyi`, and a request
for judgment uses `question` or `request` from the existing envelope kinds.

From a natively bound Herdr session in the owning project:

```sh
record messages send --id STABLE_ID --kind notice --summary 'Automatic reviews are paused.' --happened 'We are fixing how the system chooses work to review.' --action 'Nothing needed.' --details 'item and run references; evidence locator' --item ITEM
record messages digest
record messages digest --after 18599 --limit 5 --json
```

Before installation, an adopted/pinned project selects the development entry
explicitly, preserving its owning record and actual native actor:

```sh
HERDR_BRAIN_ROOT=/absolute/development/root ORG_DIR=/owning/.org ORG_ACTOR=actual-native-name /PINNED/NODE /absolute/development/root/bin/org.mjs messages send --id STABLE_ID --kind notice --item ITEM --summary 'One-line headline.' --happened 'What happened in plain words.' --action 'Nothing needed.' --details 'technical references'
```

The selector must resolve to the invoked real Git development root. A mismatch
refuses before a messages action. This opt-in applies only to `messages`: omitted
selection and other record commands retain default project/home pin forwarding,
and immutable installed release continuations retain their original runtime.
Native/record/run guards still apply; selection supplies no authority. No pin,
installed bundle or saved job is changed.

Every OPERATOR-addressed message reads as headline, what happened, whether you need
to do anything (usually Nothing needed), then ONE trailing Details line. Author
plain main wording for a non-agent reader. Bare item/run IDs, hashes, receipt/source
jargon, file paths and shorthand such as bootstrap5 or record-only belong in Details.
Use Nothing needed only when true; pending reserved decisions need an explicit ask.
The supported `--happened`, `--action`, `--details` options add optional
`payload.operator_text` data to the same envelope; summary remains the headline.
The human digest keeps all technical metadata on Details. The machine JSON keeps
its original IDs, summary, refs, cursor and push fields and adds operator_text.
These fields confer no authority and cannot make an ordinary T2 question reserved.
Current pending reserved references override an authored Nothing needed with
Your decision is needed. Old summary-only inputs/retries remain accepted exactly.
Legacy entries use a neutral headline, their original summary in Details, and an
explicit instruction to check whether action is needed unless a real pending reserved decision is known.
No old envelope/receipt bytes are rewritten, body references opened, private files
read or model paraphraser/API used. New dispatches include the supported composition
options; old saved/delivered jobs and long-lived transports are unchanged.

`send --file /absolute/envelope.json` consumes an existing envelope. Native
sender session/terminal, run claim when present, canonical Git common directory,
owning identity, record and qualified references must match. The operator role
address uses that identity/project and `bindingRef: brain-chat`. A role/session
address, decision reference, priority, report prose or claimed tier supplies no
authority. Bodies remain referenced data and are never executed or opened by
this command. Repeating an exact ID/content/target returns its original record
entry; changed content, target or conflicting producer sequence is refused.

Only a `question`/`request` referencing a **pending human item already explicitly
marked `meta.operator_reserved: true` in the owning record** can enqueue a push.
The existing record decision/authority policy determines that mark; this command
does not create it, ask a question, authorize an action, or turn ordinary T2
judgment into operator work. Routine needs-decision remains with its named
supervisor/Brain Chat. An actual reserved ask adds `--question HUM-n` to `send`.
It sends a stable record pointer once per reserved question (also across different
envelope IDs) to the actual native `brain-chat` binding through
the existing inbox and Brain Chat filtering path, never directly to an operator
pane. That inbox retains the once-only ID, exact target/binding, correlation and
delivery receipt. Its original native named-role resolution, quiet-input checks
and ambiguous-delivery recovery remain authoritative. Missing or foreign native
bindings hold initial push. `record messages push --id ID` resumes that existing pointer,
without a second notice or an uncertain-input replay. Native failures leave the
envelope durable and report the actual held/pending/error state.

The digest defaults to the latest five one-line summaries with stable event IDs,
record sequences, qualified references, thread/reply IDs and current push state.
`--after SEQ` pages forward; limits are 1..20. Pulling a digest neither acknowledges
messages nor produces input. The source command is usable immediately; an
installed release must load this source separately; the native inbox adapter is
unchanged and keeps its existing long-lived owner.
