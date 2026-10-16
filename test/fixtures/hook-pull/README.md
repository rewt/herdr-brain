# Captured hook-pull screens

`codex-*.ansi` are unmodified captures from ENG-362's
`.org/evidence/HOOK-PULL-LIVE-CHECK-20261016/codex-ansi/`: `draft.ansi`,
`draft-placeholder-text.ansi`, and `empty-after-turn.ansi` respectively.
They preserve the styling which distinguishes a placeholder from typed text.

The Claude live-check evidence contains a plain transcript, **no ANSI capture**.
The tests therefore use the repository's real Claude ANSI fixtures in
`supervisor/test/fixtures/claude-{empty,typed}.ansi`. No ANSI escape sequences
were invented for the live-check transcript.
