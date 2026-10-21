# Decision routing policy v2

Adopted by the operator about 16:55 CDT on 2026-10-14, recorded on Herdr Brain
ARCH-23 seq 5596 and bch ARCH-634 seq 18488. The adopted source is
`/Users/rewt/development/bastian/archive/DECISION-ROUTING-POLICY-v2-20261014.md`,
SHA-256 `91431bdd5e6be5b333622ec4ce575169cd427d49045ea5735262fb98785fec79`.
The adoption supersedes that source's `DRAFT — NOT ADOPTED` header and pending
adoption language. Its review placement defaults are adopted defaults.

This is the canonical generic policy; the BCH appendix records local authority.
It adds no authority beyond the adoption and existing delegations, no mechanism,
gate, stored status, approval service or scheduler. Use existing reports,
receipts and item notes. The core stays model-free; tiers name authorized roles,
never models. Session metadata is never decision authority. Each identity's owner
updates its own instructions, briefs and scripts.

## Routing and standing decisions

Choose the lowest tier already authorized for the effect of the action. Apply a
valid standing decision without asking again. A brief authorizes work only within
the operator's scope and applicable rules; a brief cannot grant new authority.
Take scope or evidence uncertainty to the supervisor, then T2 if judgment remains
necessary. Only the affected action waits.

An explicit delegation can name a decision or bounded class, its limits, owner
and expiry. Preserve it across sessions, including existing per-item delegations.
A general delegation of technical judgment stays within scope; it does not
independently authorize funds, mainnet, public disclosure or native permission
changes. A HUM identifier alone does not make an already delegated technical
decision operator-only. Native permission decisions remain with the native harness.

Existing directions constrain new mechanisms. Distinguish creating or changing a
standing rule from applying it. A new cross-project priority agreement is T2
within delegation; routine application is T1. A script or queue is not inherently
T3, but adding a mechanism after a direction to remove process layers needs
concrete justification and authority. Review does not authorize native permission
changes. This policy does not reactivate superseded rules or grant a release.

## Tiers

| Tier | Decider and boundary | Existing record |
|---|---|---|
| T0 | Working engineer or reviewer. Implementation, refactoring, test design and diagnosis within approved scope and contract. Engineers select development checks within required acceptance; reviewers independently judge evidence and give verdicts. Routine security-code repair restoring an approved invariant can be T0, with required security review. | Material choices in the report or receipt; no note for every edit or command. |
| T1 | Supervisor applying a standing rule. Dispatch, retained-session reuse, authorized bounded retries, queue order, promotion after required evidence, and safe lifecycle actions under the approved shared contract. Apply a cap or route its exception; never invent a waiver. Unknown identity or evidence is a hold to resolve, not permission to clean up. | Job, promotion or lifecycle receipt with the rule reference; a separate note only for a material disposition or exception needing one. |
| T2 | An authorized technical delegate. New or changed technical or security contracts within the product mandate; bounded residual risk; unresolved engineer/reviewer evidence disagreement; an exception beyond the standing revision cap; a new cross-project priority agreement; new process mechanisms or required-evidence changes within delegated scope. Authorizing implementation scope is not a review PASS. | Concise item decision note: class, authority, choice, evidence and unknowns, limits, follow-up or revisit trigger. |
| T3 | Operator. Reserved effects below, or a request to change the delegation itself. | Reuse or create the relevant HUM item, quote the answer exactly and bind its scope. Ordinary technical escalations do not all become HUM items. |

A novel risk-bearing guard, cleanup or identity change may need T2 contract
clarification. Once explicit, contract-preserving fixes return to T0 and applicable
independent review. Production code alone does not permanently require T2.
Record who actually decided separately from the minimum tier required: an operator
answer to an ordinary technical question does not make the class permanently T3.

## Operator-reserved effects

These are authority boundaries. If the mission forbids an outcome, report the
conflict; do not offer it as an ordinary tradeoff. A governing-rule amendment must
be explicit and cannot override the native harness or higher-priority constraints.

| Effect | Boundary and exclusions |
|---|---|
| Funds, mainnet, purchases and account authority | Mainnet; funding, signing or spending outside explicit authority; new purchases, subscriptions or commitments outside an approved budget; account ownership or access changes. Already authorized zero-value test-network operations and ordinary approved-tool use need no fresh permission merely because an account exists. |
| External disclosure, publication and deployment | New public posts, repositories or releases; private construction crossing its approved boundary; visibility, DNS or remote changes; deployment beyond standing authority. Preserve separate canonical publication stages and permissions. A private local build or activation within an existing supervisor release mandate is not automatically public publication. Specifically authorized test-network work stays bounded by its authorization. |
| Trust anchors and frozen cryptographic or semantic material | Changing library crypto, a relation, frozen semantics or committed vectors to make a failure pass; modifying pinned proof trust anchors; bypassing signature verification. Preserve applicable stop-and-report rules and historical anchors. Ordinary dependency versions are not all trust anchors. An authorized source change does not silently authorize changing an acceptance-contract behavioral or source pin: identify what it protects. |
| Privacy, custody and mission guarantees | Weakening a promised privacy or authority guarantee, making shielding optional, or changing the non-custodial model where prohibited by the mission. Such violations are not routine T2 residual-risk acceptances. Strengthening within the contract is T0 implementation or T2 design judgment according to scope, with appropriate review. |
| Native permissions and actual harness/classifier refusals | Sandbox or permission-setting changes, or approval of a refused action. Stop that action, preserve the reason and take it to the operator; never relay it to another agent or disguise it as another command. Continue unaffected work and permitted alternatives that do not perform the refused action. A runtime test's EPERM or refusal is diagnostic evidence, not automatically a request to change harness authority. For a model provider's cybersecurity-safeguard refusal only, see the appendices' standing fallback direction. |
| Operator-owned sensitive state and destructive loss | New access or use of operator wallets, keys or sensitive accounts outside granted scope; irreversible deletion of unique work or evidence, destruction of recovery, or destructive shared-history changes outside an approved lifecycle. Never emit secrets; retain local sensitive-state protections. Verified recoverable lane retirement under the shared contract is T1. |
| New product direction and external commitments | Starting or retiring user-visible capabilities outside the approved roadmap, material scope expansion, or external commitments. Preserving behavior during shared-code extraction is T0/T1. Keeping an existing feature pending a separate product decision is not itself new feature authority. Implementing an authorized retirement needs no new product decision per slice. |
| Authority-policy changes and specifically reserved holds | Adopting or amending routing authority, changing the reserved list, expanding delegation, or lifting a hold expressly requiring a new operator answer. Technical interpretation within an existing delegation stays T2. Operator-authored preferences are not all permanently operator-only. |

Routine internal coordination stays within existing authorization. There is no
general permission here to message external parties, publish, buy infrastructure
or transfer code to a new executor.

## Independent review and evidence

No self-certification: an implementer cannot independently accept their own change,
erase a negative finding, approve their own missing-authority exception or expand
their own permissions. They may choose how to implement authorized work. Proposing
an option does not force its decision to T3. If the technical delegate implemented
the change, obtain another qualified independent reviewer and another authorized
decision-maker for any remaining contested T2 exception. Ask the operator only
when reserved authority or missing delegation requires it. One qualified independent
review can supply both implementation review and security concurrence.

Adopted review defaults:

- One risk-directed independent review at ready/done; the same reviewer/session
  checks the delta after findings and newly affected paths, preserving old witnesses.
- Pre-code threat/contract review for new or changed protocol, privacy or security
  boundaries, including custody and authority. Reuse approved contracts for slices.
- No reviews during ordinary engineer fix iterations or known-red evidence handoffs.
  No default blanket suite replay, three-probe quota, or requirement that every
  syntactic guard mutation fail. Exercise the protected property and actual changed
  consumer, using meaningful positive and negative controls and exact input evidence.
- Ordinary bounded features need focused engineer tests and a concise changed-code
  review. Tests need collection/reachability and oracle checks; docs need substantive
  claim and scope checks; tooling needs actual failure/recovery checks. Changes to
  validation selection, permissions, cleanup or release authority receive the review
  appropriate to that boundary. Existing explicit acceptance obligations remain
  until properly changed.

Separate observed results, inference and unknowns. A completed run is not a PASS;
a PASS is not integration; a drafted rule is not an installed rule. Preserve old
reports and verdicts. Correct false completion claims against the responsible
execution/reporting record, not the person who authorized the intended action.

## T3 questions

State the specific effect requiring authority, the relevant rule, two or three
viable options and consequences, a recommendation, and what waits if unanswered.
Include material uncertainty and reversibility. Default to preserving the current
boundary and continue unrelated work. Silence is not approval. Summarize agent
evidence and the actual tradeoff; do not ask the operator to read code or choose
routine implementation details.

## Calibration and measurement

Use existing records for a compact entry: decision ID/class; actual decider and
required tier; authority/precedent; evidence and uncertainty; related incident or
decision cluster; chosen action and conditions; subsequent outcome and exposure;
rework or escape and its attributed cause. Routine T0/T1 receipts need no parallel
log. Label outcomes as pending/unobserved, executed within conditions, amended by
new evidence/requirements, overturned as erroneous, or defect/escape attributed
with evidence. Nobody objecting is not a successful outcome.

Ten comparable, outcome-observed decisions can trigger review of a narrow standing
rule; they never lower a tier automatically. Account for negative cases and pending
outcomes. Continuations, cross-references and decisions from one incident are not
independent successes. Ten is no calibrated safety threshold.

A candidate T2-to-T1 rule needs a precise class and scope, meaningful downstream
exposure, severity of misses, exceptions and stop conditions, and reversible
withdrawal. Operator confirmation grants that standing authority. There is no
automatic T3 delegation or demotion, nor a ten-case apprenticeship for already
authorized T0 work.

A confirmed wrong decision causing material escape or rework temporarily returns
that narrow class to higher scrutiny while its cause is examined. Distinguish new
requirements, disclosed accepted residuals, execution bugs and newly available
evidence; any rework does not justify escalating the whole class. Urgent containment
of a real boundary failure need not await a numerical threshold.

Independent agents may audit sampled T0/T1/T2 decisions and summarize evidence for
the operator without operator code review. Sample technical disagreements, residual
risk acceptances and proposed standing-rule boundaries. A periodic digest may give
counts, observed/pending outcomes, erroneous overturns, escapes and turnaround;
this document starts no scheduler or service.

Measure separately: ready to reviewer start; start to report available; observable
compute/queue time; report to ingestion; ready to integration. Distinguish substantive
re-reviews from receipt-only resumptions, and new findings from already-red evidence.
Claim time saved only against a comparable measured workflow, not a removed prompt.

The cited analysis is
`/Users/rewt/development/bastian/archive/REVIEW-EFFECTIVENESS-ANALYSIS-20261014.md`,
SHA-256 `df4e92b7d82c32653ea806eb81e8d8bb99c52f16e390bb62bfcd16641ba80962`.
It covers 751 historical review runs and a recent 80-run cohort, 79 of which used
the security-critical route. Its 14.4 hours of summed ingestion lag overlap across
runs and are neither reviewer effort nor guaranteed savings. The evidence supports
independent boundary review with less execution ceremony; it does not estimate
technical-delegate accuracy or the safety of skipping ordinary-feature reviews.
The source's selected seed decisions are not an accuracy sample or a defensible
denominator for automatic tier movement.

## Appendix: herdr-brain

### Standing directions and containment

- The operator's 2026-10-21 09:5x standing direction, relayed by the main chat: “if Codex triggers cybersecurity, move to Cloud; if Cloud triggers cybersecurity, move back to Codex. Let's implement that.” “Cloud” means Claude.
  - This covers provider content filters only: a model provider's cybersecurity safeguard refusing a dispatched task. One switch per task: move it to the other harness's equivalent route—Codex to Claude or Claude to Codex—and record the switch on the item: from, to, run and reason.
  - Move the task unchanged. Never reword it to get past either safeguard.
  - Do not loop. If the moved task is refused again on the other harness, stop and take it to the operator.
  - This supersedes the operator-only handling in the reserved-effects row “Native permissions and actual harness/classifier refusals” for this case only. Native sandbox and permission-setting refusals remain operator-reserved as that row says.
- The operator's 2026-10-21 09:5x standing direction, relayed by the main chat: “Ensure everything defaults to Sol, and Astra is used only for graphical situations and UI/UX design.”
- The operator's 2026-10-20 standing direction: “Let's update routing for all dispatched engineering to use Sol 6.1 Max instead of Astra. And let's reserve Astra for more of the UX UI type of tasks or site layouts or organization and keep difficult engineering efforts on Soul 6.1 max fast”.
- Sol (`gpt-6.1-sol`) is the default Codex model. The explicit `chore` and `monitor` routes keep their cheaper models for mechanical and read-only work (main chat, 2026-10-21 10:1x).
- Difficult engineering and escalations use `engineer-max` (`gpt-6.1-sol`, max).
- Astra (`gpt-6-astra`, via `research-astra-max`) is for graphical and UI/UX design only.
- Authority and ruling reviews use `review-sol-max`.
- The operator's parent `.lane.json` layer defines these routes; this appendix names routes only and does not duplicate their settings.

## Appendix: bch-cloak

BCH adopted v2 on 2026-10-14, source SHA-256
`91431bdd5e6be5b333622ec4ce575169cd427d49045ea5735262fb98785fec79` at the path
above. **bch ARCH-634 is BCH's record**, including adoption seq 18488. BCH owns
its AGENTS.md, briefs and scripts. This appendix records constraints from
`/Users/rewt/development/bastian/bch-cloak/AGENTS.md` (Mission; Stop-and-report;
Secrets; Chain work; Publication authority), with later explicit operator workflow
directions taking precedence where changed.

### Local hard constraints

- The privacy-default path shields participant identity, payer-to-recipient linkage
  and private-note amounts. Weakening, bypassing or making either form optional is
  disqualified. Preserve trustless, permissionless, fast, cheap, reliable and
  non-custodial transfer; no role may require third-party custody of funds or
  material controlling them, including delegated spend authority.
  Never expose private correspondence, partitions, assignments, change ownership
  or reusable recipient markers. Disclose public shape/count/fee/timing correlation.
- If passing requires changing library crypto, a relation, frozen semantics,
  committed vectors or pinned proof trust anchors, stop and report. Never weaken
  or bypass signature verification. Historical seal-era anchors remain immutable
  and reproducible at `archive/seal-era-final` (`091d709e`); do not redefine,
  re-pin or reinterpret them. Authorized retirement removes code, not in-place
  edits to vectors or digests; a pin losing its consumer is deleted with it.
- Never print, echo, log, commit or transmit any secret scalar, seed or private key,
  even partly. Demonstrate absence with digests or searches that emit no secrets.
  Do not clean up secret files. `.local-live/round-material/*.secrets.json` and
  other round secrets are unrecoverable if lost and can strand notes permanently.
  Never move, overwrite or delete existing `.local-live/` material. Worktrees do
  not carry gitignored state; durable live outputs go to the main checkout by
  absolute path under BCH's instructions.
- Chipnet only; never mainnet. No agent may fund a wallet. If funds are needed,
  stop and surface the exact network, address and amount to the operator. Follow
  BCH's Chipnet wallet operations guide. Relay acceptance, chain inclusion and
  wallet acceptance are distinct; local verification is insufficient. Verify txids
  by direct RPC, not the repository client or a log; cross-check conflicting UTXO
  evidence before concluding.
- Pool construction stays private until ARCH-267's Chipnet multi-party simulation
  gate passes independent review and the operator explicitly releases it. This
  covers construction bytecode, formats, settlement, funding/batching, intake,
  wallet schemes, circuit internals and unpublished specifications. Before release,
  only proof-system-level findings, BCH VM/verifier research, public-tool
  measurements and goal-level status are allowed. The specific zero-value Chipnet
  lifecycle ladder authorization remains bounded: reviewed modules, local tests
  with firing negatives, relay/inclusion/wallet evidence, one prove at a time under
  SP1 memory discipline, and private recipient invoice receipts. Funding, mainnet
  and public posts or repositories still require the operator.
- BCH is the private implementation/protocol/publication authority. Use canonical
  `scripts/publication/**` targets and gates; no ad hoc public copies or remotes.
  Prepare, promote, commit/tag, push, visibility and Pages/DNS are separate
  permissions; stop at the requested gate, and block an unimplemented gate.
  Publication requires selection, semantic/privacy review, dependency closure,
  leak detection and target validation; a clean scanner grants no authority.
  Keep `.publication/**` outside private Git and preserve unrelated worktrees.
  Never publish private linkage, amounts, secrets, witnesses or assignments, and
  never represent public metadata correlation as hidden.

### Standing directions and containment

- The operator's 2026-10-21 09:5x standing direction, relayed by the main chat: “if Codex triggers cybersecurity, move to Cloud; if Cloud triggers cybersecurity, move back to Codex. Let's implement that.” “Cloud” means Claude.
  - This covers provider content filters only: a model provider's cybersecurity safeguard refusing a dispatched task. One switch per task: move it to the other harness's equivalent route—Codex to Claude or Claude to Codex—and record the switch on the item: from, to, run and reason.
  - Move the task unchanged. Never reword it to get past either safeguard.
  - Do not loop. If the moved task is refused again on the other harness, stop and take it to the operator.
  - This supersedes the operator-only handling in the reserved-effects row “Native permissions and actual harness/classifier refusals” for this case only. Native sandbox and permission-setting refusals remain operator-reserved as that row says.
- The operator's 2026-10-21 09:5x standing direction, relayed by the main chat: “Ensure everything defaults to Sol, and Astra is used only for graphical situations and UI/UX design.”
- Sol (`gpt-6.1-sol`) is the default Codex model. The explicit `chore` and `monitor` routes keep their cheaper models for mechanical and read-only work (main chat, 2026-10-21 10:1x); Astra (`gpt-6-astra`, via `research-astra-max`) is for graphical and UI/UX design only; authority and ruling reviews use `review-sol-max`.
- Focused pre-merge package checks and direct-dependent typechecks remain the
  validation direction. No post-merge run for now: restarting specifically requires
  a new operator decision under bch seq 18209. This is no exemption from required
  release-candidate evidence. C1 retains its single aggregate cutover run.
- Native harness sandboxes remain. Engineers run their own authorized package
  checks and builds; supervisor-only host-check handoffs are dropped. The shared
  slot is only for proving and aggregation, including real proofs, live
  measure-pk-load proving, aggregate builders and `validate:pool-multiparty-sim`.
  The measured-heavy-suite admission layer is superseded (seq 18468).
- ENG-1447 is paused (seq 18468/18471); do not revive its host-check loop or build
  retirement on it. Retained-session reuse continues. New mechanisms must fit the
  operator's removal of extra process layers.
- MIG01/C1 finishes before Workstream B; a clean BCH workspace comes first
  (ENG-1451). Safe-retirement containment remains (Herdr ARCH-23 seq 5578, bch
  seq 18459): keep working, blocked or unknown occupants and pending job/callback
  references. A run/report ending alone never authorizes closing a session or lane;
  ingest reports first. Release a pane only after its review/correction/integration
  chain is terminal with no returning callback, or an explicit confirmed handoff
  to a retained successor. Recheck live identities, Git, jobs and the record at
  execution. Preserve desks, operator workspaces and lab-owned workspaces.
- Lane removal also requires clean Git, the exact tip integrated or a verified
  recoverable archive tag, hashed evidence outside swept paths, no live resource
  users, and tag-collision/durability preflight. Parked unique or non-code work
  needs explicit disposition; age is no deletion authority. Keep the shared
  planner/executor contract, no parallel BCH cleanup engine or revived janitor.
  No premature closers, blanket housekeeping restart or documentation-only release.
  Schedule wiring awaits reviewed adoption; cleanup failures retry cleanup without
  repeating successful validation or treating integration as failed.
