## Purpose

Extend the delivered configuration contract with an explicit lowest-precedence
built-in layer, preserving selected-file boundaries and inspectable source semantics.

## MODIFIED Requirements

### Requirement: Bounded two-file configuration
The CLI SHALL load built-ins below the nearest eligible parent .lane.json and then
canonical repository .lane.json. LANE_CONFIG SHALL replace those two discovered
operator files with exactly one selected file while retaining built-ins beneath it.
It SHALL preserve the delivered search boundaries and shallow/whole-route merge rules.
#### Scenario: Nearest parent and home boundary
- **WHEN** parent, grandparent, home, and repository files define settings
- **THEN** only the nearest eligible parent and repository operator files contribute above built-ins; home and higher files do not, and the built-in data directory is never an eligible parent root.
#### Scenario: Replacing arrays and routes
- **WHEN** both operator layers define prepare, dispatch, and an engineer route while the parent alone defines reviewer
- **THEN** repository prepare/dispatch/engineer replace their parent values, reviewer and unrelated built-in routes remain, and no cross-file array concatenation occurs.
#### Scenario: Explicit file and linked checkout
- **WHEN** a command runs in a linked worktree
- **THEN** it resolves the same canonical operational config as main; an explicit LANE_CONFIG bypasses both discovered operator layers but inherits built-in keys/routes it omits.
#### Scenario: Invalid selected file
- **WHEN** a selected config is unreadable, malformed, or has invalid known-key types
- **THEN** the command exits nonzero naming the file before any git/Herdr mutation or validation command; built-ins never mask the selected-file error.

### Requirement: Explain resolved configuration
lane config SHALL exit zero and print deterministic `key<TAB>value<TAB>source` rows,
including defaults and the fully resolved worktree directory. Values SHALL be JSON
encoded on one line, with routes expanded per route name. Sources SHALL be env,
default, built-in, or the defining file path; built-in contributions SHALL use
built-in and derived parent defaults SHALL identify the parent file. The CLI usage
text and README command table SHALL both list lane config with its purpose and
matching syntax. Existing key escaping and path/source meanings SHALL be preserved.
#### Scenario: Explain without running commands
- **WHEN** config includes a prepare or validate command and overridden routes
- **THEN** lane config reports final values and their actual winning sources, including built-in for retained shipped routes, without executing commands or calling Herdr.
#### Scenario: Command discoverability
- **WHEN** an operator reads the CLI usage text or README command table
- **THEN** both list lane config and describe its resolved-configuration output.
