## Purpose

Provide verified session actions and make the existing board UI a client of the
lane CLI without duplicating git, Herdr, or registry control.

## ADDED Requirements

### Requirement: UI calls the CLI
The interactive UI SHALL acquire observations and invoke actions solely through
lane CLI processes while preserving the existing table layout and navigation.
#### Scenario: Existing table interaction
- **WHEN** a user selects a row, focuses it, marks it done, refreshes, and quits
- **THEN** those operations use CLI observations/actions and no direct UI git/socket/target-file/registry control path remains.

### Requirement: Verified explicit focus
A CLI focus action SHALL verify the current live session and call herdr agent focus
with its explicit target, never change focus during observation, and never retry.
#### Scenario: Agent exits before focus
- **WHEN** the selected agent disappears or the pane now hosts a different agent
- **THEN** focus fails with a readable stale-selection message and does not target the replacement.
#### Scenario: Unnamed live agent
- **WHEN** a valid live row has no agent name
- **THEN** focus uses its verified pane ID and works without renaming the agent.

### Requirement: Verified completion action
The done action SHALL verify its registered session and canonical metadata target
before writing a display-only completion marker.
#### Scenario: Unregistered or foreign target
- **WHEN** a row has no registry record or its ID resolves to a foreign metadata path
- **THEN** done exits nonzero with a readable error and writes no marker.
#### Scenario: Successful completion mark
- **WHEN** a valid registered row is marked done
- **THEN** only its completion marker changes and git/gate/lifecycle state is unaffected.

### Requirement: UI observer teardown
Exiting the UI SHALL stop its observation child and pending resources permanently.
#### Scenario: Quit during a pending frame or reconnect
- **WHEN** the UI exits before an outstanding observation settles
- **THEN** no late frame restarts the observer and no action is replayed.
