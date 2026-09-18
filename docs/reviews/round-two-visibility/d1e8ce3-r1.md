**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: d1e8ce3af99596fc2b344bf3ea3ede3eb0119890
Topic: round-two-visibility
Round: 1
Review ID: lr-510198ae63726c32f756b00cc7be92e2
Base branch: main
Base commit: 281242b933d8ad51ac7a163fb95cd32a1241434b

## Findings
- [Moderate] console/lib/model.mjs:392 - Waiting on you now drops every brain result whose project is \`other\` from every console tab, while the project switch key only cycles configured projects and is disabled when one project is configured, so the new summary line counts \`other\` results (including stranded replies) that the operator can no longer open anywhere in the console, although they were visible before this change; Fix: keep \`other\` results reachable in the console, for example by listing them in every tab or adding an \`other\` stop to the project switch cycle, and add a board test that an \`other\` result can be displayed.
- [Minor] console/lib/brain.mjs:21 - buildBoard filters by the project names in the configuration the console loaded, but readQueue spawns brain without that configuration, so brain assigns names from HERDR\_ORG\_CONSOLE\_CONFIG or the default console.json; a console started with \`--config FILE\` whose names differ hides every brain result and counts them under names that are not tabs; Fix: pass the console's loaded config path to the brain child, for example by setting HERDR\_ORG\_CONSOLE\_CONFIG in the execFile env, and cover it with a test.
- [Minor] brain/lib/capture.mjs:69 - for Codex the prompt box is disabled outright and only the exact \`Ask Codex to do anything\` placeholder is trimmed, so text the operator typed into the Codex composer and never sent is returned as the session's \`said\` text and headline with \`unsent\` null, and that row lands in Finished instead of stranded; Fix: for Codex, treat the trailing composer line that begins with the Codex prompt glyph as the input box (normal-intensity text becomes \`unsent\`, faint text is a placeholder), exclude it from \`said\`, and add a fixture with typed composer text.
- [Minor] contrib/tidy-tabs.mjs:123 - the verdict check accepts only PASS and NEEDS-WORK, and only at the first byte of the record, so an idle review whose newer record carries a FAIL verdict never counts as finished and its tab is never closed; Fix: accept all three lane-review verdicts on the first nonempty line and add a reviewedAgentsFromRecords test with a FAIL record.
- [Minor] docs/reports/one-brain-round-2.md:2 - the report commit overwrites the R-12 report for ENG-14 that main already tracks at this path, so promotion removes that round's report from docs/reports, and the R-13 report does not mention the replacement; Fix: restore the R-12 report content under a non-colliding name such as docs/reports/one-brain-round-1b-r2.md and note the rename in the R-13 report.
- [Minor] README.md:358 - the public docs still describe Waiting on you as showing the brain queue at the top, and brain/README.md line 63 says the console shows this queue, with no mention of the per-project filter, the waiting-elsewhere summary line, the \`other\` project, or the new project column in \`brain queue\` and \`brain show\`; Fix: document the project derivation, the filter and summary line with the project switch key, and the project column in both READMEs.

## Re-executed
```json
[]
```

## Non-claims
- No claim that \`npm test\`, \`npm --prefix console test\`, or the 140x45 console print render pass at the reviewed commit; none were executed in this review.
- No claim that the test counts, render result, or live tidy-tabs dry-run output recorded in the R-13 report are accurate.

## Unverified
- npm test, npm --prefix console test and the console print render were not executed because the supplemental brief contains no Review run budget, so the command budget is zero, and no usable gate existed at the captured HEAD.
- The live tidy-tabs dry run in the report was not re-run; it would consume the zero budget and Herdr state has changed since, so whether finished engineer tabs existed at that time is unverified.
- Parsing of a real ANSI-format Codex capture was not exercised; the fixture is plain text condensed from a real Codex screen, checked only by reading the stored screen of the misclassified result.
- Whether the Codex composer placeholder text varies across Codex versions or sessions was not checked against a live screen.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
