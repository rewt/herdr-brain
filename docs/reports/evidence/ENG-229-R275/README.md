# Concurrent-worker reproduction notes

Base source is an unmodified `git archive` of
`1032c6a599daeb443ed194ce84dd2327216c58cd` in `/private/tmp/eng229-r275/base`.
Head source is lane/entry-pin, implementation
`286df534d2ac629a1c93c82b3a77b75a85a851ec`.

Each authoritative comparison uses the host slot and scripted offline workers:

```
MONITOR_TEST_SLOT_WAIT_SECONDS=3600 TMPDIR=/private/tmp node test-slot/test-slot.mjs run entry-pin-live -- node test/helpers/run.mjs --file-timeout=480000 --test-name-pattern='^installed live discovery records concurrent workers' acceptance/test/live-session.test.mjs
```

- `concurrent-base-slot.tap`: base, Node 26.4.0, the scratch shell's native PATH;
  passed (one selected case).
- `concurrent-head-slot.tap`: correction in progress before native-provider
  fixture fix, Node 20.19.4, lane shell PATH shadows Codex with the installed
  Monitor wrapper; failed with exit 125 after two successful inner tests.
- `concurrent-base-matched-slot.tap` and `concurrent-head-native-slot.tap`:
  identical explicit Node `/opt/homebrew/bin/node` (26.4.0) and
  `PATH=/Users/rewt/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`.
- `concurrent-head-fixed-slot.tap`: corrected fixture with the lane shell's
  original PATH and Node 20.19.4, so installed entry still shadows native Codex.

The lane shell's `which codex` returns
`/Users/rewt/.local/share/herdr-monitor/entry/bin/codex`, a shell script that
execs the installed adapter. That adapter spawns its child with only stdin,
stdout and stderr, losing the validation owner's fd 3 readiness pipe.
`resolveNative('codex')` instead returns `/Users/rewt/.local/bin/codex`, whose
stable symlink now targets the native release 0.160.1 executable. The fixture
now uses that resolver; validation's mandatory readiness check stays intact.
The explicit canary transport remains the installed native selection, and the
canary PATH workarounds introduced in R-271 are reverted.

`concurrent-base.tap` is an earlier, non-authoritative direct test attempt:
no host-slot wrapper, lane-shell Node 20/PATH, plus two temporary adjustments
that preserved and forwarded MONITOR_TEST_SLOT_WAIT_SECONDS. It failed with
125; those adjustments were removed before the authoritative base runs.
This result does not establish a pre-existing product bug.
