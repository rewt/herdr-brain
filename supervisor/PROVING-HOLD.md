# Owner-linked proving HOLD

`proving-hold.mjs` is Brain's foreground adapter for the already-authorized
proving pause. It adds no receiver, queue, schedule, native delivery or BCH
executor. The configured project owner (`promote.to`) must invoke it from its
actual canonical native session. A worker, foreign checkout, role label or
packet cannot acquire that authority. This source landing does not activate the
adapter, adopt it in BCH, change a priority agreement, or change a runtime/pin.

The source owner supplies a **key-free** packet through existing record messages
or linked owner-issued evidence. Brain's owner verifies the original issuer and
the cited existing authority through its established owner relationship, retains
the packet locally, and endorses its exact canonical digest in an ordinary
decision note. A hash authenticates bytes, not a sender. Do not endorse an
unverified relayer, claimed identity, new priority rule or reserved effect.
No BCH private record is read. BCH owns its own adoption after M2.

## Request and acknowledgement

Example packet; paths and references are illustrative, never credentials:

```json
{
  "schema": "brain.proving-hold/v1",
  "kind": "request",
  "source_project": "/canonical/source-project/.git",
  "issuer": "source-project-owner",
  "request_id": "owner-request-17",
  "consumer": "/canonical/brain/.git",
  "authority_ref": "owner-linked-standing-agreement:decision-17",
  "scope": ["admissions", "landings", "closeout", "proving"],
  "notice_id": "original-owner-notice-17",
  "delivery": "linked-record"
}
```

`packetDigest(packet)` hashes `messages/schema.mjs::canonical(packet)` with
SHA-256. The actual Brain owner records exactly
`PROVING HOLD request DIGEST` using `record note OWNING_ITEM TEXT --decision`.
The note's sequence is supplied explicitly. This endorsement attests verified
issuer, exact scope, consumer and standing authority; it grants no new authority.
`native-inbox` delivery instead of `linked-record` also requires the **original**
`notice_id` in Brain's existing supervisor inbox to be `sent`/`handled` before
acknowledgement. Missing, pending, refused and uncertain delivery keeps the HOLD
and original notice. The adapter never sends, retries or substitutes a transport.
An inspected BCH refusal remains BCH's original refusal, never a Brain retry.

Using pinned Node 20.19.4 and the actual owner, run:

```sh
node supervisor/proving-hold.mjs request --repo /canonical/brain --org /owning/record --packet /retained/request.json --decision-seq N
node supervisor/proving-hold.mjs ack --repo /canonical/brain --org /owning/record --packet /retained/request.json --decision-seq N
node supervisor/proving-hold.mjs status --repo /canonical/brain --org /owning/record --packet /retained/request.json
```

The request installs an issuer/request-specific entry under the existing
`.lane/supervisor/HOLD` marker, now a managed directory. All existing presence
guards still apply; direct lane launches now also honor HOLD before launch and
at native launch boundaries. A pre-existing plain HOLD, unknown directory or
redirected path stays untouched and needs its actual owner. STOP is independent.
The retained marker contains the entire original packet and endorsement sequence.
The owning record carries `proving-hold.requested`, exactly one
`proving-hold.acknowledged`, and their exact causal IDs/sequences. These are
evidence facts; older folds ignore them. There is no second message store.
The read-only `status` command reconstructs the complete original history and
exact acknowledgement from these facts; it never acquires authority or releases
a marker. Each fact retains its owning decision subject and sequence.

Before acknowledgement, existing workers may finish computation and submit their
reports. Already-running line passes, promotions and closeout effects may finish
their current guarded work; they are not killed. HOLD prevents subsequent
admission, guarded FF and closeout. Acknowledgement must obtain the existing line
control/pass and Git promotion locks, observe no outstanding unreported work for
Brain, and inspect native owners/children with the existing safe-point observer.
Live or unknown resource owners, retained resource locks, unknown occupancy and
pending native obligations keep acknowledgement pending. No stale lock is removed
and no occupancy is pruned. Resource and native/record/marker readbacks are checked
again at the acknowledgement boundary. Repeat a pending **observation** on the
same request after its original owner positively settles the conflict; do not
replay a native effect. A still-running closeout drain is not an acknowledgement.

Brain's acknowledgement says only that Brain's relevant seams were contained at
that observation. It asserts neither a killed worker/drain nor global resource
availability. The proving owner must separately observe fresh available memory
and acquire/verify its **real** prover lock, under its existing executor, before
proving. `validateProvingReadback` validates the linked readback contract (samples
after ACK, at most 30 seconds old, sufficient bytes, same issuer/request, positive
lock evidence); it performs no measurement, lock acquisition or proving admission.
The owner must also verify the request remains held. Deadline or silence is not
completion, release, or a substitute for actual resource/lock observations.

## Matching release and restart

The source owner supplies a release packet retaining the original source project,
issuer, request ID, consumer, authority reference and scope, with `kind: release`,
the exact acknowledgement ID in `reply_to`, a new original `notice_id`, and:

```json
{
  "result": "completed",
  "completion_ref": "owner-linked-positive-completion"
}
```

An explicitly authorized cancellation uses `result: authorized-cancellation`
and its exact authority/evidence in `completion_ref`; it is not inferred from a
timeout. Brain's actual owner verifies this same issuer and positive completion
or cancellation and records `PROVING HOLD release DIGEST` as an exact decision
note. Then run the same command with `release`, the release packet and that note's
sequence. Release before acknowledgement, wrong issuer/request/authority/reply,
non-positive completion or failed original native delivery cannot clear a hold.

Release commits its causal permission to the owning record before removing only
that request's entry. Another issuer's entry, operator marker, or STOP remains.
Duplicate request/ack/release calls reuse their exact facts; a completed request
cannot be resurrected or assigned new content. A crash after marker publication
but before the request event recovers from the same packet and endorsement. A
crash after release permission but before cleanup resumes only that local cleanup
under fresh native checks. Unknown/redirected markers, incomplete record tails,
occupied locks or torn directory creation retain HOLD for the original owner to
inspect; never fabricate an acknowledgement or recover a foreign lock.

## Evidence and remaining owners

The selected focused fixture check is
`node test/helpers/run.mjs supervisor/test/proving-hold.test.mjs`, captured once
on the clean committed candidate with `lane check --cmd`. It exercises failure
and same-request recovery, including the existing late-FF guard and direct lane
admission guard. Fixture success establishes source behavior only.

Live/installed handshake, BCH's key-free owner packet, actual resource/prover
readbacks and BCH adoption remain unrun producer obligations for their original
owners. The line owns the single immutable post-code review and guarded closeout;
release qualification/activation belongs to the existing release coordinator.
