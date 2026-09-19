## Purpose

Keep each lane attached to its owning repository and development root, independent
of duplicate basenames, workspace labels, and the caller's linked checkout.

## ADDED Requirements

### Requirement: Canonical repository identity
Lane operations SHALL use canonical git common-directory identity and verify a
worktree belongs to that identity before using it as a lane.
#### Scenario: Same repository name in two roots
- **WHEN** both roots open the same topic using their root-local defaults
- **THEN** each gets its own `.worktrees/<repo>/lane-<topic>` and lane branch without sharing git state.
#### Scenario: Shared base collision
- **WHEN** two different repositories deliberately resolve to the same occupied lane destination
- **THEN** the second operation refuses and neither repository's existing work changes.

### Requirement: Safe sibling creation
New lane creation SHALL refuse unsafe realpath destinations and SHALL never choose
an automatic temporary-directory fallback.
#### Scenario: Symlink or descendant escape
- **WHEN** a destination resolves into a repository checkout or outside the selected worktree base through a symlink
- **THEN** open names the unsafe path and exits before branch creation or a Herdr mutation.
#### Scenario: Legacy registered lane
- **WHEN** an existing lane's verified git worktree is outside the new default base
- **THEN** lifecycle operations still find it without moving or adopting another checkout.

### Requirement: Canonical parent and unambiguous labels
New lane Herdr workspaces SHALL be children of their canonical repository workspace
and use the design's root/repository/topic labels. Controls SHALL resolve by IDs and
verified paths. Agent names SHALL meet Herdr length and uniqueness rules.
New workspace labels SHALL be at most 64 Unicode code points, preserve whole
graphemes, and disambiguate truncated labels using the design's identity suffix.
#### Scenario: Open invoked from another lane
- **WHEN** a lane command is invoked inside a linked checkout
- **THEN** the new child is opened under the canonical repository workspace, not beneath the caller's lane.
#### Scenario: Matching display text or stale metadata
- **WHEN** a workspace label matches but its checkout identity does not
- **THEN** the CLI refuses to use it for dispatch or close.
#### Scenario: Long labels with common prefixes
- **WHEN** long Unicode root/repository/topic names produce the same truncated fragments
- **THEN** labels stay within the bound with whole graphemes and distinct identity suffixes, while full identities remain available in CLI details.
#### Scenario: Root identity remains git-owned
- **WHEN** lanes open and dispatch in repositories with different git identities
- **THEN** existing git config and environment determine author identity, and lane writes no identity setting.
