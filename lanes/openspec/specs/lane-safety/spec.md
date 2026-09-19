# Lane safety

## Purpose

Record the existing git and validation guarantees that every proposed extension
must preserve, without elevating board display metadata into authority.

## Requirements

### Requirement: Isolated lane ownership
The CLI SHALL map one topic to one lane branch and git worktree in its repository.
#### Scenario: Duplicate topic
- **WHEN** a topic already has a lane branch
- **THEN** opening the same topic is refused without replacing its work.

### Requirement: Verified dispatch cwd
The CLI SHALL verify the agent cwd equals its lane worktree before sending a brief.
#### Scenario: Mismatched agent checkout
- **WHEN** Herdr reports an unexpected cwd for the newly started agent
- **THEN** dispatch refuses to send the brief and closes only its newly created tab.

### Requirement: Validated fast-forward promotion
Promotion SHALL require clean canonical and lane checkouts, a clean rebase, green
configured validation after preparation, and unchanged main before fast-forward.
It SHALL never push or create a merge commit.
#### Scenario: Main changes during validation
- **WHEN** validation succeeds but main has moved since the promotion check
- **THEN** promotion refuses the fast-forward and reports the concurrent change.

### Requirement: Recoverable close
The CLI SHALL refuse dirty lane removal and preserve unmerged commits through an
archive tag before deleting an unmerged branch.
#### Scenario: Closing unfinished work
- **WHEN** a clean lane is closed without having merged into main
- **THEN** its commits remain recoverable through its archive tag.

### Requirement: Commit-bound gate
A usable board gate SHALL compare the gate's full HEAD with the worktree's current
HEAD; dirty checks SHALL refuse before replacing the record.
#### Scenario: Commit after successful validation
- **WHEN** a new commit is created after a successful lane check
- **THEN** the old gate displays STALE until a new check measures the current commit.
