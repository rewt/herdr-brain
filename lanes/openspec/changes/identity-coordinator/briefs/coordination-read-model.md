# Brief: project the coordination record through the CLI

Status: future engineering lane. Start only after reviewed board-inventory and
board-sampling are promoted and the manual protocol/source format is reviewed.
Read repository instructions, `openspec/README.md`, all identity-coordinator
artifacts, both split discovery changes, current CLI/identity/session specs, and
the project policy. Work in a newly authorized lane; do not edit the inventory,
sampling, or frame lanes. Suggested route: engineer; effort: High.

## Outcome and boundary

Add the design's explicit `--coordination <path>` read-only schema-v1 snapshot and
additive projection to `lane board --json` and watch. The same flag in interactive
mode must refuse with a clear pending-UI message until the later brief completes
forwarding. Plain output remains unchanged. There is no implicit machine search or
writer. Join by canonical Git common directory and exact stable assignment/row IDs,
not root label, role, or title. Expose nullable assignment/outcome goal/owner/
integration owner, planned milestone, reported delta pointer/revision/sequence,
blocker/decision/next action, read freshness and HEAD/revision applicability.
Never copy raw private report text or make the source a registry, lease, queue, or
authority. Keep coverage and source errors localized. Existing `row.goal`, lane
`report`, gate, action eligibility and row ID retain their meanings.

Scope: `lane.mjs` read-mode parsing/projection, dependency-free board service,
`test/`, CLI usage, short README flag documentation, detailed REFERENCE semantics,
the complete Source-labeled coordination projection and Bounded read lifetime
requirement blocks into `openspec/specs/coordination-observation/spec.md` only
after implementation, report, and HANDOFF. No
`board/app.mjs`/`board/ui/`, background process, model call, lifecycle action,
metadata writer, dependency, identity/account change, or replay. An unregistered
session without a proven assignment join remains unknown.

## Test-first acceptance

Observe failing offline `test/` cases with deliberate negative controls for
duplicate repository labels, ambiguous/missing assignment, stale revision,
conflicting report ID/sequence, non-regular/symlink source, 1 MiB+1-byte refusal,
collection/text/type/nullability bounds, changed-file read, invalid timestamps,
readable obsolete HEAD versus unchanged applicable content without heartbeat,
missing HEAD as unknown, machine partial coverage, focus/done option refusal,
no action on refresh/reconnect,
bounded large-fixture observation, invalid/duplicate project or row mappings,
and absence of UI dependencies. Use system-temp fixtures and cleanup; no live
Herdr required. The CLI read must not call a lifecycle action or expose raw
private source text in errors.
Keep board-sampling's two-child/one-refresh bounds and current gates intact. Run
serial `npm test`, relevant controls, strict OpenSpec validation, `git diff --check`,
and public-safety scan after a clear process probe. Commit report/HANDOFF and run
`lane check` at final HEAD; hand off to the integration owner for review/promotion.
