# Safe retirement fix round 1

Run: R-412. Source commit: `85016bd716c4d5220d42ab901b32aaa8bc08d3a9`.
Review: `docs/reviews/safe-retirement/fa60fd2-r1.md`. All six accepted findings are fixed.

1. Foreground consumers in canonical supervisor entry and both promote-drain
   boundaries compare request/handled revisions, plan afresh and use the shared
   guarded executor once. Event writers supply their appended sequence; verify
   completion supplies a job key. Repeated hints do nothing, and a hint arriving
   during apply remains pending. Tests exercise actual record disposition,
   both drain boundaries and supervisor entry.
2. Every record reader loads the handoff events independently of CLI status.
   A housekeeping fixture releases the superseded pane and retains its successor.
3. Immutable process and shell launch identities in mechanical callback receipts
   enable exited watcher, settle, executive and plan shell pruning. Spawned
   settle-watch retains its paths and flags and uses narrow self-retirement only
   for its own tab, pane, PID and birth after ingestion. Fixtures reject changed
   shells, wrong births, focus, additional occupants/processes and live jobs.
   Unrecorded legacy shells remain kept; labels and display metadata add no authority.
4. Tokens project process PID, kernel birth, command and parent, excluding state
   letters. Fresh decisions still refuse stopped or unknown processes. A fixture
   changes S to R without invalidating a release, then confirms T refuses it.
5. Cleanup receipts retain revision, attempts, timing and last refusal. Unchanged
   revisions permit at most five attempts with exponential backoff beginning at
   one minute. A new record/request revision resets the budget. Tests preserve
   the promoted result throughout and never rerun integration or its gate.
6. Lane close accepts an absent executable as an empty inventory while retaining
   record/job guards. An installed but unreadable server refuses removal. The
   comment and lanes README agree; fixtures exercise both cases through the CLI.

The optional keep-only `herdr-reference/v1` source and its exact format are unchanged.
There is no dependency on a particular writer. The core fold and its exports are
unchanged. No live pane cleanup, project housekeeping start, model call, release,
promotion of this lane or push was performed.

Affected files were checked in both modes, with no broader suite:

```sh
node test/helpers/run.mjs test/retire.test.mjs test/retire-paths.test.mjs housekeeping/test/housekeeping.test.mjs housekeeping/test/auto-tidy.test.mjs supervisor/test/entry.test.mjs promote/test/promote.test.mjs verify/test/verify.test.mjs
node --test test/retire.test.mjs test/retire-paths.test.mjs housekeeping/test/housekeeping.test.mjs housekeeping/test/auto-tidy.test.mjs supervisor/test/entry.test.mjs promote/test/promote.test.mjs verify/test/verify.test.mjs
```

The plain invocation inherited an isolated fake Herdr environment from
`offlineHerdr()`; it used no runner/preload or owned suite group. Results:

- `gate.tap`: 279 passed, 0 failed, 0 skipped; 101.960 seconds; exit 0.
- `node-test.tap`: 277 passed, 0 failed, 2 skipped; 86.654 seconds; exit 0.
  Both skips are receipt-owned housekeeping startup cases that require the
  runner's process group; both passed in the gated run.
- Syntax checks and `git diff --check` passed.

Initial executions found stale assertions about project-wide foreground
observation and narrow self-retirement, plus native full-snapshot races during
verify fixture inbox shutdown. Assertions now reflect the requested behaviour;
fixture teardown retries only refused ownership inspections for a bounded five
seconds, preserving identity checks before every signal. Initial retained fixture
inboxes were subsequently confirmed stopped through the same ownership helper.
The final gated run reported no surviving fixture. Shared command-history notices
are host diagnostics, not failures or new cleanup authority.
