# Supervisor protocol

Until the stable release, Brain and BCH implement the same rules in separate tooling; BCH switches to Brain tooling after adopting the next release. The operator steers and routine reversible work remains delegated.

Finished source lands immediately. No pre-main test, merge, affected-file admission or review readiness gate. Red main is accepted and actual failures are fixed forward. The explicit committed landing waiver records executed:false and exit_code:null; unrun tests are never PASS. Preserve native binding, claims, source/head/clean Git/CAS/FF safety, reserved questions and recoverable archives. Real source conflicts and unknown/foreign ownership remain real issues to resolve.

Every item receives exactly ONE independent review AFTER CODE, of immutable diff and evidence only, ASYNC/NONBLOCKING alongside engineers and landing. Cap1 applies prospectively; the approximately30-minute target is planning, never an elapsed stop. Timeout0 is supported and disables the review deadline. Zero reviewer tests/build/install/prepare/check/probe/mutation suites. No pre-code, plan, contract or concurrence stage. At most ONE formal fix round after the review; no automatic second full review or re-review chain. Later findings fix forward. Majors must actually be corrected and their specific correction/evidence checked before FINAL RELEASE. Preserve historical verdicts/caps/receipts.

## Existing delivery and landing

Use existing dispatch/owner/lane/route flows and one normal watcher per run. Do not duplicate workers/watchers or restart schedules. Notices go to the ops supervisor. Autopilot remains disabled unless independently enabled under its existing authority.

Handle every final org-report once through supervisor.mjs handle RUN --role supervisor. Immutable intake verifies report bytes and owner binding. Its independent post-code review runs in parallel and produces durable findings without granting or delaying landing. It reads captured commit/diff/evidence, never a moving live version. Start promotion of finished source immediately with supervisor.mjs promote RUN --why REASON --role supervisor. The native queue skips pre-main preparation/planner/tests under the waiver, preserves source/claim/Git/FF/CAS and record safety, fast-forwards and records the actual outcome. No synthetic validation-done or full-suite receipt. Correct a real conflict in the same existing owner and continue the supported request. Never bypass a native harness refusal.

Completion/closeout retain exact native receipts and callback identity. Retry only failed bookkeeping/cleanup after its actual cause is fixed; never repeat successful integration/checks. One requested formal correction may follow the review. An uncertain review is inspected in its existing session, never automatically re-launched. Historical source, failed gates and review verdicts remain immutable.

## Final release/adoption

ONE FULL release test is PER RELEASE and shared by all fixes, immediately before final release/adoption. It is FULL, never reduced, and is not repeated. Preserve completed receipts/greens; after a real correction execute only failing, actually affected or previously unrun checks, binding inherited and fresh coverage honestly to source. Passive step timing measures the next actual final candidate; do not run a separate whole-suite benchmark. Deduplicate executions and parallelize only genuinely independent suites while retaining native/Herdr/focus/shared-state/slot/memory/ownership constraints. Light CPU alone proves no independence.

Zero elapsed-only test/helper/runner/gate failure. The sole forced freeze is the exact measured no-output AND confirmed-no-activity condition; unknown activity stays held. Semantic native leases/claims and ownership/source safety remain enforced.

For a fresh final obligation, tag assembled main and start bash herdr/release.sh build TAG --live as one bare command. A real failure retains that immutable candidate and its completed evidence; do not repeat the whole build command after a correction. Bind the corrected genuine candidate and continue only failing, actually affected or previously unrun checks through the existing runners. Full coverage, actual Major correction checks, genuine source, package/seal and real live acceptance must all be proved before bash herdr/release.sh activate TAG and actual installed org/lane/contrib/reconcile readback. A green coverage component is not a synthetic full-command or validation-done receipt. Workers never release. A new candidate records its actual correction and source/runner/environment/dependency carry-forward validity. Publishing/push/funds/adoption scope retain reserved authority.

rc-20261025T1752Z-af6014d759 is immutable NONFINAL diagnostic evidence: reduced entry exit0, live17pass/2fail/NOT READY in825seconds. It is not activated or stable. Those failures and all R840/ENG629 evidence stay preserved. The same additive hotfix retains archive/gating-hotfix-pre-20261025T1737Z-1a6111a4 and one exact revert command for its committed changes.

Rehearsal progresses in parallel and remains PRIVATE with fresh-clone checks pre/post; Chipnet/run/funds safeguards are unchanged. No new program/item/approval round. The sole operator-authorized cross-project policy advisory is R849, in native read-only mode; no second or per-stage advisor.

## Ownership and lifecycle

Before activating run ownership, inventory in-flight work. Old Brain operations
can drain on their saved release. To continue them through the new entry points,
explicitly run `record claim R-n --controller brain --adopt-brain-receipt FILE`,
using the existing `.org/settle/R-n.json`, `.org/dispatch/REQUEST.json`, or
`.org/supervisor/PROJECT-HASH/R-n.json` receipt. The claim verifies the canonical
record/project/run and binds the receipt's available release, not the new pin.
Repeat the original settle/dispatch retry or supervisor handle after claiming;
uncertain review/launch outcomes still require the existing inspection/recovery.
Do this before allowing a queued old Brain job to resume under the new runtime;
its original unbound queue member is accepted only with matching adoption
provenance. Do not use a Brain receipt to adopt ambiguous BCH work: inventory and
drain that work with its legacy controller instead.

An external Brain launcher should run `record claim R-n --controller brain`
after `record start`, before `dispatch/record-worker.mjs` and `arm-watch.sh`.
For pre-upgrade workers already recorded without a claim, explicitly use
`record claim R-n --controller brain --admit-worker` only after confirming this
is Brain's worker. This admits its own worker callback but refuses operation
receipts or other pending effects. Then re-run `supervisor entry` or arm watch.
See [run ownership](../docs/contracts/RUN-OWNERSHIP.md) for the full contract.

Only the canonical supervisor starts housekeeping. Resume existing schedules/watchers without duplicates. STOP prevents cycle mutations. A native sandbox/permission refusal stops that affected action; preserve it, never retry/relay/alternate-execute, and batch unresolved security requests narrowly. Never fabricate native/caller/claim IDs or borrow another identity. Preserve replacement-release, drained-ownership and exact-human-scope prerequisites before adoption inspect/mutation.

## Identity desks

Agents never edit another identity's files. Send its desk a short request with
what is needed, why, how to tell it is done, and where the evidence lives:
`node supervisor/request.mjs IDENTITY "REQUEST"`. The helper reuses `desk-IDENTITY`
or creates an unfocused workspace at `~/development/IDENTITY`, starts native
Codex there (which loads that identity's configuration from `.identity-root`),
waits for readiness and prompts the desk. The desk records the request in its own
record, works through its own lanes and reviews, then replies to the requester.
Never forward anything your own harness refused, including sandbox, permission
or harness settings refusals. Take those to the operator.

Before clearing the chat, record anything needed next. Durable decisions replace
conversation history; don't copy transcripts into the record. Leave watched runs
in flight and answer the operator with the result or the judgment needed.
