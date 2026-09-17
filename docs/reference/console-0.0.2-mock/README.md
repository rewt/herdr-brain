# Console 0.0.2 mock (source copies)

Copied 2026-09-16 from the operator-approved mock,
https://claude.ai/artifact/9iRpzGHg5qXiYtW4JGFD7m, so lane workers can read it
from their worktree. These are design-canvas source files, not runnable
console code: read the markup and each file's `renderVals()` sample data for
layout, columns, colours and wording.

- `Main.dc.html`: main screen at 140 × 40 (Enter or a click goes to the session).
- `Details.dc.html`: the summary popup (`s`).
- `Menu.dc.html`: the right-click row menu.
- `Launch.dc.html`: a typed task with Review launch open.
- `Narrow.dc.html`: 80 columns.

The powerline arrows are drawn with CSS shapes here; in the terminal they are
Nerd Font glyphs. The spec, `docs/spec-brain-console-0.0.2.md`, is the source of truth
together with this mock; where they disagree, ask.
