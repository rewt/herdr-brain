## Purpose

Provide dependency-free board read interfaces that scripts and a later UI rewire
can consume without coupling delivery to session actions.

## ADDED Requirements

### Requirement: Scriptable board observations
The CLI SHALL provide plain, JSON, and foreground JSON-watch output with the
documented v1 schema and correct unknown/error states.
#### Scenario: UI dependencies absent
- **WHEN** board/node_modules is absent and plain or JSON output is requested
- **THEN** observations work using built-ins only, with no install or build.
#### Scenario: Stream framing and errors
- **WHEN** observations change while a JSON watch is running
- **THEN** each stdout line is a complete snapshot, diagnostics do not corrupt JSON, and contradictory flags fail clearly.
#### Scenario: Complete gate evidence when available
- **WHEN** a recorded gate has command, observation time, or duration metadata
- **THEN** JSON exposes each as nullable read-only gate evidence alongside state, head, exit code, and signal; unavailable values remain explicit rather than inferred by a consumer.

### Requirement: Compatible read-service boundary
The new read commands SHALL be owned by lane.mjs and SHALL preserve the service
exports used by the unchanged interactive UI. Observations SHALL not focus agents
or write session metadata.
#### Scenario: Read-only scripting alongside the existing UI
- **WHEN** a script requests a repository snapshot while the existing table is in use
- **THEN** the snapshot uses the canonical repository config, changes no session metadata or focus, and the UI retains its existing service behavior.

### Requirement: Permanent observer teardown
Observer termination SHALL close all pending resources and preserve the permanent
shutdown behavior established by the previous board reviews.
#### Scenario: Watch exits during pending snapshot or reconnect
- **WHEN** a watch is interrupted or its output consumer closes before a snapshot settles
- **THEN** no later response resubscribes, no timer/process remains alive, and no lifecycle action is replayed.
