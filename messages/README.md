# Session messages (shadow only)

ARCH-33 stage 7 implements the adopted RES-3 report, sections 4 and 7, locked at
`a28bf36d`. Node built-ins only. This module records **what would happen**; it
does not send, acknowledge, route, schedule, call a model, start a service, or
transfer delivery ownership. The existing supervisor inbox and identity-desk
helper remain the delivery owners. No file in another identity is written.
Nothing here appends `.org/events.jsonl` or changes derived record status.

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

## Mirrors and classification

`supervisor/prompt-supervisor.mjs::enqueueSupervisor` schedules one best-effort
observation **after** its original inbox transaction releases its lock. It uses
the original notice's time, ID and durable ordinal. This covers watcher notices
rendered by `watch/notice.mjs`, `watch/watch.mjs`, promotion queue notices and
other inbox callers. Watch supplies validated outcome/verdict/deferred-scope
evidence; promotion supplies its actual outcome. No notice renderer, text, tags,
quiet gates, autopilot policy or uncertain-delivery behavior changes.

`supervisor/request.mjs` schedules an observation only after its existing prompt
succeeds. Its UUID is generated once per invocation (the legacy helper has no
durable request ID); repeating a command is a new request. Uncertain/refused
delivery is still held for inspection by that helper, never retried by messages/.

Mirrors use `eventId = legacy:<sha256(source)>:<existing-id>`, producer channel,
source-derived epoch and the original inbox ordinal. A desk invocation uses its
UUID-derived epoch and sequence 1. Exact legacy text is retained as a private,
content-addressed body; no transcript, environment dump or terminal buffer is
collected. Producer redaction remains the producer's responsibility.

`legacy-shadow:<hash>` role bindings are **observational keys**, explicitly
marked `unverified-legacy-binding`. They do not claim enrolled or authenticated
occupants and can never be used to deliver. Identity comes from `BRAIN_IDENTITY`
or an ancestor `.identity-root`; the sender's project identity comes from the
existing inbox binding or read-only Git discovery, never a workspace label.
An identity-desk recipient uses the canonical identity root supplied by the
request helper (`~/development/<identity>`, carrying a regular `.identity-root`
marker) as its observational `projectRef`. This directory need not be a Git
checkout. Explicit requests to a marked desk classify on the supervisor path.
If the target directory or marker is missing/unreadable, or the marker is not a
regular file, a `legacy.message.unresolved` observation preserves the intended
target with path `unknown` and `wouldWake: null`; no recipient scope is guessed.
The marker is a local scope hint, not authentication or an enrolled binding.
Enrolled authority/recipient validation belongs to stage 8.

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

No delivery code awaits mirror work. Shadow filesystem/Git operations
have no lock waits or shadow retry loop; in-process shadow writes serialize
among themselves. Synchronous throws, asynchronous failures and even diagnostic
callback errors are contained. Failures emit a local `message shadow:` stderr
diagnostic, never a supervisor notice; the original text and result remain intact.
Observation is best-effort, not durable transport: process exit/crash/contention
can miss a mirror. There is no guaranteed capture count or automatic backfill.

## Journal and report

Default partition:
`<identity-root>/.herdr-brain/logs/<identity>/<sha256(canonical-common-dir)>/`.
The identity root is the nearest ancestor of the canonical Git common directory
with a regular `.identity-root` file; a linked worktree uses the same root as its
canonical checkout. The `root` library option (or report's `--root`) wins over
`BRAIN_SHADOW_ROOT`, which wins over this default. Only an unmarked project
falls back to `~/.local/state/herdr-brain/logs`, for example with `BRAIN_IDENTITY`
set. Setting `BRAIN_IDENTITY` changes the logical identity, not marker discovery
for storage. Mirrors and `shadow-report` share the same root resolver, so a
report needs no root override to find default observations. No existing journal
is migrated or deleted.

Symlinked markers and identity-root directories are refused. Existing storage
components from the selected root through the partition must be private real
directories; the default also checks `.herdr-brain` before descending into it.
Newly created directories are 0700; bodies, journal and exclusive writer lock are
0600. Nonprivate files/directories and symlink journal targets are refused.
The journal is always named `shadow.jsonl`, separate from record storage.

One immediate exclusive `writer.lock` per partition guards rebuild, comparison,
append and fsync. There is no separate mutable dedup index. Identical retries
return the original cursor and append a `shadow.disposition: duplicate`
observation. Changed content under either key appends a `conflict` observation
and rejects acceptance. Only `accepted` observations enter kind/path/wake counts;
attempt records remain available for duplicate/conflict analysis. Classification
is stored with its version/reason. Cursors order shadow observations, not record
events or semantic actions. Bodies may remain after a failed append.

Reads tolerate an incomplete final line and report its byte count/digest; they
never hide corrupt middle lines. Appends refuse a torn tail and preserve every
byte. After a crash, inspect ownership before removing a stale writer lock;
archive evidence and explicitly repair/rotate the tail before more writes.
No automatic truncation, lock stealing, retention or deletion is implemented.

```sh
node messages/messages.mjs shadow-report --identity rewt --json
node messages/messages.mjs shadow-report --identity rewt --root /tmp/shadow-fixture --common-dir /canonical/repo/.git --since 2026-10-15T00:00:00Z --json
```

Both forms output stable JSON (`--json` uses one line). `brain.shadow-report/v1`
contains accepted counts by kind/path, yes/no/unknown would-wake totals,
duplicate/conflict attempt counts and sorted IDs, unknown IDs, and torn-tail
evidence. `--since` filters **receivedAt**, including attempts, while deduplication
always uses the complete journal. This is an offline replay baseline; it does
not choose or launch a triage model. `flushShadow()` is for tests/explicit offline
inspection; delivery callers never invoke it.

## Compatibility mapping (all section 7.8 channels)

| Channel | Envelope mapping and boundary |
| --- | --- |
| Claude `SendMessage` | Future common adapter publishes typed envelope with actual sender and explicit recipient. Native free text remains outside these guarantees; preserve native holds/refusals. Never duplicate a send through two edges or use a model-waking edge for control kinds. No native adapter is installed here. |
| Herdr direct prompts | Future envelope delivery owner alone uses the existing quiet/occupant gates for either harness. Work dispatch retains its inspected uncertain-prompt recovery and authorized reuse. No hook, wrapper or direct-prompt daemon is added. |
| Pasted chat relays | Actual relayer as from; original question/decision in a scoped body; correlation/reply_to for answers; separately verified origin and decision_ref. Untyped relay stays unknown, never fyi by inference. A claimed operator origin is not authentication. |
| `[org-report]`, `[watch-*]`, `[promote-queue]`, literal `[watch]` | Preserve tags/text byte-for-byte. Attach original notice ID/source and org-qualified refs out of band, validated report/review evidence for classification. Brain-owned paths are mirrored here; BCH literal watch is documentation only. |
| BCH `[auto-review]` and legacy `.msg` outbox | BCH-owned: **no BCH files or daemon are touched**. Future read-only mirror maps stable file identity/digest before original-owner removal/ack. Keep unsupported-role distinct from deferred scope and other skips. Its text delivery log is not Brain JSONL. Preserve PAUSED/backoff; never implicitly start a second daemon. |
| Identity desks | Existing `request.mjs <identity> <text>` retained. Stage 7 resolves the recipient scope from the canonical directory carrying `.identity-root`; a missing marker stays unresolved. Canonically enrolled desk bindings and correlated responses belong to future transport. Receiving identity owns its record, files, lanes and reviews. Current helper still owns readiness, delivery and uncertainty. |
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
delivery owner. Shadow data cannot authorize such a transfer. To reverse stage
7, disable mirror calls and preserve its journal; existing delivery stays intact.

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
