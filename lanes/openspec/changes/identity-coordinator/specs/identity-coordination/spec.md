## Purpose

Define a manual, evidence-driven coordination contract across explicitly selected
canonical repositories without changing lane lifecycle authority.

## ADDED Requirements

### Requirement: Explicit roster and single integration owner
Each coordinated project SHALL identify its canonical Git common directory, current
instruction/goal source, and exactly one integration owner. The coordinator SHALL
own daily outcome priority, cross-project dependencies, and budgets; a designated
project supervisor, when present, SHALL be the integration owner for detailed
evidence and acceptance. Otherwise the coordinator MAY directly own a small project
and assign its engineer without duplicating independent review.
#### Scenario: Root containing two repositories
- **WHEN** a development root groups two repositories with the same basename
- **THEN** separate canonical identities, outcomes, owners, and budgets are recorded, and lifecycle work requires one explicit repository.
#### Scenario: Optional supervisor
- **WHEN** a project expands to multiple lanes and appoints a supervisor
- **THEN** one acknowledged owner revision transfers integration acceptance to that supervisor; the coordinator keeps priorities/budget decisions but does not perform a second detailed review.

### Requirement: Compact assignment and delta report
An assignment SHALL retain one stable ID, project, outcome, owner, integration owner,
acceptance criteria, finite budget, milestone, blocker/decision, evidence, and next
action. Reports SHALL name assignment revision, unique report ID/sequence, changed
milestone/result, blocker or decision, evidence, and one next action, without copying
project context or private transcripts.
#### Scenario: Material checkpoint
- **WHEN** an engineer reaches a milestone
- **THEN** durable evidence is preserved before one concise no-wait report, and the integration owner verifies its branch, HEAD, gate, and review applicability from primary sources.
#### Scenario: Reported result awaits acceptance
- **WHEN** an assignment plans a milestone or an engineer reports it complete
- **THEN** neither is counted as accepted until the single integration owner checks project criteria and required gate/review evidence.
#### Scenario: Delivery fails or reports reorder
- **WHEN** delivery is refused, duplicated, conflicting, or out of order
- **THEN** evidence remains available, exact duplicates cause no action, conflicts/gaps are held for clarification, older reports do not roll back state, and no prompt or lifecycle action is replayed.

### Requirement: Explicit authority transfer and evidence-based resumption
Assignment acknowledgement, reassignment, acceptance, and lane closeout SHALL use
the operator/project authority source and primary Git, gate, review, and live identity
evidence. Local metadata SHALL NOT grant authority, become a lease or queue, or
trigger scheduling, routine polling, heartbeat traffic, or lifecycle replay.
#### Scenario: Stale evidence with unchanged authorized owner
- **WHEN** a saved plan, HEAD, gate, review, or report pointer is obsolete but the same owner remains available and authorized at the current assignment revision
- **THEN** that owner reconciles primary evidence and continues only an unfinished authorized step without a successor, ownership revision, duplicate review, or lifecycle replay; a material scope or authority conflict still requires a decision.
#### Scenario: Unavailable or replaced owner
- **WHEN** the named owner is unavailable, replaced, or no longer authorized
- **THEN** new assignment to that target stops until a delegated coordinator or operator explicitly revises ownership, records supersession when the old owner cannot acknowledge, and receives one successor's acknowledgement and primary-evidence check.
#### Scenario: Separate identities
- **WHEN** Git author, GitHub credential, Codex profile, and development-root label differ
- **THEN** none is treated as the canonical repository, integration owner, or permission for a remote or lifecycle action.
