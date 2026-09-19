## Purpose

Present useful agent response previews without confusing terminal footers, prompts,
or tool output with a substantive assistant message.

## ADDED Requirements

### Requirement: Conservative assistant-message preview
The board SHALL identify the last confidently bounded substantive message for
supported Codex and Claude rendered-output formats and label its provenance.
#### Scenario: Footer follows a real answer
- **WHEN** a Codex or Claude output fixture ends in context/token/shortcut chrome after an assistant response
- **THEN** the response appears in the detail panel and the footer never becomes LAST MESSAGE.
#### Scenario: Footer, tool output, or unknown format only
- **WHEN** no assistant block can be distinguished in the available text
- **THEN** the board says message unavailable and any raw excerpt is separately labeled as pane output.

### Requirement: Bounded current-occupant reads
Message reads SHALL respect line/byte/rate limits and never attach old output to a
new pane occupant. Previews SHALL expose truncation, observation time, and staleness.
#### Scenario: Agent replaced during read
- **WHEN** a response arrives after its pane occupant changes
- **THEN** the old text is discarded for the replacement session.
#### Scenario: Missing alternate-screen history
- **WHEN** Herdr returns truncated output that lacks the previous assistant answer
- **THEN** the preview describes the limitation without fabricating content or reading private agent files.

### Requirement: Live and one-shot parity
Online plain/JSON snapshots SHALL use the same message parser as the interactive
watch; tripwire history SHALL remain explicitly live-only.
#### Scenario: One-shot observation
- **WHEN** an online --once or --json request has a supported readable agent
- **THEN** it includes the same substantive preview and provenance available to the live board, without starting a persistent observer.
