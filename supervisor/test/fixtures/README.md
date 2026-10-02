ANSI footer fixtures captured read-only from Herdr on 2026-10-02:

- Claude empty footer: the existing `supervisor-herdr` pane, `pane read --lines 14 --format ansi`.
- Codex placeholder footer: this lane's own pane, the same command.

Only the composer/footer is retained, with cwd/task labels shortened. Typed and
placeholder variants substitute input into those captured styles; no input was
sent to a live pane to create a fixture. Codex empty removes its dim placeholder.
The tests also cover compound SGR resets and multiline/wrapped typing.
