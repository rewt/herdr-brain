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
#### Scenario: Same-named evidence and plain coverage
- **WHEN** repositories share a topic and report name but only one has Git or report evidence
- **THEN** the other cannot display that evidence, and the plain view names inspected endpoints and disambiguated repositories as well as machine/history scope.
#### Scenario: Outside git or offline
- **WHEN** the board starts outside git
- **THEN** machine discovery still works; with no server it shows an explicit unavailable state and --repo can still supply offline repository observations.

### Requirement: Every discovered agent remains visible
The board SHALL union registry entries and snapshot agents without requiring
registration, a name, a git repository, or a lane branch.
#### Scenario: Facilitator, unnamed agent, and foreign metadata
- **WHEN** snapshots contain a main-checkout facilitator, an unnamed lane agent, a non-git agent, and a mismatched registry entry
- **THEN** all live agents remain visible, known repo identity is correct, unknown fields stay unknown, and no foreign checkout is used for gate/dirty state.
#### Scenario: Cwd drift and ambiguous registry claims
- **WHEN** a live agent leaves Git or moves checkout, or multiple registry records claim the same pane occupant
- **THEN** provenance comes only from the actual verified cwd, ambiguous records do not claim the occupant, and every unmatched live agent remains visible as unregistered.
#### Scenario: Branch drift and replacement occupant
- **WHEN** a recorded lane's live checkout switches branch or detaches, or a new agent reuses its name, pane, and workspace
- **THEN** the recorded session stays separate from that live occupant, whose repository and branch come from verified Git; an immutable recorded agent-session identity is required for a live join, and older records without it remain displayable history.
#### Scenario: Verified claim baseline and terminal replacement
- **WHEN** a record and live occupant agree on the verified lane checkout, unique workspace, agent-session identity, and recorded terminal identity
- **THEN** the record joins that occupant; missing, stale, or duplicate claims do not, and a new terminal reporting the same agent-session value cannot inherit the old occupant's preview or tripwire.
#### Scenario: Title-only unregistered goal
- **WHEN** an unregistered agent has only a terminal title as goal evidence
- **THEN** the goal is labeled as terminal-title and its brief path and excerpt remain null.
#### Scenario: Untitled unregistered goal
- **WHEN** an unregistered agent has no terminal title or other goal evidence
- **THEN** its goal and goal source remain null rather than implying a registry goal.
#### Scenario: Foreground observation continuity and cancellation
- **WHEN** a matching pane read fails after a successful watch preview, a configured tripwire matches inside a longer line, or the watch is interrupted during endpoint collection
- **THEN** the matching prior preview is stale rather than erased, the configured substring survives same-occupant refreshes, and active requests close without probing later endpoints.
#### Scenario: Match during concurrent pane reads
- **WHEN** a first pane finishes reading, a second pane remains pending, and the first pane then reports a configured tripwire match
- **THEN** the completed collection retains the latest same-occupant tripwire and match observation time, without transferring them to a replacement occupant or triggering a lifecycle action.
#### Scenario: Status-only observation event
- **WHEN** a watched pane changes status without an output-change event
- **THEN** the status frame is emitted and a coalesced message-preview read is scheduled without a lifecycle action; if that request becomes due during another collection, one pending read drains after it without overlap.

### Requirement: History filtering is independent of agent status
The board SHALL hide completed registry history by default, support --all, and
distinguish metadata done from Herdr done.
#### Scenario: Unseen background result
- **WHEN** Herdr calls a live session done but its registry record is not done
- **THEN** the row stays visible.
#### Scenario: Closed and resumed sessions
- **WHEN** a metadata-done session is offline/idle
- **THEN** it is hidden unless --all is set; if it becomes working/blocked/unknown it is visible with an active-after-done marker.
