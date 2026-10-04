---
run: R-231
outcome: done
summary: |
  Added deterministic active-lesson selection and a five-lesson section to record-generated run briefs, plus a bounded Lessons section and proposed count in the supervisor cold start. Added the AGENTS.md discovery line. Tests were written first; 29 record tests and seven focused cold-start tests pass. The context change merges cleanly with the current storage lane in either order.
headline: Run briefs and supervisor cold starts now carry active lessons.
blockers: []
proposals: []
learnings:
  - Run briefs are saved snapshots; record start builds them through renderBrief, and record brief rebuilds only a missing file. Adapter changes are unnecessary for new runs to receive this section.
  - An external dispatch ask is not an input to renderBrief; an ask recorded in item notes participates in literal lesson matching.
artifacts:
  - "Implementation commit: 86300aa"
  - "Branch: lane/lessons-push"
  - lib/lessons.mjs
  - lib/render.mjs
  - supervisor/context.mjs
  - AGENTS.md
  - test/lessons.test.mjs
  - supervisor/test/supervisor.test.mjs
  - "node test/helpers/run.mjs test/lessons.test.mjs test/flow.test.mjs test/sanitization.test.mjs — 29 passed"
  - "node test/helpers/run.mjs --test-name-pattern='^(cold start|ingested report decisions|full JSON preserves)' supervisor/test/supervisor.test.mjs — 7 passed, 15 unrelated cases skipped"
decisions:
  - text: Select active lessons by literal selectors in item text, evidence tied to the item or its ancestors, and applicability without selectors.
    category: design
    why: This uses only durable record facts, respects targeted lessons, and works for any harness without a model or filesystem search. Text matches lead evidence matches, then broad lessons; project, fleet, framework scope and numeric lesson ID break ties.
  - text: Reuse the existing five-lesson renderer in run briefs and the supervisor's section limit for cold starts.
    category: design
    why: Context remains bounded while claims, evidence and retrieval instructions remain visible. JSON keeps every active lesson and the full provenance.
questions: []
challenges: []
---

The implementation stays within ENG-170's narrowed scope: run briefs, supervisor cold start, and the agent-instructions line. Entry adapters, MCP and the release-gate case remain with ENG-173.

Brief relevance reads the item's title, creation reason, acceptance criteria and notes. Paths match literal project-relative mentions or descendants at a slash boundary, with an optional leading `./`; modules match case-sensitive literal names at token boundaries. A sentence-ending period is accepted as punctuation. Evidence to an item ID, or a run on that item, matches the current item and its ancestor chain. Event-only evidence does not infer an item association. Lessons without path/module selectors apply across their recorded scope. Retired, superseded and proposed lessons are excluded by the existing derived-state query.

The brief omits the section when there are no matches. Otherwise it shows up to five claims of at most 400 Unicode code points, with bounded applicability, proposer and evidence summaries. Remaining matches are counted and `record lessons --json` is named for retrieval. Existing saved briefs retain their original snapshot.

The supervisor receives all active lessons in `lessons.active`, ordered by scope and numeric ID, and a proposed count in `lessons.proposed`. Its text section defaults to six claims, bounds evidence to 100 characters per row, reports overflow, and names `record lessons --state proposed` for activation review. The JSON carries the complete active rows. Reading this section does not write the record or call a model.

Seven new regression cases were run before implementation: one omission case passed and six inclusion cases failed as expected. The tests cover empty and matching briefs, text and evidence relevance, selector boundaries, deterministic ordering, overflow, lifecycle exclusions, arbitrary harness metadata, cold-start proposals, terminal controls and Unicode. Two additional edge assertions were observed failing before their fixes. The final relevant runs passed all 36 executed cases; no baseline, promotion suite or live acceptance harness was run.

Read-only inspection of the seven existing active lessons, using the ENG-170 file list as an in-memory item note, selects L-1, L-3 and L-5. The real supervisor cold start displays L-1 through L-6, counts one additional active lesson, and reports zero proposals. The inspection does not persist the sample note or rewrite the run brief.

The Lessons additions in `supervisor/context.mjs` use separate import, data and rendering locations from the footprint changes. `git merge-file` against the current `lane/lean-storage` version succeeds in both orders and retains both sections.

The required final lane check runs after this report is checked and committed:

```sh
node lanes/lane.mjs check --cmd "node test/helpers/run.mjs --test-name-pattern='^(run brief|record start writes lessons|cold start|ingested report decisions|full JSON preserves)' test/lessons.test.mjs supervisor/test/supervisor.test.mjs"
```

Its result is recorded in `.lane/gate.json` for the committed lane HEAD.
