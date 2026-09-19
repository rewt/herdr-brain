## Purpose

Automatically attach useful display metadata to dispatched agents and hide completed
lane history without making the registry authoritative for git or work scheduling.

## ADDED Requirements

### Requirement: Successful dispatch metadata
Dispatch SHALL record one session with the design's schema only after verified cwd
and successful startup/prompt delivery. Role, goal, brief, and report SHALL follow
the documented route and brief conventions.
#### Scenario: File brief and route
- **WHEN** an engineer-route dispatch successfully sends a heading-bearing brief
- **THEN** the canonical ignored registry gains the actual agent/workspace/pane, engineer role, source brief path, heading goal, and conventional report path.
#### Scenario: Inline or headingless brief
- **WHEN** dispatch uses inline text, a headingless file, or no prompt
- **THEN** the documented goal fallback is used, brief is null only when there is no source file, and no report/verdict is invented.
#### Scenario: Unsafe registry
- **WHEN** the configured automation path is tracked, unignored, external, symlink-escaped, or unwritable
- **THEN** dispatch refuses before starting or prompting an agent and names the corrective configuration action.

### Requirement: Concurrent display records
Independent successful dispatches SHALL retain every session without shared-array
lost updates, a lock service, or hidden coordination. Legacy arrays SHALL remain readable.
#### Scenario: Two simultaneous dispatches
- **WHEN** two dispatches finish at the same time in one repository
- **THEN** both records appear and neither overwrites legacy metadata or the other's record.
#### Scenario: Concurrent completion marks
- **WHEN** two boards mark different sessions done, or close and a board mark the same session
- **THEN** all done flags remain recorded and unrelated records are unchanged.

### Requirement: Honest partial dispatch
A registry write failure after a delivered prompt SHALL report partial success with
the existing agent identity and SHALL not replay the action.
#### Scenario: Storage fails after delivery
- **WHEN** the prompt succeeds and the atomic record write fails
- **THEN** the command exits nonzero, says the brief was sent, identifies the live agent, and neither prompts again nor deletes its work.

### Requirement: Completion follows git close
Close SHALL mark all known records for its exact repository/topic done only after
successful git close, while retaining existing dirty/archive safeguards. A registry
policy refusal after successful Git close SHALL warn without changing the successful
exit status; an actual completion-marker write failure SHALL remain nonzero.
#### Scenario: Close refused
- **WHEN** a dirty worktree or failed archive step prevents close
- **THEN** no record is marked done and recoverable git state is preserved.
#### Scenario: Closed topic with multiple dispatches
- **WHEN** git close completes for a topic with multiple recorded sessions
- **THEN** every matching record becomes done, other repositories/topics stay unchanged, and promotion was never conditioned on registry data.
#### Scenario: No registry
- **WHEN** a git-only lane closes with no metadata store
- **THEN** close succeeds without creating a store or requiring Herdr.
#### Scenario: Metadata policy or write failure after close
- **WHEN** Git close succeeds and the configured registry is external, unignored, or tracked
- **THEN** close warns and exits zero without writing markers, while an actual marker write failure exits nonzero and reports that the lane is already closed.
