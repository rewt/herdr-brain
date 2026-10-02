---
run: R-101
outcome: done
summary: |
  Resolved both independent review findings. Late final report notices now recover completed promotions from the bound supervisor and queue receipts before invoking settle, including after lane deletion, with the existing integrated-head and current-run checks intact.
  The release supervisor-entry assertion now verifies the generated cold start and final-notice handler. The same assertion runs offline against the actual policy-only installed adapter in an untouched project without launching a native model.
  All 18 focused tests and the full post-change npm suite pass. The saved repository cold start is approximately 1377 tokens. Implementation and evidence are committed on this lane; the checked report is committed separately before the final lane gate.
headline: Late report notices recover completed work and the release entry check matches the supervisor protocol
blockers: []
proposals: []
learnings:
  - A delayed final report may arrive after the promotion queue removed its checkout but before the queue notice closed its record item; completed bound receipts can finish that handoff without opening the checkout.
  - Completed report and queue notices use the same binding, integrated-tip and conditional record-close checks; duplicate completion adds no events, model calls, transport calls or promotion jobs.
  - Discovery supervisor entry supplies the record cold start and notice protocol; dispatch arms watch, so a literal watcher CLI path in entry policy is not the release contract.
artifacts:
  - "Commit: Recover completed supervisor notices and align entry gate"
  - "Commit: Report supervisor review corrections for run R-101"
  - supervisor/supervisor.mjs
  - supervisor/test/supervisor.test.mjs
  - supervisor/PROTOCOL.md
  - supervisor/README.md
  - acceptance/entry.mjs
  - acceptance/run.mjs
  - acceptance/supervisor.mjs
  - discovery/test/entry.test.mjs
  - docs/reports/evidence/ENG-94-supervisor/R-101-validation.json
  - docs/reports/evidence/ENG-94-supervisor/R-101-cold-start.txt
  - docs/reports/evidence/ENG-94-supervisor/R-101-cold-start.json
  - "Validation: npm test before and after changes; focused discovery entry and supervisor tests; record check this report; lane check as the final operational command after the report commit"
decisions:
  - text: Recover completed promotions before settlement and share the existing promotion-notice completion handler.
    category: design
    why: Completed queue work can lose its checkout; both notice orders must rely on bound receipts and retain the same integration and record guards.
  - text: Share the supervisor-entry contract assertion with the offline installed-adapter test.
    category: prover
    why: The old watcher-path assertion rejected valid entry policies and was outside the inherited npm gate; testing the actual cold-start and notice contract through one assertion prevents that drift.
questions: []
challenges:
  - Evidence covers scripted supervisor mechanics and the actual offline entry-policy adapter; live model behavior, operator chat clearing, the full release harness, bch-cloak cutover and the full optional lane suite are not established by this run.
---

Both findings in the review of the previous report are resolved. Its inherited
validation log had zero failures and required no separate validation correction.
The previous reports and the legacy contrib watcher remain unchanged.

The new delayed-report regression first reproduced settle's ENOENT after the queue
removed the lane. It now demonstrates recovery before the queue notice completes
the record, repeated completion after closure, and an explicit run-ID recovery.
Altered queue bindings and a promoted head absent from canonical history refuse
completion. A superseding run stays active for both final-report and queue notices.
The existing complete supervisor acceptance cycle now includes a duplicate watch
final report after lane removal, with no repeated review or promotion.

The release supervisor-entry case calls the shared assertion for the installed
policy's generated record sections, supervisor CLI and report/settle/promotion
notice protocol. The offline regression enters a separate untouched Git project,
bootstraps its record, checks that same assertion and proves the native binary was
never called. Removing either the generated cold start or the final-notice command
makes the assertion fail.

Validation evidence:

- Baseline npm test: 523 passed, five skipped, zero failures.
- Focused discovery entry and supervisor tests: 18 passed, zero skipped or failures.
- Final npm test: 525 passed, five skipped, zero failures.
- The focused and full npm runs include the complete scripted unconfigured
  supervisor entry/watch/settle/fix/promotion/closure acceptance cycle.
- git diff --check passed. Main remains an ancestor of this lane; no rebase was
  required before committing the implementation.

The saved cold start at sequence 1200 has 5507 characters, approximately 1377 tokens
using ceil(characters/4). Its six running rows and routes were checked against the
record fold; it also shows 22 report/settlement rows, one waiting operator question
and 128 decisions. Missing historical checkouts remain visible for inspection.
The earlier historical-completion reconciliation proposal is not duplicated.

The report is checked with the record CLI and committed separately. Lane check is
the final operational command after that commit; its local .lane/gate.json records
the exact committed head and result for settlement. No dependency, event type,
stored item status, resident model or background supervisor was added. No push,
release, shared configuration or live pane change was performed.
