## Purpose

Provide usable overridable role routes and generic template resolution without a
repository config file, while keeping source precedence and review rules explicit.

## ADDED Requirements

### Requirement: Portable built-in role configuration
The tool SHALL ship the design's exact eight role profiles/use notes and an
engineer-equivalent dispatch profile as its lowest-precedence configuration layer.
#### Scenario: No repository configuration
- **WHEN** no parent, repository or explicit config file is selected
- **THEN** lane routes lists the eight profiles in order, unqualified dispatch equals the shipped engineer profile, and review defaults to the shipped review profile without generating a config file.
#### Scenario: Exact model and effort delivery
- **WHEN** each shipped role is explicitly dispatched through fake Herdr
- **THEN** its kind/model/effort argument array matches the design; default-effort review receives no Codex effort flag, and unavailable choices trigger no route/model substitution.

### Requirement: Existing layers override built-ins transparently
Parent/repository files SHALL override built-ins by the existing shallow-field and
whole-route-by-name rules, with existing environment/CLI precedence preserved.
#### Scenario: Parent and repository override one route
- **WHEN** parent replaces review and repository replaces it again
- **THEN** repository wins the complete review route, unrelated built-in routes remain and no replaced argument array is concatenated.
#### Scenario: Explicit config and root placement
- **WHEN** LANE_CONFIG selects a file or only an empty parent config exists
- **THEN** built-ins remain lowest, explicit config bypasses other files, and only roots-config's eligible parent semantics can activate sibling .worktrees placement.
#### Scenario: Partial explicit route inventory
- **WHEN** LANE_CONFIG declares only one overridden route
- **THEN** undeclared built-in routes remain; complete overrides are needed for every shipped definition to replace them all, and a smaller exact route set cannot be requested through name-wise merging.
#### Scenario: Source inspection
- **WHEN** lane config resolves built-in and overridden values
- **THEN** built-in values use the exact source built-in, overridden values name their defining sources, and no Herdr/mutation occurs.

### Requirement: Repository or installed generic templates
The tool SHALL resolve each conventional brief/review template from the target
worktree when present, otherwise from its real installation, without a config file.
#### Scenario: Symlinked tool and unrelated cwd
- **WHEN** a copied/symlinked installation serves a repository with no templates
- **THEN** both packaged templates resolve from that installation rather than cwd, a personal path or an inherited root.
#### Scenario: Repository template and invalid override
- **WHEN** a target supplies a template
- **THEN** it overrides that one packaged template; unreadable, malformed or escaping overrides refuse and cannot remove the review protocol or change reviewer write authority.
#### Scenario: Template source inspection
- **WHEN** lane config reports the resolved templates
- **THEN** template.brief/template.review are inspection-only rows with built-in or repository-file sources and cause no rendering, dispatch or mutation.

### Requirement: Explicitly approved defaults boundary
Default-config SHALL require approved A5, remain agent-agnostic and introduce no
personal/organization-specific settings, automatic escalation, retries or installs.
#### Scenario: Override and compatibility documentation
- **WHEN** this change ships
- **THEN** .lane.json.example demonstrates complete overrides, README/REFERENCE/usage explain optional configuration, changed dispatch/routes defaults and client limits, and all behavior tests run offline using built-ins only.
