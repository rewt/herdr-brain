---
run: R-103
outcome: done
summary: |
  Resolved both independent review findings. Supervisor cold starts now include structured report decisions at their ingestion sequence, with run and item provenance and full rationale in JSON, retaining them through item closure, lane removal and checkpoint recovery.
  A late original-run notice after its correction loses the checkout now returns read-only supersession before settle. The promoted correction still uses bound queue receipts, integrated-head checks and conditional record completion. Both runs' notices repeat safely in the complete acceptance cycle.
  Rebased onto current main and corrected its discovery probe's remaining obsolete watcher-path assertion using the shared supervisor-entry contract. Bounded retries resolve a transient scratch-cleanup race observed during validation. The focused supervisor/entry tests, three discovery probe regressions and full host npm suite pass. The saved repository cold start is approximately 1360 tokens.
headline: Supervisor sessions retain report decisions and safely handle older correction notices
blockers: []
proposals: []
learnings:
  - The ingestion sequence is the checkpoint boundary for report decisions, even when the run predates the checkpoint; item closure and checkout removal do not retire those facts.
  - Structured report decisions currently live under report.extra.decisions; the cold start also accepts a normalized report.decisions field and never mines narrative.
  - An original run can have a completed fix-round receipt but no promotion request because only its correction was promoted; read-only supersession can point to the record's latest run without claiming integration or closing work.
  - Discovery's acceptance probe must use the same generated cold-start and notice-handler assertion as the release gate; the literal watcher CLI path is not the entry contract.
  - The rebased macOS lifetime fixtures require execution outside the outer worker sandbox so their own sandbox-exec boundaries can start; no model or authenticated live probe is needed.
artifacts:
  - "Commit: Retain supervisor report decisions and skip superseded notices"
  - "Commit: Report supervisor continuity corrections for run R-103"
  - supervisor/context.mjs
  - supervisor/supervisor.mjs
  - supervisor/test/supervisor.test.mjs
  - supervisor/README.md
  - supervisor/PROTOCOL.md
  - acceptance/supervisor.mjs
  - acceptance/entry.mjs
  - discovery/acceptance.mjs
  - settle/test/fixture.mjs
  - docs/reports/evidence/ENG-94-supervisor/R-103-validation.json
  - docs/reports/evidence/ENG-94-supervisor/R-103-cold-start.txt
  - docs/reports/evidence/ENG-94-supervisor/R-103-cold-start.json
  - "Validation: npm test before and after changes; focused supervisor/entry and discovery probe tests; record check this report; lane check last after the report commit"
decisions:
  - text: Include structured report decisions in the repository-scoped event-sequence decision stream with full rationale and run/item provenance.
    category: design
    why: A fresh session must recover decisions from closed work and from runs started before its reading checkpoint; the report's narrative cannot supply structured authority.
  - text: Return read-only supersession for a missing older checkout when the record proves a newer run exists, while retaining promotion completion exclusively through its existing guarded receipts.
    category: design
    why: The older run has no promotion request of its own, and pointing to current work avoids reopening a deleted checkout without asserting integration or closing the correction.
  - text: Reuse the shared supervisor-entry assertion in the discovery acceptance probe and include its helper in the scratch product snapshot.
    category: prover
    why: Rebased discovery tests exposed another copy of the obsolete watcher-path assertion; one contract verifies generated context and the notice path across all three consumers.
  - text: Briefly retry transient removal failures in the owned settle test scratch directory after terminating its watcher.
    category: prover
    why: A full host run exposed ENOTEMPTY in cleanup while a watcher finished a log write; three bounded retries handle that race without altering settlement behavior.
questions: []
challenges:
  - The first full run on rebased main had 17 nested macOS sandbox setup failures and three obsolete discovery assertion failures; the host retry also exposed one transient fixture cleanup race. These are recorded in validation evidence and resolved by the final green host run.
  - Scripted mechanics are established; live model behavior, actual operator chat clearing, the full release harness, bch-cloak cutover and the full optional lane suite are not claimed.
---

Both findings in the review of the previous report are resolved. Its inherited
validation log had zero failures. Previous reports and the legacy contrib watcher
remain unchanged.

The new regression cases first reproduced the absent report decisions and
settle's ENOENT for an original notice after correction promotion. Report ingestion
now exposes decision text, category, rationale, worker/ingestion actors, sequence,
run and item. Tests retain this evidence after closure and lane removal, exclude
proven foreign repositories, recover history after checkpointing, and ignore
unrecorded files and narrative.

The acceptance cycle repeats both original and correction final notices twice
after lane closure. The original returns superseded with the current run; the
correction returns guarded recorded promotion. Duplicates add no record events,
transport/model calls or queue jobs. Separate cases reject altered queue bindings,
a promoted tip absent from canonical history, and completion after a newer run.
An older notice cannot close the correction even before the queue handoff lands.

The rebase brought in discovery regressions that exercise its independent
acceptance probe. That probe now uses the shared entry assertion, with its helper
included in the copied scratch product. Its three no-auth/skip-live cases pass
without launching the supplied fake native binary.

Validation evidence:

- Baseline npm test before rebase/source changes: 525 passed, five skipped, zero failures.
- Focused supervisor and installed-entry tests: 20 passed, zero failures or skips.
- Discovery probe regressions: three selected tests passed; 30 unrelated tests were excluded by the name filter.
- Final host npm test: 570 passed, 11 explicitly skipped, zero failures or cancellations.
- git diff --check passed; main is an ancestor after the clean rebase.

Record check accepts the report. Its two advisory deletion-keyword flags were
inspected: the design action reads the current run and returns a pointer, and the
prover action retries the existing fixture's disposal of its own temporary
directory within the authorized scratch scope.

The saved repository brief at sequence 1218 has 5438 characters, approximately
1360 tokens using ceil(characters/4). Full JSON retains 365 decisions, including
236 structured report decisions and 19 from explicitly closed items. Its three
running rows and routes, 24 current report rows, and every structured report
decision/rationale were checked against the event fold through that sequence.
The sample retrieves history from sequence zero without advancing the checkpoint
or changing the shared record. The existing historical reconciliation proposal
is not duplicated.

The implementation and evidence are committed by the subject cited above. This
checked report is committed separately. The final lane gate runs after the report
commit; its exact HEAD, command and result are saved in local .lane/gate.json for
settlement. No dependency, event type, stored item status, resident model or
background supervisor was added. No push, release, shared configuration or live
pane change was performed.
