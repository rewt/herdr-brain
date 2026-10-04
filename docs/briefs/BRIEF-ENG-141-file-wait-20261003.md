# ENG-141: file waits never miss a wake-up

Read ENG-141 (record show) and its 2026-10-04 note. In CI batch 7a7d8cba (log:
`.git/promote/batches/7a7d8cba-8d2a-4e58-92cf-64418c49c268/train.log`, lines ~2425-2453), two tests in
`test/file-wait.test.mjs` timed out under full-CI load: "accept existing evidence and wait through an incomplete PID
publication" and "follow newly created parent directories without polling". The same file passes in isolation.
A flake on the merge path blocks every promotion, so this is the priority.

Premises to test, not assume: (1) on macOS, `fs.watch` on a directory goes through FSEvents, whose stream may become
live after `fs.watch` returns, so a write made right after subscribing can produce no event and "subscribe before
checking" does not hold; (2) the race the item names: `waitForChange` can miss a deeper directory created between
choosing the nearest existing ancestor and installing its watcher. Confirm or refute each with a test that fails on
current main deterministically (for example, an injected watcher that delivers no events, or a directory created at
the exact gap), then fix `test/helpers/file-wait.mjs` so a missed notification can delay a wait but never strand it.
Keep the deadline load-aware and keep "a notification is never evidence". A bounded backoff re-check as the safety net
is acceptable if the platform gives no other guarantee; say which you chose and why, and rename the test if its title
stops being true.

Also fix the second Minor: `test/helpers/pty.mjs` `nativeOwner` must not mutate the calling process's environment
(HERDR_ variables, PATH, ORG_ACTOR) when `HERDR_TEST_OFFLINE_ROOT` is absent.

Out of scope: the item's "deeper cut" of process launches (ENG-157 already brought CI to about 3 minutes).

Files: `test/helpers/file-wait.mjs`, `test/helpers/pty.mjs`, `test/file-wait.test.mjs` and a PTY helper test if needed.
Prove it under load once without the host test slot: run `test/file-wait.test.mjs` 8 copies in parallel, three times,
all green, and put the command and counts in the report. Run the tests that import these helpers. Commit, write the
report, record check it, commit it, run lane check last. Then stop.
