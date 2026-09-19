## Purpose

Let operators inspect session intent and evidence in a responsive full-pane terminal
view and reach the selected Herdr session with one keyboard action.

## ADDED Requirements

### Requirement: Fullscreen responsive board
The UI SHALL render header, grouped session list, detail panel, and status bar in
alternate screen with the design's responsive layout and display-width handling.
#### Scenario: Responsive cell budgets and stable filtering
- **WHEN** a selected session contains wide/combining characters and the terminal is 140x40, 100x24, 80x24, or 40x12, and the operator changes a filter
- **THEN** the 140x40 view reserves a 22-cell rail and one-line rows, the 100x24 view has one-line rows without the rail, the 80x24 view uses two-line rows with fixed scrolling evidence, selection remains bound to row identity through filtering where visible, and the 40x12 compact mode states its limitation.

### Requirement: Complete session details
The selected row SHALL expose goal, brief excerpt, gate, report/verdict, recent
message, git state, deadlines, and provenance without treating unknowns as success.
#### Scenario: Conflicting indicators
- **WHEN** a working session is overdue and has a stale or failed gate
- **THEN** all applicable text badges remain visible with distinct documented colors.
#### Scenario: Attention and no-color indicators
- **WHEN** blocked, failed/stale, overdue, unknown, historical, and missing-evidence rows coexist and NO_COLOR is set
- **THEN** attention counts unique qualifying sessions before attention/working filters within repository/history scope, historical and missing optional evidence do not alone alert, discovery errors remain independently visible, and text, `>` selection, and `!` attention remain understandable without ANSI color.
#### Scenario: Evidence scrolling and Escape return
- **WHEN** evidence exceeds the fixed pane and the operator enters Message, Evidence, or Context then presses Escape
- **THEN** the pane scrolls internally, Escape returns focus to the list, and no lifecycle action runs.

### Requirement: One-action keyboard focus
Enter SHALL focus the selected verified Herdr session through the CLI; all listed
keys SHALL work without mouse input, and errors SHALL remain inside the board.
#### Scenario: All listed keys, focus, and history toggle
- **WHEN** the user uses arrows/j/k, Home/End, page keys, Tab, 1/2/3, /, !, w, h, 0, [, ], r, v, ?, Escape, d, a, Enter, and q in their documented focus owners
- **THEN** each key performs only its listed navigation, filter, evidence, observation, help, done, focus, or quit behavior; Enter focuses the intended verified live tab once, completed rows toggle predictably, Escape returns rather than quits, and observation alone never changes focus.

### Requirement: Terminal and dependency isolation
Exiting the UI SHALL restore terminal state and stop all observer resources. Plain
and JSON commands and npm test SHALL remain usable without UI dependencies.
#### Scenario: Exit during refresh
- **WHEN** q, Ctrl-C, SIGTERM, or a render error occurs during a pending refresh
- **THEN** the previous screen, cursor and terminal input mode are restored and no child or reconnect timer remains.
#### Scenario: No color
- **WHEN** NO_COLOR is set
- **THEN** state remains understandable from text with no color-dependent information.
