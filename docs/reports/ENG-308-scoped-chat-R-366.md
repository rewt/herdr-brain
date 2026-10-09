---
run: R-366
outcome: done
summary: |
  Corrected all three scoped-chat review findings. Scoped reads now share read-mode streaming, signal forwarding and exit-code propagation after the caller-binding check, without a wrapper timeout or buffer cap. Missing or malformed focus neighbors receive an explicit scoped refusal. The scoped-mode and read-mode regressions passed; the final clean-tree lane check follows the report commit.
headline: Scoped chat reads now stream and wait without an added deadline.
blockers: []
proposals: []
learnings: []
artifacts:
  - "f233d0c: Share streamed Herdr reads with scoped chats"
  - "branch: lane/chat-scoped"
  - discovery/herdr-read.mjs
  - discovery/herdr-scoped.mjs
  - discovery/test/herdr-scoped.test.mjs
  - docs/reports/evidence/R-366/scoped-read.tap
  - docs/reports/ENG-308-scoped-chat-R-366.md
  - "/Users/rewt/development/rewt/.org/runs/R-366/report.md"
decisions: []
questions: []
challenges: []
---

Addressed the three findings in `docs/reviews/chat-scoped/ff6533d-r1.md`:

- Both wrappers call the same `executeRead` implementation: asynchronous spawn,
  inherited stdio, signal forwarding for SIGINT/SIGTERM/SIGHUP, and propagation
  of the Herdr exit code. Scoped reads first require the live launcher-owned
  caller binding, then supply the existing clean environment and pinned socket.
  Buffered calls remain confined to mutations and their validation lookups.
- Focus validates the neighbor's string type and pane ID pattern before its
  membership lookup, refusing with `scoped Herdr refused: no focus neighbor`.
- The entry comment now distinguishes unrestricted read tab selection from the
  required caller binding that pins the socket.

Validation: `node --test discovery/test/herdr-scoped.test.mjs
discovery/test/herdr-read.test.mjs` completed with 27 tests, 25 passed, zero
failures and two opt-in native Claude probes skipped. The committed TAP captures
the final implementation. Added installed-wrapper tests prove an indefinite
wait-output outlives ten seconds, stdout/stderr arrive before read completion,
9 MiB of output succeeds, all three signals reach fake Herdr, its nonzero exit
code propagates, an unclaimed caller makes no Herdr call, and missing/malformed
neighbors refuse before any neighbor membership lookup or focus mutation.
Forged binary/socket/PATH values in the asynchronous read fixtures also leave
the pinned route intact. `git diff --check` passed.

The fake-socket suites used approved command escalation because the worker
sandbox denies private Unix socket fixtures. These tests remain offline and use
no live panes, models or host test slot. No baseline, full npm test, promotion,
release or acceptance tier was run.

After writing and record-checking this report and committing its repository
copy, the final command is:

```sh
node lanes/lane.mjs check --cmd "node --test --test-name-pattern='^(pure scoped grammar|scope is rechecked)' discovery/test/herdr-scoped.test.mjs && git diff --check"
```

This gate selects only the pure grammar and membership/idle recheck tests; the
full fake-socket regression evidence is committed above. Its result is not
claimed in advance. The worker stops after that command.
