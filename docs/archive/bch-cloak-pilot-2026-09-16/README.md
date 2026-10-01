# Archived bch-cloak pilot snapshot, 2026-09-16

Copies of the operator-side files the first pilot ran with. The live copies are in
`/Users/rewt/development/bastian/bch-cloak/.lane/supervisor/`, which git ignores, and
they may have changed since. Results: `docs/pilot-M1-results-2026-09-16.md`.

- `SETTLE.md`: the executive protocol each fresh settle or continue session follows
- `arm-watch.sh R-n`: start a visible watcher for one run (`contrib/settle-watch.mjs --spawn`)
- `continue.sh "focus"`: open a fresh executive session with no finished run

bch-cloak project state (`OPEN-STATE.md`) is deliberately not copied here: it belongs
to that project.
