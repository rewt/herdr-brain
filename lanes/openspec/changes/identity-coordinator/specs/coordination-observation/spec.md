## Purpose

Propose an optional, read-only board view of manually authorized coordination
records after complete machine discovery; this capability is not current behavior.

## ADDED Requirements

### Requirement: Source-labeled coordination projection
A future CLI snapshot SHALL, when given `--coordination <path>`, project the
design's explicitly selected local schema-v1 snapshot into nullable assignment ID,
project/outcome goal, owner, integration owner, planned milestone, latest delta pointer,
blocker/decision, and next action fields. It SHALL join by canonical repository
and stable assignment and row IDs, label source/revision/observation freshness,
and leave unknown or conflicting values unavailable rather than guessing from
session name, route, root, or title. It SHALL NOT label a planned milestone or
reported delta as accepted without separate project-owner acceptance evidence.
#### Scenario: Ambiguous or absent assignment
- **WHEN** two assignments match a session ambiguously, a delta is historical by HEAD/revision, or no coordination source is selected
- **THEN** the row retains its existing goal/report/gate fields; an ambiguous join is unavailable, a historical delta is labeled historical rather than current, and no work action is inferred.
#### Scenario: Planned and reported are not accepted
- **WHEN** a valid assignment names a milestone and a latest delta reports progress without verified acceptance
- **THEN** the CLI labels the milestone planned and the delta reported; acceptance remains unknown.

### Requirement: Interactive coordination source forwarding
The interactive console SHALL pass the explicitly selected source through the
existing CLI launcher, app arguments, and observation client to each foreground
JSON-watch child, while keeping file reads in the CLI and action arguments
unchanged.
#### Scenario: Initial watch, refresh, and reconnect
- **WHEN** the operator starts interactive board with --coordination, refreshes observation, and the watch child reconnects
- **THEN** the same resolved source reaches every watch child through the launcher/app/client boundary; no focus, done, or lifecycle action is issued or replayed.

### Requirement: Separate coordination attention
A later console view SHALL distinguish explicit coordination blocker/decision
attention from existing technical attention and SHALL not count duplicate reports as
new work or change verified focus/done eligibility.
#### Scenario: Blocker alongside failed gate
- **WHEN** one session has both an explicit assignment blocker and a current failed gate
- **THEN** both reasons are visible, the session is counted once in a combined view, and neither reason triggers review, promotion, close, dispatch, or focus.

### Requirement: Bounded read lifetime
Coordination projection SHALL enforce the design's regular-file, 1 MiB raw-byte,
32-project, 512-assignment, 32-links-per-assignment and 4,096-total-link limits,
field types, nullability, and timestamp checks. It SHALL keep read freshness
separate from HEAD/revision applicability, respect machine coverage and foreground
lifetime, and not add a background scheduler, model polling, heartbeat, persistent
queue, or replay on reconnect.
#### Scenario: Unsafe or oversized input
- **WHEN** the selected path is a symlink, non-regular file, over the byte or collection cap, malformed, or wrong-typed
- **THEN** coordination coverage reports a localized unavailable/error state, unaffected board rows remain, and no unbounded read or lifecycle action occurs.
#### Scenario: Readable obsolete and unchanged valid snapshots
- **WHEN** an old file is reread successfully but its assignment or delta HEAD/revision differs from verified Git evidence, or an unchanged file still matches that evidence
- **THEN** the first is historical despite a fresh read, the second stays applicable regardless of age, and neither requires a heartbeat or implies accepted work.
#### Scenario: Read fails during refresh
- **WHEN** the optional source becomes unreadable after a successful observation
- **THEN** retained values are visibly read-stale or unavailable, errors are localized, and no lifecycle action runs.
