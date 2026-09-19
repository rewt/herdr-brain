## Purpose

Show all agents visible through accessible local Herdr servers in one grouped view,
including sessions that were never registered by lane dispatch.

## ADDED Requirements

### Requirement: Machine default with repository filter
The board SHALL default to machine scope, support --repo as a canonical-repository
filter, and state which local servers/repositories were actually inspected.
#### Scenario: Multiple local servers and duplicate names
- **WHEN** two accessible local Herdr servers expose same-named agents and repositories under different roots
- **THEN** all sessions appear with distinct identities, --repo selects only its repository, and no remote server is contacted.
#### Scenario: Inaccessible server
- **WHEN** one discovered local endpoint fails while another works
- **THEN** working rows remain visible, coverage is partial, and inaccessible data is not represented as current.
#### Scenario: Per-repository override isolation
- **WHEN** the anchor repository uses LANE_CONFIG and discovery also finds another root
- **THEN** that override affects only the anchor; the other repository uses its own config and registry.
#### Scenario: Duplicate display labels retain identity
- **WHEN** two discovered repositories have the same readable root/repository labels
- **THEN** their canonical identities remain distinct and the read model provides a stable public-safe display suffix for picker disambiguation without treating labels as repository identity.
#### Scenario: Outside git or offline
- **WHEN** the board starts outside git
- **THEN** machine discovery still works; with no server it shows an explicit unavailable state and --repo can still supply offline repository observations.

### Requirement: Every discovered agent remains visible
The board SHALL union registry entries and snapshot agents without requiring
registration, a name, a git repository, or a lane branch.
#### Scenario: Facilitator, unnamed agent, and foreign metadata
- **WHEN** snapshots contain a main-checkout facilitator, an unnamed lane agent, a non-git agent, and a mismatched registry entry
- **THEN** all live agents remain visible, known repo identity is correct, unknown fields stay unknown, and no foreign checkout is used for gate/dirty state.

### Requirement: History filtering is independent of agent status
The board SHALL hide completed registry history by default, support --all, and
distinguish metadata done from Herdr done.
#### Scenario: Unseen background result
- **WHEN** Herdr calls a live session done but its registry record is not done
- **THEN** the row stays visible.
#### Scenario: Closed and resumed sessions
- **WHEN** a metadata-done session is offline/idle
- **THEN** it is hidden unless --all is set; if it becomes working/blocked/unknown it is visible with an active-after-done marker.

### Requirement: Responsive bounded observation
Observation SHALL avoid blocking the UI, duplicate per-session git sampling,
unbounded refresh overlap, and persistent history state.
#### Scenario: Delayed git and changing selection
- **WHEN** a git request is delayed in a 100-session/10-repository fixture
- **THEN** input handling remains responsive, at most two samples run concurrently, refreshes do not overlap, and selection remains bound to the same row ID.
