# Deliver portable built-in configuration and template lookup

## Outcome

Ship the specified default role routes and generic templates, with transparent
lowest-precedence sources and repository overrides that preserve the review protocol.

## Repository context and authorization

Read AGENTS.md, README.md, HANDOFF.md, docs/REFERENCE.md, openspec/README.md and this
change's proposal/design/specs/built-in-lane-defaults/spec.md. Inspect the delivered
root-configuration and foreground-lane-review specs, plus this change's
specs/root-configuration/spec.md MODIFIED blocks, before editing their consumers.

Prerequisite: review-cli promoted, after roots-config in the dispatch sequence.
Contract approval: exact A5 in the OpenSpec guide must be approved and applied in
this lane before implementation. No board, registry or idea-cli prerequisite.

When dispatched, work only in lane/default-config and commit the authorized result
including only the approved amendment. Never push, promote or close another lane.
Use one build/test at a time after a clear load probe.

## Scope and limits

lane.mjs; defaults/lane.json; docs/BRIEF_TEMPLATE.md; docs/REVIEW_TEMPLATE.md;
.lane.json.example; test/; README.md; docs/REFERENCE.md; openspec/README.md;
docs/reports/default-config.md; HANDOFF.md; AGENTS.md for approved A5 and ordinary
repository-map maintenance for defaults/ (the map needs no contract amendment).

No installs, account configuration, remote model selection, substitutions, retries,
automatic escalation, new template command, lane new implementation or dependencies.
Suggested route: engineer. Suggested effort: High; one focused session. The required
public model policy is confined to the approved defaults; do not invent other defaults.

At dispatch, choose combined delivery or the D-i default-routes / D-ii
default-templates seam in [design](design.md#pre-agreed-split-point). Partition the
named complete requirements/tests into two briefs before coding; only D-ii completes
the combined capability. Ratify ordinary review's unpinned effort with A5 approval.

## 1. Lane-sized task

- [ ] 1.1 Deliver the adjacent requirements/design under approved A5, observe failing regression controls first, write docs/reports/default-config.md and a dated HANDOFF entry, commit, then obtain a passing GATE against the final commit.

## Acceptance checks

Add built-ins-only tests in test/ with temporary target repos and a copied/symlinked
tool installation. Fake Herdr captures exact kind/model/argument arrays without a
real agent or network. Observe failures before implementing:

- Config-free routes/dispatch/review, all eight profiles/use notes/efforts, sorted
  route output, engineer-equivalent defaults, and no generated host config.
- Parent/repo/explicit-file/environment/CLI precedence; same-name whole-route
  replacement, array replacement, unrelated routes retained, empty objects, strict
  file errors and independent explicit dispatch overrides; partial LANE_CONFIG
  inherits built-in routes and complete definitions replace every shipped role.
- Built-in source attribution in lane config, overridden source provenance and
  inspection-only template rows; no Herdr call or effects during inspection.
- Root placement unaffected by the defaults directory; LANE_CONFIG bypass retains
  built-ins without changing its path semantics or canonical resolver.
- Both template names absent/present independently; target worktree vs unrelated
  cwd/parent; symlinked installation; invalid/missing package data, unreadable or
  escaping repo template, required review envelope and literal placeholder data.
- Client-argument compatibility evidence for the requested effort settings; document
  unavailable client/account checks explicitly, never silently lower an effort.
- README/usage/REFERENCE and example override coverage; no personal/organization
  paths/defaults; existing review schema/witness/dirty-tree/sanitization refusals
  and the unchanged validation/fast-forward safeguards remain green.
  Document all three behavior changes (routes, dispatch, explicit-file inheritance),
  the route-removal limitation and unpinned ordinary-review effort; maintain the map.

Do not run nested builds/tests or install agent/UI dependencies for these fixtures.
Run npm test, relevant deliberate controls and git diff --check serialized; preserve
Node 20/git 2.38 and report exact counts/commands and unverified live behavior.

## Handoff and promotion boundary

Sync only delivered deltas before the final report/HANDOFF commit. Record A5
approval/application, route/precedence compatibility changes, template evidence and
client-support limits in the report. Run lane check after the final commit and
quote GATE outside tracked files. The operator owns any review record commit,
subsequent review/fix rounds, promotion and post-promotion archive.
