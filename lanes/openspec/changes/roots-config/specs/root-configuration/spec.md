## Purpose

Resolve reusable development-root settings consistently while preserving explicit
overrides and the git worktree locations of already-open lanes.

## ADDED Requirements

### Requirement: Bounded two-file configuration
The CLI SHALL load the nearest eligible parent .lane.json, then canonical repository
.lane.json, unless LANE_CONFIG selects exactly one file. It SHALL apply the merge
and search-boundary rules in this change's design.
#### Scenario: Nearest parent and home boundary
- **WHEN** parent, grandparent, home, and repository files define settings
- **THEN** only the nearest eligible parent and repository files contribute; home and higher files do not.
#### Scenario: Replacing arrays and routes
- **WHEN** both layers define prepare, dispatch, and an engineer route while the parent alone defines reviewer
- **THEN** repository prepare/dispatch/engineer replace their parent values, reviewer remains, and no cross-file array concatenation occurs.
#### Scenario: Explicit file and linked checkout
- **WHEN** a command runs in a linked worktree
- **THEN** it resolves the same canonical operational config as main; an explicit LANE_CONFIG bypasses both discovered layers.
#### Scenario: Invalid selected file
- **WHEN** a selected config is unreadable, malformed, or has invalid known-key types
- **THEN** the command exits nonzero naming the file before any git/Herdr mutation or validation command.

### Requirement: Worktree-base precedence
New lanes SHALL use the design's path matrix in this priority order: environment,
repository key, parent key, parent-directory default, legacy default.
#### Scenario: Relative keys in different files
- **WHEN** repository and parent files independently specify relative worktree_root values
- **THEN** each resolves against its defining file directory before precedence is applied.
#### Scenario: Legacy environment override
- **WHEN** LANE_WORKTREE_ROOT names an explicit directory and both files define worktree_root
- **THEN** the lane is directly below that environment directory, with no added repository segment.
#### Scenario: Root default and legacy default
- **WHEN** a parent file is present without worktree_root
- **THEN** a new lane uses its `.worktrees/<repo-name>/lane-<topic>`; with no parent file it retains the legacy location.

### Requirement: Explain resolved configuration
lane config SHALL exit zero and print deterministic `key<TAB>value<TAB>source` rows,
including defaults and the fully resolved worktree directory. Values SHALL be JSON
encoded on one line, with routes expanded per route name. Sources SHALL be env,
default, or the defining file path; derived defaults SHALL identify the parent file.
The CLI usage text and README command table SHALL both list `lane config` with
its purpose and matching syntax.
#### Scenario: Explain without running commands
- **WHEN** config includes a prepare or validate command and overridden routes
- **THEN** lane config reports final values and their sources without executing those commands or calling Herdr.
#### Scenario: Command discoverability
- **WHEN** an operator reads the CLI usage text or README command table
- **THEN** both list `lane config` and describe its resolved-configuration output.

### Requirement: Preserve foreign paths and existing work
lane open SHALL refuse any occupied destination without adoption, overwrite, or
deletion, naming the path; known lanes SHALL remain located through git worktree list.
#### Scenario: Occupied destination
- **WHEN** the destination is an ordinary directory or another repository's worktree
- **THEN** open exits nonzero without creating its branch or altering that directory.
#### Scenario: Existing legacy lane
- **WHEN** worktree_root changes after a lane was opened
- **THEN** status, dispatch, check, promote, and close still use the registered lane path; no automatic migration occurs.
