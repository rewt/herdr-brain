R-295 correction evidence
=========================

The four requested files run together in the bounded offline runner. The two
native cases run at an unmodified main archive and at the corrected lane source.
The native comparisons queue for the shared host slot; their adjacent slot JSON
files record waiting and acquisition. Queued preliminary commands were stopped
before acquisition and restarted with local fixture permissions; they ran no
tests. The ordinary targeted tests initially queued too, then were moved to the
normal bounded offline runner; their queued command ran no tests.

Common shell environment:

```
MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp
PATH=/Users/rewt/.local/bin:$PATH
```

`codex` therefore resolves to `/Users/rewt/.local/bin/codex`, whose real target is
`/Users/rewt/.codex/packages/standalone/releases/0.160.1-aarch64-apple-darwin/bin/codex`.
Node is `/Users/rewt/.nvm/versions/node/v20.19.4/bin/node`.
Main snapshot: `62171eadc9a99b669219ee275feb3a0578a9b58d`.
Corrected implementation: `4c5c686202cc505360df87dab8399c1662522787`.

Targeted command (targeted.tap; targeted-slot.json records the cancelled wait):

```
node test/helpers/run.mjs --file-timeout=480000 dispatch/test/record-worker.test.mjs acceptance/test/cutover-housekeeping.test.mjs acceptance/test/cutover.test.mjs dispatch/test/dispatch.test.mjs
```

Main and head commands (native-main.tap / native-head.tap and slot JSON):

```
PATH=/Users/rewt/.local/bin:/Users/rewt/.nvm/versions/node/v20.19.4/bin:$PATH /Users/rewt/.nvm/versions/node/v20.19.4/bin/node test-slot/test-slot.mjs run eng252-main-matched --wait-receipt-path <evidence>/native-main-slot.json -- /Users/rewt/.nvm/versions/node/v20.19.4/bin/node test/helpers/run.mjs --file-timeout=480000 '--test-name-pattern=^(installed live discovery records concurrent workers|actual native transport validates and promotes work)' acceptance/test/live-session.test.mjs acceptance/test/validation.test.mjs
node test-slot/test-slot.mjs run eng252-head --wait-receipt-path <evidence>/native-head-slot.json -- node test/helpers/run.mjs --file-timeout=480000 '--test-name-pattern=^(installed live discovery records concurrent workers|actual native transport validates and promotes work)' acceptance/test/live-session.test.mjs acceptance/test/validation.test.mjs
```

The main command runs from the unmodified archive; the head command runs from
this lane. The initial main shell selected Node 26.4.0 at
`/opt/homebrew/Cellar/node/26.4.0/bin/node`; it passed both cases, with evidence
retained as native-main-original-shell.tap and its slot JSON. The lane shell
selected Node 20.19.4. To control that difference, the main comparison was repeated
with `/Users/rewt/.nvm/versions/node/v20.19.4/bin/node` explicitly used for both the
slot launcher and bounded runner, and with its bin directory immediately after
native Codex's directory on PATH. native-main.tap and native-main-slot.json are
this matched-runtime rerun (label eng252-main-matched). The native cases execute
only fixed offline sandbox commands and scripted workers. No model or live Herdr call is made.

Targeted result: 58 tests passed, zero failures/cancellations/skips. File counts:
record-worker 6/6, cutover-housekeeping 1/1, cutover 14/14, dispatch 37/37.
The bounded runner completed with exit 0 and no surviving-fixture diagnostic.

Native results: main (matched Node 20) and head each passed both selected cases,
with zero failures/cancellations and six unrelated cases excluded by name.
The initial main Node 26 run also passed both selected cases. Every native run
acquired the shared host slot, completed with exit 0, and emitted no surviving
fixture diagnostic. Neither R-289 failure reproduced under these conditions.
