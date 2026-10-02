**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: d3ea8c2985cbdcc091f4a74a45e49dbcf845e729
Topic: settle
Round: 1
Review ID: lr-399501a546c7a2e55f197bb33d3120e0
Base branch: main
Base commit: 4ff362df6b72dedfac7c6ac0091486becc8cdaac

## Findings
- [Major] settle/settle.mjs:261 - The default review cannot legitimately reach \`promotable\`: the generated supplement supplies no explicit \`Review run budget\`, so the review template requires the reviewer to record the zero-command limit under Unverified, but this branch escalates every PASS whose Unverified section is not \`None\`. The scripted reviewer masks the mismatch by emitting \`None\` despite that instruction; Fix: make the generated budget and review contract explicit, distinguish acknowledged inherited validation from unresolved acceptance evidence in the readiness decision, and make the default-cycle fixture obey that contract.
- [Major] settle/settle.mjs:205 - Every ingested outcome is reopened before the non-done handoff. Reopening clears the item's outcome, so a \`needs\_human\` report or a \`blocked\` report without linked blockers becomes \`ready\` even though settle returns an escalation. The operator's derived needs-human and blocked views consequently lose the item; Fix: reopen only a done outcome being held for review, preserve non-done outcomes, and assert the derived item status in the non-done settlement tests.
- [Moderate] settle/settle.mjs:169 - Normal project discovery returns a routing-only merge that discards both \`settle\` and \`main\`. Consequently the documented tracked settle overrides are silently ignored, and a project configured to integrate into a branch such as \`develop\` still tries to resolve \`main\`, failing before report ingestion when that branch is absent; Fix: load the lifecycle and settle settings from the discovered configuration layers with the same precedence as the lane CLI, and cover configured settle overrides and a non-main integration branch.
- [Moderate] settle/settle.mjs:107 - If the operator drops the item while the independent review is running, a NEEDS-WORK result still reaches correction dispatch. This function reads the current item but checks only open runs; dispatch then calls record start, which automatically reopens the dropped item and launches work that the operator stopped; Fix: recheck the item's current closure and blocking state immediately before a new correction dispatch, return an evidence handoff when continuation needs judgment, and cover an item dropped during review.
- [Moderate] settle/settle.mjs:159 - Repeating a saved \`promotable\` result rechecks only the lane's cleanliness through \`unchanged()\`. If the canonical checkout becomes dirty after the first result while both heads remain fixed, this path still returns \`promotable\`, although the initial decision and lane promotion require that checkout to be clean; Fix: apply the canonical checkout cleanliness check when returning cached readiness as well as on the first decision, and cover a canonical edit after a saved result.

## Re-executed
```json
[]
```

## Non-claims
- The supplied npm test gate is inherited evidence only; this reviewer executed no tests and observed no negative-control or mutation witness.
- The offline fixture scripts model transport and the claim verdict; it does not establish live independent review quality or real pane transport.

## Unverified
- The supplemental brief has no unambiguous Review run budget authorizing exact commands and finite counts. The build, test, prepare, install, and check budget was therefore zero; none of those commands was executed.
- Runtime reproduction and regression coverage for the findings remain unverified under the zero-command budget. Findings are supported by read-only source inspection.
- The supervisor's next real report and live report-to-settlement acceptance remain unverified. The committed implementation report explicitly leaves that canary outstanding, and live lifecycle actions were outside this review's authority.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
