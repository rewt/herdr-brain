## Purpose

Create a reviewable local brief from an idea and dispatch it into an explicitly
selected repository lane using the existing lifecycle and safety checks.

## ADDED Requirements

### Requirement: Explicit repository and route
lane new SHALL require a valid topic, repository, configured route, and nonempty
task, resolving them before any brief/worktree/agent mutation.
#### Scenario: Task from outside git
- **WHEN** a caller outside any checkout supplies a valid --repo and --route
- **THEN** the lane belongs to that canonical repository and uses its resolved root configuration and parent workspace.
#### Scenario: Invalid input
- **WHEN** the topic/route/repo/task, ignored storage, or parent workspace is invalid
- **THEN** new exits nonzero without writing a brief, opening a lane, or starting an agent.
#### Scenario: Identity root is not a destination
- **WHEN** a caller at an identity root supplies that root as --repo or has no explicit repository destination
- **THEN** new refuses with guidance to select an existing canonical repository; it does not choose an implicit root default, create a scratch repository, run git init, or start a facilitator.

### Requirement: Ignored template brief and literal task text
The command SHALL create one ignored `.lane/briefs/<topic>.md` from the installed
template, preserving the full task as data and including the required lane rules.
#### Scenario: Multiline hostile-looking task
- **WHEN** task input contains quotes, backticks, shell substitutions, or Unicode
- **THEN** those bytes appear in the brief and prompt without executing any of them.
#### Scenario: Duplicate topic or brief
- **WHEN** the branch, destination, or generated brief already exists
- **THEN** new refuses without overwriting or adopting it.

### Requirement: Single foreground lifecycle
After brief creation/editing, new SHALL call open then dispatch once and return the
actual lane/agent identity or honest partial failure. It SHALL not promote or push.
#### Scenario: Full success
- **WHEN** open, cwd verification, prompt delivery, and registry write all succeed
- **THEN** one branch, one worktree, one child workspace, one prompted agent, and one registry record exist.
#### Scenario: Structured result identity
- **WHEN** new succeeds or reaches a recoverable partial outcome
- **THEN** its machine-readable result identifies the canonical repository, known destination, lane/worktree, agent/session or registered row, brief path, and delivery/registration stage without requiring a UI to guess by topic.
#### Scenario: Failure after open or prompt
- **WHEN** startup, cwd verification, prompt delivery, or registration fails
- **THEN** recoverable work remains, the output distinguishes known/ambiguous delivery, and no lifecycle action is automatically retried.

### Requirement: Editor handoff
--edit SHALL use the documented editor precedence and terminal handoff, then
validate the edited file before opening the lane.
#### Scenario: Editor cancel
- **WHEN** the editor exits nonzero or leaves an empty brief
- **THEN** no lane or agent is created and the ignored draft remains available.

### Requirement: Route picker data
lane routes --repo `<path>` --json SHALL expose sorted resolved routes and use notes
without starting work or exposing configured environment values.
#### Scenario: Root routes overridden by repository
- **WHEN** the picker queries a repo that overrides an inherited engineer route
- **THEN** the JSON matches dispatch's resolution and displays that route's effective use note.
#### Scenario: Route effort projection
- **WHEN** a resolved route has an explicit recognized effort argument, an omitted known default, or an unsupported effort setting
- **THEN** JSON exposes the documented resolved effort projection, agent default, or unknown state without inferring it from the route name or exposing environment values.
