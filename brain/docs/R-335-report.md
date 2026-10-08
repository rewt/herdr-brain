---
run: R-335
outcome: blocked
summary: |
  Preserved the partially completed Signal outbound steward channel in a WIP commit after the operator paused the item. Implemented operator-local configuration, separate-account validation, argv-only sends with strict identity trust, a cached version gate, channel receipts, setup-alert integration, and operator setup documentation. All 34 steward tests passed offline. Final review and integration remain deferred until the operator resumes this lane; lane check was skipped as instructed.
headline: Signal outbound work is preserved while Claude app push becomes the primary channel.
blockers:
  - 'paused by operator 2026-10-08: Claude app push chosen as primary channel; resume later from this lane'
proposals: []
learnings: []
artifacts:
  - 3deb4a8c432e6205395dabe02e556836eb56a155 - WIP implementation, documentation and passing offline tests
  - lane/signal-out
  - brain/lib/steward-signal.mjs
  - brain/lib/steward.mjs
  - brain/bin/brain.mjs
  - brain/README.md
  - brain/test/steward.test.mjs
  - brain/docs/R-335-report.md
decisions: []
questions: []
challenges: []
---

Feature work stopped immediately on the operator's pause instruction. Nothing
was deleted or reset. The lane retains the implementation for a later resume.

Completed WIP behavior:

- Local `signal: { cli, account, recipient }` configuration requires two distinct
  international phone numbers and refuses malformed settings before effects.
- Signal receives the shared filtered alert JSON through `execFile` argv only.
  Sends force `--trust-new-identities never`; no receive, daemon, reply handling,
  or automatic trust was added. No dependency was added to brain.
- Stable signal-cli versions at least 0.14.8 are required. Each executable gets
  one version probe per process, including failed probes. Success and failure
  receipts include the parsed version; missing or unsupported versions and
  failed sends leave local and iMessage deliveries independent.
- Routing results, setup tests, and journal-refusal alerts capture channel
  results. Signal shares the existing routing cap and debounce.
- Setup documentation covers Java, a separate bot registration by SMS/voice
  with captcha, registration-lock PIN, private key-file permissions, safety
  number comparison, explicit `trust -v`, and identity-change recovery.

Validation before the pause: `node --test brain/test/steward.test.mjs` passed
34/34 tests, including exact payload/argv, account equality refusal, version
gating and caching, ordinary and identity-change failures, other-channel
delivery, caps, and setup alerts with and without iMessage. `git diff --check`
passed. All tests used local fake transports; no live setup alert was sent.

Remaining on resume: review this WIP and compose it with the human-question
alert payload changes. This lane starts at da07cc67, where the shared public
payload is project/session/kind; the later human-question payload and opt-in
are absent here. Signal uses that shared formatter so it should inherit those
changes when integrated, but the combined behavior still needs review. Complete
the required lane validation only after the operator resumes work. No broad,
promotion or release suite was run; lane check was explicitly skipped.
