# Effect-specific record preparation and exact fences

This continues the callback audit in `record-locks-step2b.md`. It does not turn
legacy `transact` into a replayable planner or change lock/queue ordering.

| Remaining path | Decision and boundary |
| --- | --- |
| `messages/record-command.mjs` send | Prepare the native sender, envelope, worker/claim, duplicate ID and record mutation checks outside the lock. Use the existing full record/file CAS at append. Never replay this planner, including on a conflict-shaped native refusal. |
| Ordinary record-only message result | Re-read the record and reserved question state. Without a pending explicitly reserved question there is no transport effect and no second native query. |
| Reserved message push | Retain a distinct fresh native sender observation, re-read the record again, and use the existing reserved-question/native inbox transport, once-only delivery and UNKNOWN handling. |
| `lib/landing-receipt.mjs` fresh status | Keep fresh status for both main and worker serialized. Ref/index fences alone do not cover unstaged, untracked or ignored worktree changes. No safe status replacement was established. |
| `lib/run-owner.mjs` reservation | Preparation is already outside. Keep exact namespace, owner generation and source/file CAS followed by the durable reservation inside the original operation lock. No weakening or deferred durability. |
| Own promotion and post-FF receipt current run | Select the newest non-abandoned run. An abandoned later duplicate cannot displace the live owner; a later non-abandoned run still supersedes it. Keep every other native, claim, HOLD/question, source and FF guard. |
| `lib/record-observation.mjs` validation | Resolve each exact path through `fs.realpathSync.native` instead of Node's JavaScript ancestor walk. Keep both link/target identities, mode, nanosecond times, size, directory listings and absence checks. No validation cache, TTL or subject-only CAS. |

The native resolver still traverses ancestor symlinks. Retargeting an ancestor
between two names for one hard-linked inode must refuse even when file identity
and bytes are identical. Every validation resolves the current path again.

The remaining configuration-audit, immutable archive, closeout, recovery,
retirement, native decision and runtime migration callbacks retain their prior
effect boundaries. No blanket migration, native replay or adoption is implied.
Git status, FF, queue commits, reservation durability and large exact read sets
can still exceed the latency target.

Successful acquisitions keep their existing `record-lock/v1` timing sidecar.
Busy refusals now append a separate `record-lock-refusal/v1` row to
`record-lock.refusals.jsonl`, with source fingerprint/path, time, caller, label,
actor, wait and reason (`explicit-control` or `owner-unconfirmed`). No error text,
owner data or record event is published. Diagnostic failure cannot authorize an
effect, change the original error or recover an explicit-control owner. Refusals
are never acquisitions and must not enter hold percentiles.

Collect passive overall and matching-source cohorts with counts, nearest-rank
p95 and UTC windows. At least 200 acquisitions or a full working hour is needed
for the requested meaningful window. Count observed busy refusals separately;
old loaded source and best-effort diagnostic loss remain coverage limitations.
An absent sidecar cannot establish zero historical refusals. Do not restart
services, rewrite pins, generate benchmark traffic or substitute a fast subset
for the overall measurement. The store/fold fingerprint does not identify the
entire loaded native/helper module graph.
