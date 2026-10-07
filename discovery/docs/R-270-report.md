---
run: R-270
outcome: done
summary: |
  Claude worker settings now allow Unix socket bind/connect beneath the private run temp and the canonical per-user shell fallback when Claude's 44-byte temp cap requires it. Supplied socket paths are merged; inherited settings retain their native scopes and policy locks. Offline settings tests and a model-free probe of the exact Claude Code 2.1.292 bundled runtime passed. Herdr, sibling and peer socket access stays denied under the generated policy; TCP and unscoped PTY allowances remain off.
headline: Claude workers can use test sockets while Herdr control access stays denied.
blockers: []
proposals: []
learnings:
  - Claude Code 2.1.292 appends claude-<uid> to CLAUDE_CODE_TMPDIR and caps sandboxed shell TMPDIR at 44 UTF-8 bytes; longer paths fall back to /tmp/claude-<uid> even though internal files remain in the run temp.
  - The per-user Claude fallback is shared by sessions; a short enough fleet temp root avoids granting it. Scoped socket paths are supported on macOS and ignored by native Linux seccomp.
  - Claude 2.1.292 supports BUN_OPTIONS preload before its CLI entry point; a preload can call the bundled temp selector and sandbox wrapper and exit without a session or model request.
  - The inspected PTY runtime option is an unscoped boolean covering pseudo-tty, /dev/ptmx and every /dev/ttys device; no scoped native Claude PTY setting was found.
artifacts:
  - e290754 — implementation, offline tests, README and native probe evidence
  - lane/claude-sockets
  - discovery/native-sandbox.mjs
  - discovery/test/native-sandbox.test.mjs
  - discovery/claude-socket-probe.mjs
  - discovery/docs/claude-sockets-2.1.292.md
  - node --test discovery/test/native-sandbox.test.mjs — 20 passed, 1 existing opt-in Codex probe skipped
  - node discovery/claude-socket-probe.mjs /Users/rewt/.nvm/versions/node/v20.19.4/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe — exit 0, exact 2.1.292 runtime, no model
decisions: []
questions: []
challenges: []
---

ENG-228 implemented in `discovery/`; the Codex launch path was not changed.

Generated Claude network settings add directory-scoped Unix socket grants for
the run temp and, only when the appended native temp path exceeds 44 bytes,
the canonical `/private/tmp/claude-<uid>` fallback. CLI grants are preserved and
deduplicated. User/project/local/managed settings are left to Claude's native
merger, including its restrictions on repository grants when the sandbox is
admin-required. Warnings identify explicit configured grants that weaken the
generated boundary. Neither `allowLocalBinding` nor `allowAllUnixSockets` is
enabled by Monitor.

The model-free native probe measured `TMPDIR=/tmp/claude-501` with a long run
path. Sockets in that TMPDIR and in the private run temp both bound and connected.
Sibling run and prefix paths, all four peer project areas, live sibling/peer
socket connections, the real Herdr control socket and a symlink to it returned
EPERM. A localhost TCP bind and `os.openpty()` also returned EPERM. The native
probe ran outside the nested worker sandbox after the initial nested attempt
was rejected by `sandbox-exec` before any command ran.

The fallback exception is explicitly documented: it is shared by Claude
sessions of this user, so sockets deliberately placed there are not separated
by run or project. Sibling fleet run directories and peer project paths stay
denied. Choosing a short enough fleet temp root avoids that exception. Linux
has no native socket path filtering; no broad Linux workaround is introduced.
PTY-dependent tests remain unsupported because the available runtime switch
has no per-run scope.

The offline regression file completed with 20 passes and the existing real
Codex probe skipped. No baseline, promotion/release suite, live acceptance
harness, housekeeping loop or model call was run. The report is validated and
committed before the final required `lane check` on the clean commit.
