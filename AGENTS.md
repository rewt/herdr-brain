# herdr-org agent instructions

- `bin/org.mjs` is the CLI. `lib/store.mjs` owns the event log and lock, `lib/state.mjs` the fold and
  derived status, `lib/report.mjs` report parsing, `lib/render.mjs` every view and brief. No dependencies.
- `console/` may depend on Ink, React and a markdown renderer. The core stays dependency-free. The console
  writes only through the `org` CLI (child process, argument arrays) and never appends to `events.jsonl`
  itself.
- `brain/` may call a model and run as a background service; it has no dependencies, keeps its own state,
  and never writes `events.jsonl`. `supervisor/` holds the tracked settle prompt and the scripts that run it.
- Run `npm test` before and after a change. Tests are offline and never call a model.

Contract:

- Durability replaces conversational context; it must not add bureaucracy. Reasoning costs tokens;
  coordination should not.
- The core never calls a model, never runs in the background, and never branches on harness,
  provider or model. Those are opaque run metadata.
- Budgets are advisory: surface them, never refuse work because of them. Refuse only what would make
  the record inconsistent (unknown ids, cycles, a second different report for one run).
- Status is derived from events. Do not add stored status.
- Older folds must ignore event types they do not know.
