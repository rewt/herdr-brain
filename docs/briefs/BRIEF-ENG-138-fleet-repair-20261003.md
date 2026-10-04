# ENG-138: fleet repair for a moved checkout with an external record

Read ENG-138 (record show), the fleet design memo `docs/design/ARCH-17-workspace-20261003.md`, and `lib/fleet.mjs`
with `discovery/client.mjs` (the `fleet join` options). herdr-brain and bch-cloak keep their record outside the
checkout (`.org` beside it). When such a checkout is moved or re-cloned, its first automatic entry registers a new
hash-suffixed project with a fresh empty `.org`, and both `fleet join --replace NAME` and `join --record` refuse the
repair, so the real record is orphaned and only a hand edit of `fleet.json` recovers it. Nobody edits `fleet.json` by
hand.

Acceptance, written as tests in `test/fleet.test.mjs` that fail on current main first:

1. With the stale entry still present, `fleet join --replace NAME --record EXISTING_RECORD` from the moved checkout
   repairs the entry in place: same project name, new root, the existing record, no fresh `.org` created, no duplicate
   hash-suffixed entry left behind.
2. Automatic entry from a checkout that plausibly matches a stale entry (its root is gone and it has an external
   record; plausible means the same remote or directory name, using what `lib/fleet.mjs` already records) does not
   create a fresh record. It shows the stale entry and prints the exact repair command for the agent to run. The match
   only suggests; it never repairs or binds a record by itself.
3. The existing refusals that protect the record stay: an unknown name, a record that belongs to another live entry,
   overlapping roots.

Keep it small: no new files beyond tests, no new fleet fields unless a test needs one. Files: `lib/fleet.mjs`,
`discovery/client.mjs` if the CLI surface changes, `test/fleet.test.mjs`. Do not touch `acceptance/` or
`test/helpers/` (other lanes own them). Commit, write the report, record check it, commit it, run lane check last.
Then stop.
