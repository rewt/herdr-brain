---
run: R-62
outcome: done
summary: |
  Added a shared ordered action checklist to generated report templates and question help, with explicit waiting when uncertain. Added dependency-free lexical checks at question creation, report check and report ingest; suspect auto-category entries record advisory events and remain visible in record attention and both consoles, including completed work. Automatic answers and derived work status keep their existing behavior, and frozen older folds ignore the new events.
headline: Agents now get category guidance and suspect automatic choices stay visible for review.
blockers: []
proposals: []
learnings:
  - "HUM-17's recorded operator-approved adjustment keeps security, funds-and-chain, publish, licensing, delete-data, priorities and other as ask; auto design was specific to herdr-brain. This change preserves shipped and project-specific approval policies."
  - "Report decisions and questions currently remain lenient front-matter extra fields. The guard accepts those and normalized fields; an uncertain question must be created with record ask --wait to actually wait and block work."
artifacts:
  - "Commit: Guide category discernment and flag risky automatic entries"
  - "Commit: Report category discernment implementation and offline evidence"
  - "Branch: lane/category-discernment"
  - "lib/discernment.mjs; lib/report.mjs; bin/org.mjs; lib/state.mjs; lib/render.mjs"
  - "console/lib/model.mjs; console/lib/frame.mjs; console/modern/model.mjs; console/modern/project.mjs; console/modern/frame.mjs"
  - "test/discernment.test.mjs; console/test/modern.test.mjs; README.md"
  - "Offline test evidence: /tmp/arch12-after.log; /tmp/arch12-final-full.log; /tmp/arch12-final-targeted.log; /tmp/arch12-baseline-rerun.log; /tmp/arch12-watch-rerun.log; /tmp/arch12-lanes.log"
  - "Final clean-commit gate: node lanes/lane.mjs check; .lane/gate.json; /tmp/arch12-gate.log"
decisions:
  - text: Use advisory events to retain category review evidence after automatic completion.
    category: design
    why: Work status stays derived and the operator can see a suspect choice even after its question or report finishes. The event retains category, matched signal names, source field, run and actor without copying sensitive prose.
  - text: Keep the existing approval policies and explicit waiting behavior.
    category: design
    why: Category discernment should respect project authority. The checklist tells an uncertain worker to pause the dependent action, create a question with --wait and include its id in the report.
questions: []
challenges:
  - "Lexical evidence cannot establish intent: negated mentions and harmless technical references can also flag. The product labels these as category review, never as a verdict or authorization."
  - "Flags remain visible as review evidence; this slice does not add a dismissal command or claim to implement structured report question routing."
---

The checklist follows the action being authorized, first match wins: security;
funds and chain; external publication; data deletion; licensing; priorities; then
ordinary design, prover, tooling, goals or other. Both `record help` and
`record ask --help` carry the same text as generated report templates. Templates
now include decisions, questions and challenges after artifacts.

The no-model backstop checks categorized decisions and questions in report front
matter and all question prose, including rationale, consequences and memo contents.
It recognizes keys/credentials, pins, push, publish/deploy/release, broadcast,
vulnerabilities/CVE identifiers and deletion/removal, with case and common
inflections. It honors the effective project policy, including custom categories
and fallback, and treats an explicit CLI `--wait` as already waiting. It does not
infer categories from report narrative or scan metadata paths as prose.

Ingest records each `category.flagged` event in the report transaction; retrying
the same report produces no duplicate flags. CLI question creation still returns
only its question id on stdout, with warnings on stderr. `record check` previews
flags without changing the log. No flag changes an answer, blocks ingestion or
stores a work status. A frozen pre-change fold accepts the resulting log and
derives the same completed work status.

Operator visibility uses existing attention projections in `record status`,
`today`, snapshots and item details. The classic console shows Category review;
the modern console shows flags on the project overview and Needs you page, with
the source item available to open. Its Needs you count includes category flags,
so completed work requiring review cannot hide behind a zero attention count.

Validation: the first post-change `npm test` passed 405 tests with two explicit
skips (407 total). The final focused run passed all 51 tests, including a real
modern-console frame showing a completed item's flag on overview and Needs you
and opening its source. The earlier broader focused run passed all 78 tests.
The initial pre-change suite had 20 timeout failures under concurrent machine
load (379 passed, two skipped); its console and discovery files passed all 27
tests when rerun separately. Two leaked scratch watchers from that failed
baseline were stopped by their verified process ids.

`npm run test:lanes` passed all 146 tests, with no skips, in the lane's scratch
fixtures. The final full-suite rerun passed 405 tests, skipped two explicitly,
and hit the existing three-second watcher recovery timeout once. Running the
entire watcher file separately passed all 17 tests. The final focused run after
the console count adjustment passed all 51 tests.

`record check` validates this R-62 report without ingesting it into the shared
record. After committing the report, `lane check` runs last on the clean commit;
its gate receipt and console log are the final handoff evidence. No live panes,
shared configuration, other projects, activated releases, model calls, remote
pushes or publication were used.
