# Deliver one foreground independent-review command

## Outcome

Add the reviewer template and lane review: explicit round/source, one routed review,
private schema validation, tool-enforced clean HEAD/tree and sanitized public output.

## Repository context and authorization

Read AGENTS.md, README.md, HANDOFF.md, docs/REFERENCE.md, openspec/README.md,
docs/BRIEF_TEMPLATE.md, then this change's proposal, design and
specs/foreground-lane-review/spec.md. Follow shared engineering delivery rules.

Capability prerequisites: none beyond current main. Dispatch after roots-config
promotes because both touch lane.mjs/config; use its resolver. No registry/board or
default-config prerequisite. No AGENTS.md contract amendment: the updated guide protocol is
this lane's scope; A1-A5 belong to their named lanes.

When dispatched, work only in lane/review-cli and commit the authorized engineering
result. Never push, promote or close another lane. The resulting reviewer template
has narrower permissions: its private report is required; tracked/public edits and
commits are forbidden. One build/test at a time after a clear load probe.

## Scope and limits

lane.mjs; docs/REVIEW_TEMPLATE.md; test/; README.md; docs/REFERENCE.md;
openspec/README.md; docs/reports/review-cli.md; HANDOFF.md; AGENTS.md repository-map
entry for docs/REVIEW_TEMPLATE.md only (no contract amendment). No dependencies, config
keys, fixes/loops, wrapper, background monitor, promotion policy or UI changes.

Suggested route: engineer. Suggested effort: High; one focused session.
Use configured routes; no model/account defaults are introduced by this lane.

At dispatch, choose this combined task or the pre-agreed R-i review-private / R-ii
review-public split in [design](design.md#pre-agreed-split-point). Create one brief
per named requirement/test slice before coding. R-i ends at private evidence with
no public output; default-config waits for R-ii. Never mark partial combined work done.

## 1. Lane-sized task

- [x] 1.1 Deliver the adjacent requirements/design, observe failing controls before behavior changes, write docs/reports/review-cli.md and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Use a fake Herdr/reviewer fixture exercising the existing dispatch path and writing
only the private file from rendered metadata in cleaned system-temp repositories.
The template must forbid all lane-worktree writes, including untracked/ignored scratch.
Do not run a real agent or nested npm test/build. Use short deadlines/internal clock
seams for timeout tests, never a production environment switch. Fail first on:

- Canonical/linked lookup, clean/dirty/foreign lane, full HEAD/base, private-ignore
  and public-trackability checks, symlink escapes and existing-round collisions.
- Explicit round/source requirements; --change with different topic and all delta
  specs; --brief/both; default/override/unknown route; invalid/duplicate flags and
  timeout; literal multiline/shell-looking input; gate success/failure/absence.
  Assert exactly 2, with no verdict stdout, for every refusal; shared fail() is not
  a valid review error path even when a shared helper fails before dispatch.
- Required private output permission, zero/explicit budgets and load instructions;
  exact schema/first-line verdict, tags/file:line/fix and all required sections;
  missing witnesses, invalid control evidence and full-SHA/review-ID mismatch.
- Fake PASS/NEEDS-WORK/FAIL records, incomplete writes/marker, missing or oversized
  record, exact stdout and exits 0/1/2; default timeout and interrupted dispatch/wait.
- HEAD movement and tracked/index/untracked dirtiness after dispatch, including
  reviewer-written public output; no public generation before the clean-tree check.
- Sanitization of POSIX/drive/UNC/file-URL paths, injected OS username/home basename/
  hostname/first label/declared tokens, case-insensitive segment/word boundaries,
  fixed placeholders and counts. Cover unrelated-word preservation, nested automatic
  aliases, declared-token ambiguity, protected file:line matches, the ASCII payload
  restriction, prose escaping after unescaped idempotence checks, redacted labels,
  private Analysis omission and residual alias refusal. These tests belong to R-ii
  when split.
- One dispatch, no follow-up actions, local resource cleanup, late evidence retained,
  no overwritten/staged/committed record, and existing check/promote clean-tree refusal
  after the CLI creates the expected public output.
  Cover a late-publication exit 2 leaving evidence and the exact same-round recovery.
- Template, CLI usage, README table/link, REFERENCE defaults/schema/exits/recovery,
  and shared review-only rules. Verify generated verdicts with the existing board
  parser without changing that parser's public behavior.
  Document configuring review first until default-config ships, and maintain the map.

All adjacent scenarios are acceptance. Built-ins-only tests under test/ and negative
controls precede implementation. Preserve Node 20, git 2.38, dispatch cwd/startup
safeguards and validation/fast-forward promotion. Run npm test, relevant controls
and git diff --check serialized; report commands/counts and unverified live checks.
Audit the full diff for private source text and keep the template public-safe.

## Handoff and promotion boundary

No wrapper or automatic fix loop. If reviewed, public evidence lives under
docs/reviews/review-cli/ and remains tied to its original SHA; operator authorization
controls its commit and further rounds. Sync only this implemented delta into the
current spec before the report/HANDOFF commit. Run lane check afterward and quote
its exact GATE in the conversation without another tracked commit. The operator
promotes by the unchanged validated fast-forward workflow and archives afterward.
