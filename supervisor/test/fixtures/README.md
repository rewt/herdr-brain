ANSI footer fixtures captured read-only from Herdr on 2026-10-02:

- Claude empty footer: the existing `supervisor-herdr` pane, `pane read --lines 14 --format ansi`.
- Codex placeholder footer: this lane's own pane, the same command.

Only the composer/footer is retained, with cwd/task labels shortened. Typed and
placeholder variants substitute input into those captured styles; no input was
sent to a live pane to create a fixture. Codex empty removes its dim placeholder.
The tests also cover compound SGR resets and multiline/wrapped typing.

Codex multiline variants retain the captured shaded box, inserting draft rows
that end with a bare `›` or another prompt-like row. Truncated and unshaded
variants remove verified chrome and must fail closed. These are offline edits of
the captured ANSI layout, not additional live input experiments.

Codex 0.163 plain-text fixtures come from the ENG-362 live-check transcript:
`/Users/rewt/development/rewt/.org/evidence/HOOK-PULL-LIVE-CHECK-20261016/codex/transcript.txt`
(SHA-256 `e966dfe9541272a1101dfb4ee4a908efa883712fb49701be081da03846cadec3`).
`codex-0.163-empty-warning.txt` is lines 64–69, and `codex-0.163-draft.txt`
is lines 49–54. `codex-0.163-empty.txt` removes the warning suffix offline;
it is a derived variant, not a separate capture. The transcript contains no ANSI
escapes and records only the final empty footer, not the drafted footer. These
fixtures must fail closed: plain placeholder text is indistinguishable from an
identical typed draft. The live-check `nudge.mjs` omitted `--format ansi`.

The composer tests also pair the captured footer text with the older verified
ANSI box to isolate warning/status suffix handling. That combination is synthetic
and does not establish the actual Codex 0.163 ANSI layout. A real ANSI capture is
needed before claiming or implementing a layout-specific parser fix.
