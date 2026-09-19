## Purpose

Keep machine-wide board observation responsive, bounded, and honest as repositories
and agent sessions change.

## ADDED Requirements

### Requirement: Responsive bounded observation
Observation SHALL avoid blocking the UI, duplicate per-session git sampling,
unbounded refresh overlap, and persistent history state.
#### Scenario: Delayed git and changing selection
- **WHEN** a git request is delayed in a 100-session/10-repository fixture
- **THEN** input handling remains responsive, at most two samples run concurrently, refreshes do not overlap, and selection remains bound to the same row ID.
