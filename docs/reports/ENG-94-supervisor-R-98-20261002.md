---
run: R-98
outcome: done
summary: |
  Resolved all three independent review findings. The promote queue now accepts and enforces an expected head and authorized run through the shared lane promotion lock, with record readiness rechecked atomically before integration.
  STOP appearing during review prevents correction dispatch and preserves a resumable handoff. Explicit promotion retry rechecks a confirmed refusal, binds a new queue job and retains prior attempts without replaying successes or uncertain enqueues.
  Offline regression tests, the complete supervisor cycle and the final npm suite pass. The current repository cold start is approximately 1316 tokens.
headline: Reviewed promotions keep their authorized commits, stopped corrections resume safely, and refused attempts can retry
blockers: []
proposals: []
learnings:
  - The expected promotion head is settle's final validated head including its review-record commit; the earlier reviewed source commit remains separately recorded.
  - A reviewed head needing a rebase must be rebased and settled again instead of being automatically rewritten by the promotion queue.
  - Final record readiness checks hold the record lock across the fast-forward, inside the Git promotion lock, so a newer run or blocker cannot arrive between that check and integration.
  - A stopped settlement retains its fix or dispatching stage; clearing STOP and explicitly retrying resumes existing review and correction evidence.
  - Only a confirmed refused promotion may create a new supervisor attempt; success remains idempotent and pending, interrupted or uncertain attempts still need inspection.
artifacts:
  - "Commit: Bind promotion requests to reviewed heads and guard cycle recovery"
  - "Commit: Report supervisor safety corrections for run R-98"
  - promote/promote.mjs
  - promote/guard.mjs
  - promote/test/promote.test.mjs
  - lanes/lane.mjs
  - settle/settle.mjs
  - supervisor/supervisor.mjs
  - supervisor/test/supervisor.test.mjs
  - settle/test/receipts.test.mjs
  - docs/reports/evidence/ENG-94-supervisor/R-98-cold-start.txt
  - docs/reports/evidence/ENG-94-supervisor/R-98-validation.json
  - "Validation: npm test before and after changes; affected lane lifecycle cases; standalone supervisor acceptance cycle; record check this report; lane check as the final command after the report commit"
decisions:
  - text: Enforce expected promotion heads in the promote module and shared lane execution path, and have supervisor pass the settled head and authorized run.
    category: design
    why: The queue must protect every caller that binds reviewed work; checking only in supervisor before enqueue cannot protect a lane that changes while pending.
  - text: Refuse rebasing of a bound head and fast-forward the validated commit directly.
    category: design
    why: Automatic rebasing would replace the authorized commit, and merging a moving branch name could integrate different work after the check.
  - text: Recheck current run, recorded done report, lane identity, closure, unresolved or declined blockers, changed outcome and overlapping work before integration under the record lock.
    category: design
    why: A guarded record close after promotion is too late to protect the promotion judgment; record changes during validation must prevent integration itself.
  - text: Return a resumable stopped handoff immediately before correction dispatch or incomplete-dispatch retry when canonical STOP exists.
    category: design
    why: Review can outlast a stop request; retaining its evidence and incomplete stage permits an explicit continuation without another review or worker launch.
  - text: Allow explicit promotion retry only after confirmed refusal and save prior attempts with their queue results.
    category: design
    why: Transient refusals need a recoverable new binding, while success, pending jobs and uncertain external effects must never be replayed blindly.
  - text: Verify correction idempotency using worker launches and correction prompts instead of all Herdr calls.
    category: prover
    why: The acknowledged background watcher legitimately performs later reads and final-notice delivery; these calls do not prove duplicated correction dispatch.
questions: []
challenges:
  - One intermediate full suite exposed the pre-existing asynchronous total-Herdr-call-count assertion in settle/test/receipts.test.mjs, also noted by the previous run. The assertion now checks the actual effects and the final complete suite passes.
  - The optional full lane suite was interrupted after 66 completed cases while its inherited registry concurrency case remained pending. All 18 affected promotion and closure cases passed separately; no claim is made that the full optional lane suite completed.
  - Scripted transport proves the mechanical path and race regressions; live model behavior, operator chat clearing and release or bch-cloak cutover remain outside this run's evidence.
---

All findings in the independent review are addressed; the inherited validation log
had zero failures. The supervisor's expected head is the exact final validated
settlement head, including the review record, and the queue receipt retains its run
binding. Queue notices for tip mismatch name the expected and actual hashes and
preserve the lane. Pending requests with different bindings cannot deduplicate.

Regression coverage demonstrates a lane committed again while queued behind another
job, exact-head success, preparation changing a tip, refusal of an automatic rebase,
a superseding run while queued, a new run or blocker during validation, STOP created
by the scripted reviewer before correction dispatch, resumable correction without
repeating review, confirmed-refusal retry with prior receipts, delayed old notices,
stale readiness refusal, duplicate success after lane closure, and pending,
interrupted or uncertain enqueue protection. A completed refusal awaiting notice
delivery can coexist with a fresh pending attempt without replaying the old job.

Validation evidence:

- Baseline npm test: 515 passed, five skipped, zero failed.
- Final npm test: 523 passed, five skipped, zero failed.
- Selected lane promotion/closure cases: 18 passed, 112 excluded by the selection,
  zero failed.
- Corrected lost-start receipt case: one passed, three excluded, zero failed.
- Standalone supervisor acceptance: fresh, history and restarted entry; watch,
  independent finding, correction, PASS, bound queue promotion, guarded record
  completion and duplicate handling passed without a model or real pane.
- git diff --check passed. Main remains an ancestor of this lane; no rebase was
  required before the report commit.

The saved cold start at sequence 1166 has 5261 characters, approximately 1316 tokens
using the existing ceil(characters/4) estimate. It shows six record-open runs,
23 report/settlement rows, one waiting operator question and 128 decisions. Each
running row was checked against the record fold. Missing historical checkouts remain
visible for inspection; the previous run's reconciliation proposal is not duplicated.

The report is checked with the record CLI and committed separately. Lane check is
the final operational command after that commit; its gate records the exact committed
head and result for settlement. No core dependency, event type, stored status,
resident model or new background supervisor was added. The previous report and
legacy contrib watcher remain unchanged. No push, release or shared configuration
change was performed.
