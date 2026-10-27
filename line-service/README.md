# Minimal line service

For the contained startup-notice backlog, the owning native supervisor can run
this explicit source control from its canonical project checkout:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/supervisor/prompt-supervisor.mjs --handle-pending-line --org /OWN/RECORD --id STABLE_BATCH_ID
```

It selects all currently safe PENDING `[line-service]` notices addressed to
`brain-chat` in that record, not an old startup manifest. One immutable bounded
manifest and one existing `session.message.v1` record envelope precede explicit
handling. Original inbox bytes, sent entries, uncertain/in-flight attempts,
obligations, unrelated recipients and order remain. Existing `autopilot` handled
events let retained inbox readers recognize the disposition; no SENT, native
delivery or model consumption is claimed. Retry the same ID only for the same
saved batch. New arrivals stay pending and are returned explicitly.

The control requires actual project/record/caller/recipient/source bindings and
uses the SAME drain and journal locks without owner probes/recovery. An occupied
lock, source/native change, redirected receipt, unknown project or changed
notice state refuses before further handling. It never prompts, resumes,
restarts or signals the inbox owner. A refusal is not authority to use an
alternate executor or edit the journal. Only the project owner executes this
control; the worker supplies source/affected evidence. This is not permission to
restart either stopped line service.

## Phase1 source contract

The operator approved the whole Phase1 implementation on 2026-10-26. Source
landing and offline checks do not claim live acceptance. Brain must first prove
one existing small item through start, land, report, review, verdict, source close,
worktree removal and session retirement without a chat session operating it.
Then BCH's own supervisor performs the same proof. No Fera or public effects.

Each model-free launchd pass uses the existing record, native dispatch, route,
claim, closeout queue and transport. It never promotes another owner's work or
calls a model API. The supervisor installs from committed canonical development
source with pinned Node20.19.4, actual native path/socket and its own project.
BCH effects belong only to BCH's supervisor. No pins, saved consumers, old
watchers, claims or retained ambiguous/native-refused attempts are replaced.

```sh
node line-service/launchd.mjs install --repo /OWN/CANONICAL --org /OWN/RECORD --to PROJECT_SUPERVISOR --herdr /ABS/herdr --socket /ACTUAL/herdr.sock
node line-service/launchd.mjs status --repo /OWN/CANONICAL
node line-service/launchd.mjs stop --repo /OWN/CANONICAL
node line-service/launchd.mjs restart --repo /OWN/CANONICAL
```

Stop writes this service's STOP and boots out its exact saved job. Restart proves
the saved job absent and archives its STOP before one bootstrap. Refusal or
uncertainty retains STOP and its receipt; it grants no alternate-executor retry.
Project STOP/HOLD, actual native identity, claims/generation, source cleanliness,
main CAS/FF and archives remain mandatory. Ordinary lock recovery requires fresh
positive ESRCH, existing recovery serialization, owner re-read/CAS and original
owner archive; live, EPERM and unknown stay held. There is no force entry.

The original service cutover remains immutable. Before Phase1 activation, the
owning native supervisor records its designated intended pre-Phase0 SOURCE
boundary with the existing stopped-service helper:

```sh
HERDR_BRAIN_ROOT=/Users/rewt/development/rewt/herdr-brain /Users/rewt/.nvm/versions/node/v20.19.4/bin/node /Users/rewt/development/rewt/herdr-brain/line-service/cutoff.mjs --repo /OWN/CANONICAL --org /OWN/RECORD --id STABLE_PHASE0_ID --cutover --phase0-head FULL_DESIGNATED_HEAD --evidence /DESIGNATED/PRODUCER/LOCATOR
```

This appends one `line-service.phase0` event under pass/promotion/record locks and
fresh own native/project/source guards. It never rewrites the earlier cutover or
starts a runtime. Brain's designated intended source boundary is
`ff88cae6cc7db0140debe47bc3f55fafed46d6c7`, archive
`archive/phase0-land-first-20261026-pre`, captured before Phase0 instruction edits.
Exact canonical main at18:55CDT and the archive-creation minute are UNKNOWN.
The completion measurements are not an18:55 observation. BCH needs its own
owner-designated boundary; Brain's SHA supplies no BCH authority.

Reviews are owed for each actual landed build commit strictly after that source
boundary, including a closed item or removed producer worktree. Two Git reads
index the interval; old reports outside it perform no per-report Git, hashing or
native inventory. Immutable report bytes and original dispatch/source attribution
bind each parent/head diff. Unknown attribution holds only that review branch.
Red checks or a blocked report do not disqualify genuinely landed changed code.
Only an existing attempt for the SAME source item and head blocks a new review.
Unrelated old private review directories do not establish an attempt. A real
same-change UNKNOWN/native refusal remains held, with no retry or replacement.

The current queue helper creates one ordinary reviewer item keyed `(item, head)`.
Its bound immutable target/evidence is checked again before every native effect.
New source dispatch uses the configured normal review selection (review-sol-max)
and a registered `review-` worktree at that exact head. The review pool defaults
to three sessions, separately from build admission; the existing total native
resource cap remains. Old settle reviewers still consume real total resources.
Saved owner/pinned consumers retain their original selection. A matching explicit
source selector does not fabricate native/run authority. Unknown queue/helper
capability holds before launch.

Reviewers inspect only the immutable diff and producer evidence, with zero
suites/edits. Their normal report says `outcome: done`, `verdict: PASS|FAIL` and
uses `- [Major] path:line - explanation` / `- [Minor] ...` findings. The record
stores verdict/findings against source item/head. FAIL/Major creates one linked
engineer correction; Minor creates one follow-up. Existing engineer proposals
are preserved and linked. Corrections retain the original review and never
create a re-review chain. The current service can record these facts from
immutable already-ingested bytes even when the selected record consumer is old;
it uses its actual owned pass/installation and fresh run ownership, without
changing that consumer, a pin or the report. Major correction checks remain
required before final release.
An explicit verdict may be in frontmatter or a standalone `Verdict: PASS`,
`FAIL` or `NEEDS-WORK` body line. Quoted/fenced examples grant no verdict;
missing, unknown or contradictory declarations hold intake. The fact records
the declaration location and original report hash; report bytes are unchanged.

Each pass writes a heartbeat, ingests an actual valid report as soon as its file
exists, conditionally source-closes genuinely done integrated work, drains named
closeout keys and considers independent READY work. It does not wait for native
idle to ingest. A blocked report cannot start again until an actual note, answer,
unblock or changed brief arrives; unresolved dependencies/HOLD still refuse.

Starts use `dispatch --detach`. The original journal reserves capacity before
spawn and returns immediately; each candidate and the child perform fresh
admission/readiness checks. The child has a ten-minute controller budget and
120-second command bounds. Each pass has an eight-minute work budget and bounded
children; it logs a stuck child and continues independent branches. The two
legacy-named memory phases now pause only for a genuine live proving reservation.
Memory pressure is observed, never an admission wait. Lost launches/prompts are
retained, never resubmitted. New detached watchers record callbacks without
prompting a session; already-saved watchers keep their original recipients.
An original preflight with positively recorded `native_launch_attempted: false`
can continue through `dispatch --retry JOURNAL --continue-preflight`. The service
uses that same entry after a deterministic preparation failure, once per actual
helper capability. It preserves the request, route, immutable target and first
launch receipt, and recounts admission under the existing locks before handoff.
Missing zero-native evidence, a live/unknown native attempt, permission/identity
refusal, a different saved helper or an already spent continuation remains held.

Ingest and conditional close retry through their idempotent contracts. Named
closeout retries automatically on new target revisions or a pre-effect lifecycle
mutex/budget deferral with no unresolved native intent. A pre-effect changed-code
handoff retains its original requests for the next fresh drain. An unresolved
bound agent-exit intent permits outcome observation only: no prompt, tab close
or removal in that pass. A fresh exact shell/native readback can record the exit;
only that positive receipt permits the next guarded cleanup pass. Still-live,
replaced, permission-refused or unknown outcomes remain held, without replay.
Durable effect IDs and original bindings remain intact. Conditional source completion binds a landed cleanup request;
the executor still proves current identity, actual integration, callback release,
clean Git and archive preservation before any retirement/removal. The installed
line owns routine cleanup; competing automatic kicks/unnamed drains yield to it.
A closer verifies its committed import graph and main branch, so unrelated main
landings no longer invalidate it. A changed closer payload still hands off.

Routine holds and status use the existing record inbox, never session prompts.
Three occurrences of the same normalized failure create one envelope; every raw
occurrence/count is retained. A pass over ten minutes creates one record alert.
Only an actual pending explicitly reserved human question naming its decider can
use the existing one-shot native decision pointer, with the original stronger
session binding. Record errors have no native fallback.

```sh
node line-service/line-service.mjs --digest --org /OWN/RECORD --since 2026-10-27T00:00:00Z
```

The morning digest derives landings, verdicts/findings, holds, idle hours and
build-to-main minutes from record facts. New own lane promotions record their
actual post-FF time under fresh native/claim/source CAS. Historical containment
observations have `landed_at: null`; incomplete idle intervals stay UNKNOWN.
The service directory retains `passes.jsonl`, `effects.json`, `heartbeat.json`,
installation, STOP and original native output. Pass timings separate record/scan
cost from effect command time; they are passive next-real-pass observations.

The focused Phase1 selection uses the existing runner, core files together and
dispatch files separately (at most four per group):
`test/line-service-phase1.test.mjs`, the `phase1` control in
`test/closeout.test.mjs`, and `dispatch/test/phase1-starts.test.mjs`.
All are discovered by the next full release. Run once through lane check on the
clean committed candidate after self-landing; no full/default/reviewer suite.
One independent async post-code review per landed change remains nonblocking.

Supervisor-herdr owns proof-based go/no-go and plain Git revert of the listed
Phase1 commits if it freezes a line or stops landing. The current
`OVERNIGHT-GUIDELINES-20261026.md` supersedes the narrower overnight plan; quiet
chat is the operator delegate, and the existing watcher remains the only one.
Fix local non-fence blockers in the same run, change approach after two or three
failed attempts, and leave new discoveries for morning. There is no ACK or
22:00/23:00 deadline wait. The pre-source archive is
`archive/phase1-land-first-20261026-pre` at
`f1a4abc30d3b08d2887612f19946c165603db43d`. Use ordinary `git revert` on the exact
newest-first Phase1 commit list, preserving record evidence; the older narrow
launchd revert allowlist is not this rollback entry. The last-good code stays
live if proof fails. Public, mainnet, secrets, other-identity files and unarchived
work stay fenced. The release coordinator retains the final full-release and
adoption obligations.
