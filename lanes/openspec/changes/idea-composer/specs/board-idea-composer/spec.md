## Purpose

Let an operator choose a repository and route, describe work, and obtain a visible
registered lane from the board through the existing idea-dispatch command.

## ADDED Requirements

### Requirement: Repository and route composer
The UI SHALL provide task/topic inputs, root-qualified repository selection, route
selection with use notes, and an explicit submit action.
#### Scenario: Same-named repositories
- **WHEN** two discovered repositories share a basename
- **THEN** the operator can distinguish their roots, and changing selection loads only the chosen repository's routes.
#### Scenario: No route or empty task
- **WHEN** required fields are absent or invalid
- **THEN** submission is unavailable and no CLI mutation is invoked.
#### Scenario: Multiline task, explicit topic, and review
- **WHEN** the operator types Enter in task text, leaves a suggested topic unconfirmed, or has not opened the explicit review control
- **THEN** Enter inserts a newline, a visible nonempty valid topic is required, and no launch occurs before review.
#### Scenario: Same-named route invalidation and scope-independent draft
- **WHEN** the operator changes repository to one with a same-named route or changes board scope/filter while composing
- **THEN** Who is cleared and requires a fresh selection, while the draft destination and all draft text remain unchanged by scope/filter changes.
#### Scenario: Identity-root refusal
- **WHEN** startup is at an identity root rather than a verified caller repository
- **THEN** Where remains unselected, the root is disabled guidance rather than a destination, the draft remains editable, and launch refuses until an existing repository or CLI-validated explicit path is selected.

### Requirement: CLI-only single submission
The composer SHALL call lane new once with literal argument values and SHALL not
reimplement brief writing, lane creation, dispatch, or registration.
#### Scenario: Double submit and distinct partial failures
- **WHEN** submit is pressed twice before the command exits and the CLI reports refusal before mutation, retained draft, known unprompted lane, ambiguous delivery, or post-delivery registration failure
- **THEN** only one command runs, each outcome has distinct CLI-provided recovery information, and no retry occurs.
#### Scenario: Successful idea
- **WHEN** the CLI successfully creates and registers the session
- **THEN** the board refreshes/selects the row and Enter can focus its actual Herdr tab.
#### Scenario: Successful result under a filter
- **WHEN** a successful CLI result identifies a registered row that the active filter would hide
- **THEN** the board briefly reveals and selects that exact returned identity without stealing Herdr focus; until observation finds it, it shows a pending-observation result rather than guessing by topic.

### Requirement: Usable long-text and editor flow
The composer SHALL support long task input and an explicit edit-then-dispatch
handoff, restoring terminal/observation state afterward.
#### Scenario: Editor cancelled
- **WHEN** the external editor is cancelled or leaves empty text
- **THEN** the board returns with the CLI's preserved-draft information and no new lane/agent.
#### Scenario: Input focus owns keys
- **WHEN** a user types d, q, n, or Enter into a task control
- **THEN** the keystroke edits/submits that control only and does not mark sessions done, quit, or open another composer.
