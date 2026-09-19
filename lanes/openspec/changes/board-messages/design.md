# Design: Show the last substantive agent message

## Evidence and extraction

Depend only on board-cli (2b-i), which supplies the read schema and service boundary.
The parser works on existing registered rows; machine discovery and UI/action
rewiring are independent. Preserve the same adapter when discovery adds more rows.

Protocol 20 exposes agent/pane reads as rendered text plus revision/truncated flags;
it does not expose a structured last-assistant-message field. Do not invent one,
read vendor-private transcript files, or depend on agent SDKs. Ask Herdr for
recent-unwrapped text, up to 200 lines / 16 KiB per selected preview. Prefer a future
structured message only after explicitly verifying the installed schema, with the
same contract tests.

Implement small, documented kind-specific text adapters for Codex and Claude.
Strip ANSI/control sequences, prompts, input echo, status/footer/context/token bars,
approval chrome, and tool output only when recognized by fixtures. Extract the
last confidently bounded assistant block, not the last nonempty line. Preserve
multiline content in detail, summarize first substantive line in the list.
Unknown formats show "message unavailable" and a separate labeled raw pane excerpt;
do not promote a guessed footer or shell command into an assistant answer.
This is best-effort visible text, not a complete transcript guarantee.

Read the selected row immediately and update following state/output changes,
coalesced to at most one read per pane per second. Other rows get bounded reads on
the existing five-second tick without exceeding the board's sampling budget.
Use revision/occupant IDs to ignore late output for replaced agents and cache only
in memory. --once/--json may read once when online and use the same adapters;
tripwire history remains live-only. Offline does not trigger a new connection loop.

Store message text, source ("assistant-preview" or "unavailable"), kind, observed_at,
revision and truncated flag in the CLI result. On error retain the old text only
with a stale marker. No output is written to tracked reports automatically.

## Acceptance limitations

Use public-safe synthetic but realistically shaped Codex/Claude fixtures covering
wrapping, Unicode, multiline answers, tool blocks, spinners, and footer-only screens.
A live read may improve fixtures only after sanitization. If the current agent's
alternate screen contains no answer, say unavailable; do not claim that requesting
more scrollback will recover missing alternate-screen history.
