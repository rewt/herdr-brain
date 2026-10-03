# ENG-117: fixture inbox teardown and the detached owner

Main has an intermittent promotion-tier failure since ENG-112 (8933d03): a settle test's after-hook throws
`Cannot confirm fixture inbox owner identity` from `stopFixtureInbox` in `test/helpers/inbox.mjs`.
The check requires the owner process to share the test's process group, but
`supervisor/prompt-supervisor.mjs` spawns the inbox owner with `detached: true`, so it leads its own group.
The check passes only when the owner has already exited. Seen in `settle/test/round-cap.test.mjs`
('cap reached still dispatches for Major, FAIL or red validation') and the discovered-settings settle test.

Make teardown confirm a live detached owner safely (recorded argv, birth identity, its own group), then stop it
as ENG-112 intended. A pid now held by a different command is not ours: treat it as gone and never signal it.
Keep failing closed when ownership is genuinely ambiguous. Add a regression that keeps the owner alive past the
test's end. Confirm the hypothesis first; if the cause is different, fix the actual cause and say so.

Run `npm run test:fast` and the settle suites, including round-cap several times. Never run the live harness.
Commit, write the report, record check it, commit it, run lane check last. Then stop.
