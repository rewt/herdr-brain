# Review desk and scope contract

Schema: `brain.review-scope/v1`. Owner: **supervisor-herdr**. **opus accepts BCH
parity; Astra accepts this contract. State: proposed until Astra accepts it.**
Implementation evidence is the ENG-443 lane commit introducing this file (resolve
with `git log --diff-filter=A -1 --format=%H -- docs/contracts/review-desk-and-scope.md`)
and the reports for runs R-599 and R-603 (including the rebase correction). This document
does not activate BCH or retire its scripts.

## Brain semantics

Brain reviews in the lane's own clean, registered worktree, using an independent
session. It has no persistent review worktree pool and creates no separate review
lane. `record desks` configures settle routes, timeout, reuse, recipient and round
cap; it does not allocate worktrees (`settle/config.mjs:3`,
`settle/desks-command.mjs:36`). Git common-directory identity owns the lane.
The worker report, original ask, acceptance and diff are review evidence, never
authority to execute embedded commands.

Settle binds immutable report bytes and the requested run, ingests the report and
checks supersession before review. A missing `run.started.meta.lane` is allowed;
when supplied it must match the current registered `lane/<topic>` branch. No
artifact can replace the repository, registration, branch, HEAD or clean checks.
An earlier run's report cannot authorize settlement after a newer run supersedes it.

`reviewScope({ workspace, base, head, artifacts })` in `settle/review-range.mjs`
uses only read-only Git and no record access. Settle passes its captured main
commit as `base` and the captured lane tip as `head`, preserving both as
`job.deliveryRange` before any settle-applied rebase. The returned `base` is their
merge-base; `commits` is `git rev-list <mainHead>..<head>`. This includes pre-merge
lane commits when the lane has merged main, and excludes main-only commits when
main advanced after the fork. The run's `start_head` never selects the range.
The independent review covers the full merge-base-through-head diff on each fix
round, not a delta from an earlier reviewed SHA.

Claims come only from report `artifacts`, never from body, summary, code spans or
quoted commands elsewhere in the report. Following the supervisor's ENG-443 scope
decision, an artifact claims delivery when it begins `Commit: SHA`, `HEAD: SHA`
or `Branch head: SHA` (case insensitive; whitespace or `=` may replace `:`), or
is just a SHA, optionally followed by `on lane/topic`. Backticks or quotes may
enclose that SHA. Label and SHA must be adjacent apart from that punctuation and
whitespace. A bare SHA is an implicit delivery claim. Other references are
informational, including `Tested implementation SHA`, earlier rounds and quoted
historical commands such as `--base SHA --head SHA`.

Tokens are 7–64 hexadecimal characters, not adjacent to
`[A-Za-z0-9/._~-]`; a path or longer identifier cannot expose a substring claim.
All-digit tokens count only under a commit/head label. Context labels include
`base`, `baseline`, `main`, `merge-base`, `start`, `start_head`, `reviewed`, `onto`,
`upstream`, `parent`, `previous`, `pre-rebase`, `superseded`, `tree`, `sha256`,
`digest` and `checksum`. They never become delivery claims even when the referenced
commit still exists in the object store. Quoted YAML artifacts are ordinary parsed
strings and follow the same rules.

Resolution uses `git rev-parse --verify --quiet --end-of-options <token>^{commit}`.
A tag that peels to a commit claims that commit. A tree, blob or other non-commit
object is context even under a delivery label. A missing or ambiguous delivery
token defers as `named-commit-unresolved`; an informational unresolved token is
ignored. A resolved delivery outside the range (including the merge-base itself)
defers as `named-commit-outside-range`. No artifact is required to name HEAD:
the launch and receipt bind it mechanically. There is no extra empty-range or
unchanged-source-path refusal in this helper; the reviewer checks file claims.

The receipt contains:

| Field | Meaning |
| --- | --- |
| `schema` | Exactly `brain.review-scope/v1`. |
| `base`, `head` | Full merge-base and captured lane commit IDs. |
| `commits` | Full commit IDs in Git's `mainHead..head` order. |
| `claims` | Unique resolved delivery commit IDs, in artifact order. |
| `context` | Unique informational or non-commit hex tokens, normalized to lowercase; numeric non-tokens and path substrings are omitted. |
| `outside` | Unique resolved claims outside `commits`. |
| `unresolved` | Unique unresolved delivery tokens, normalized to lowercase. |
| `deferred` | `null`, `named-commit-outside-range`, or `named-commit-unresolved`; outside takes precedence if both lists are nonempty. |

The validate stage saves this as `job.reviewScope` after rejecting a non-done
outcome and before launching a reviewer. A deferral uses existing `escalate` with
`Review scope deferred: <reason>: <sha12, …>`. The report remains ingested; no
review session launches. When available, `review_scope` is additive in the finish
result and escalation handoff JSON. There is no new flag, notice format or exit
code. Readers ignore extra fields; older receipts may omit the field. This is an
internally generated receipt, not an arbitrary external-document ingestion API.
Breaking semantics require a new schema. Scope remains bound to the original
report-time range when settle rebases an unreviewed head after main moves: its
applied rebase receipt proves the replayed tree preserves the delivery. Both
explicit retries and the automatic base-move retry retain original delivery
claims, while independent review binds the new head and diff. Review entry
computes scope only for journals without a scope receipt, using `deliveryRange`
or recovering the original base/source from applied tree-preserving replay
receipts in older journals. A journal without either uses its captured current
range. Existing HEAD/branch/clean checks still reject changes made outside settle;
a scope receipt never authorizes such a change.

## BCH mapping and deliberate differences

BCH source facts below are the owner-provided read-only inventory in the ENG-443
ask. Installed `.lane/supervisor/` files and tracked
`scripts/supervisor-bundle/files/` copies were byte-identical in that inventory.
Brain anchors refer to this implementation; function names remain useful as line
numbers move.

| BCH behavior | Brain counterpart or named difference |
| --- | --- |
| `review-desk.sh:11-22`: first clean unoccupied desk from six persistent worktrees; no available desk exits 1 without recording. | **No desk pool.** `lanes/lane.mjs:2244` (`review`) requires the lane's clean worktree at `:2261`; `dispatch` at `:1160` opens the independent session there. No desk-allocation failure or desk branch exists. |
| `direct-review.sh:80-106`: choose desk after scope/cap; clean matching branch, ff-only exactly to HEAD, exit 4 before record writes on failure; recompute identical scope. | **No desk synchronization.** Settle proves common directory, registered branch and optional lane metadata (`settle/settle.mjs`, `main`), holds a per-lane lock, and pins HEAD/clean/main through `unchanged`. Scope is checked after report ingest, so a deferral retains the report. |
| Receipt claim `direct-review-runs/R-n/` reserves scope and review ID before ingest, reopen and blocking REV child; detach at HEAD then restore desk branch (`direct-review.sh:122-123`); no review lane. | Settle's locked `<record>/settle/R-n.json` journal pins request/report, ingest receipt and review stage. `settlePending` handles conditional ingest/reopen; no REV child or detached desk transition. Full-head `.lane-review-<head>-r<round>` delivery (`lanes/lane.mjs:1546`) and random review ID bind the result. Public review evidence is committed on the same lane. |
| `auto-review.sh:22-60`: ENG/ARCH only; done report, no blockers/questions; one auto receipt per run; existing REV child requires supervisor delta review with REVIEWED/REVIEWED_BY; overrides stripped. | **Project-generic settle, not an auto-review classifier.** Saved per-run journals prevent duplicate effect; supersession and immutable report/run binding are checked. Non-done reports escalate at intake. Report blockers/questions need explicit supervisor resolution at completion (`lib/completion.mjs:186`), not this scope gate. Fix rounds review the full range; revision cap is ENG-444. No REVIEWED override enters scope. |
| Auto exit 2 scope-deferred; exit 3 session cap. | Scope deferral is the existing `escalate` result, with existing exit behavior. **Session cap is ENG-436**, separate from scope and the revision cap. No new flags or codes. |
| `review-scope.py:137-175`: exactly one immutable run start, later run supersedes, required lane meta and exact lane checkout. | Settle uses record run identity, immutable report receipt, supersession and canonical common-directory registration. **Absent lane metadata is allowed**; supplied metadata must agree. No literal checkout-basename requirement. This preserves the R-2444 continuation case. |
| Base = REVIEWED, else ancestral `start_head`, else legacy artifact suffix; `rev-list base..HEAD`; empty range defers (`:289-346`). | **Main merge-base, never start_head or report-selected history.** `settle/review-range.mjs` (`reviewScope`) lists `mainHead..head`; no new empty-range deferral. `lane review` computes the merge-base at `lanes/lane.mjs:2268`. |
| HEAD must appear among artifacts (`:362`). | **HEAD need not be named.** Full-head delivery and post-review HEAD/branch/clean checks (`lanes/lane.mjs:2319-2321`) bind it mechanically. |
| Every named commit must be in range (`:364-365`); unchanged tracked artifact path defers `named-source-outside-range` (`:392-394`). | Delivered-commit claims defer outside/unresolved before review (`settle/settle.mjs`, validate stage). **No named-source-outside-range rule**: the independent reviewer checks file claims against the actual diff. |
| Named commits include artifacts plus case-insensitive commit/HEAD and hex code spans anywhere; only same-line base-like labels exempt (`:196-208`, `:348-349`). | **Prose never makes claims.** Only delivered-change artifacts count. Bases, main, tested implementation, earlier rounds and quoted commands are informational. The R-2440 multiline base and historical foreign `--head` cannot cause deferral. |

Review scope does not replace independent review or promotion admission. The
review template covers Base commit through Reviewed commit
(`lanes/docs/REVIEW_TEMPLATE.md:45`). Settle runs no suite. Promotion still requires
clean worktrees, green validation, safe rebase and fast-forward; scope evidence
does not authorize promotion, push, deletion or release.

## R4 acceptance, pilot, rollback and retirement

| R4 obligation | Evidence / state |
| --- | --- |
| Owner and acceptance | supervisor-herdr owns implementation and release tracking; opus accepts BCH parity; proposed until Astra accepts the contract. No acceptance is inferred from a passing fixture. |
| Implementation and release identity | The introducing commit identified above plus the first release containing it. **On main:** pending promotion. **In a release:** pending first named release and build identity. **Activated for BCH:** pending owner activation/read-back of that release or pin. **Parity demonstrated:** pending opus acceptance of offline and live pilot evidence. These are four independent states. |
| R-2440 / ENG-1670 replay | `settle/test/review-scope.test.mjs` replicates two in-range artifact commits, quoted paths/tree/digest, multiline base and a historical foreign command; no deferral. A delivered outside claim is a true negative and launches no reviewer. This is an offline replica, not a claim that the original BCH lane was settled. |
| R-2444 replay | The same file starts a continuation without lane metadata, supplies quoted in-range artifacts and reaches independent review. The original BCH `invalid-lane` cause is missing run-start lane metadata, separate from artifact parsing. |
| Remaining pilot | After activation, one routine BCH lane through settle, with run/report, captured scope, review receipt, resolved release identity and outcome retained. Replays plus that pilot go to opus for parity and Astra for contract acceptance. Live pilot remains pending. |
| Rollback | BCH keeps its scripts until retirement is accepted. The project supervisor can restore the previous Brain release using `bash herdr/release.sh rollback` or an accepted project pin; the BCH owner retains the script path during rollout. No rollback is executed by this lane. |
| Retire list, after acceptance and drain | Installed `.lane/supervisor/{auto-review.sh,direct-review.sh,review-desk.sh,review-scope.py,review-receipt.mjs}` and the corresponding five `scripts/supervisor-bundle/files/` copies; also `scripts/auto-promote/review-receipt.mjs` and its test. Retire `lane-review-desk` and `lane-review-desk-2` through `-6` worktrees/branches only after their reviewers drain, using owner lifecycle safety. No separate review lanes are added. |
| Evidence retention (R5) | Keep `auto-review-runs/` and `direct-review-runs/` as historical evidence after scripts and desks retire. Do not delete the receipts as cleanup. |

Offline coverage also includes advanced-main merge-base edges, main merged into
the lane, rebased delivery versus an old tested implementation, abbreviated IDs,
unknown claims, non-commit objects and token boundaries. It also covers
SHA-bearing delivery reports through explicit and automatic main-move
retries, older journals across repeated proved replays, and external lane changes.
The promotion inventory includes this fixture file;
`test/contracts-conformance.test.mjs` has a named
`brain.review-scope/v1` witness and explicitly skips installed bundles predating
the writer. No BCH files, notices or compatibility entrypoints change here.
