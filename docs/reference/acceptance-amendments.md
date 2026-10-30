# Revising an item's acceptance

Replace the complete active acceptance list with repeated values:

```sh
record amend-accept ENG-123 --accept 'First criterion' --accept 'Second criterion' --why 'Why this replaces the earlier acceptance'
```

For a rewritten prompt, pass a UTF-8 text file. Its complete contents, including
line breaks and trailing whitespace, become one acceptance entry:

```sh
record amend-accept ENG-123 --file /absolute/path/to/rewritten-prompt.md --why 'Apply the revised slice prompt'
```

Supply exactly one input form and nonempty text and reason. This uses the same
writer attribution, append-only transaction, promotion write guard and source
binding as `note` and `set`. Unlike a note or metadata change, it changes the
acceptance agents receive. Unlike `set`, it emits a dedicated
`item.acceptance-amended` event, with the replacement list and reason. It creates
no approval or dispatch stage. Reserved items cannot be amended: this includes
`meta.operator_reserved`, `meta.reserved`, human roles and reserved categories,
using the same predicate as proposal intake.

The replacement supersedes the entire previous acceptance list, irrespective
of author. Original operator words and every later revision remain fully visible
in `record show ID` under acceptance history, with author, timestamp, event number
and reason; `record show ID --json` exposes them in `accept_history`. No old event
or note is rewritten or truncated in that history. Identity, selection, holds,
dependencies, status and run facts do not change.

Closed items, including items closed as done, can also be amended unless they
are reserved. An amendment replaces their current folded `item.accept` without
reopening them or changing their recorded closure. Later consumers of that field,
including the acceptance fallback in a correction brief, see the amended text;
the original acceptance remains in history. Closure does not freeze acceptance.

Newly dispatched runs get the latest acceptance in their generated brief. Saved
briefs remain immutable: `record brief R-n` returns the saved bytes, even after an
amendment. If a missing brief is regenerated, it uses the current acceptance.
An amendment does not send new instructions to an already dispatched worker.

Older folds safely ignore the new event and retain the original acceptance;
they do not gain amendment semantics. Use an amendment-aware source or release
to dispatch revised work. Landing this command does not change release pins,
saved jobs, services or watchers.
