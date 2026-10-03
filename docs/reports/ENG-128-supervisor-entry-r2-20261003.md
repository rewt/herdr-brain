---
run: R-166
outcome: done
summary: |
  Rebased onto main and fixed all three supervisor-entry review findings. Explicit supervisor launches now persist the Herdr pane, canonical Git identity, record and recipient so native restore, clear and compact work without adapter environment variables. Adapters reuse checked-in entry hooks, and recovered watchers honor the run's dispatch recipient. All 37 focused offline entry tests pass; implementation and test evidence are committed. The final lane check follows this report's validation and commit.
headline: Supervisor recovery survives restored panes and preserves watcher recipients
blockers: []
proposals: []
learnings:
  - "Herdr pane identity survives restore; explicit launch receipts use it rather than native session ids, which may change across clear or compaction."
  - "Dispatch receipts have token filenames; the run's dispatch_journal metadata locates the receipt containing its original to recipient."
  - "Direct native resume without adapter arguments needs a persistent project hook; this repository already supplies both Claude and Codex project hooks."
artifacts:
  - "Implementation commit beb9448 on lane/supervisor-entry"
  - "Rebased onto main at 61be51b before changing files"
  - "supervisor/session-binding.mjs"
  - "supervisor/session-start.mjs"
  - "supervisor/session-hooks.mjs"
  - "supervisor/entry.mjs"
  - "supervisor/README.md"
  - "supervisor/test/entry.test.mjs"
  - "docs/reports/ENG-128-supervisor-entry-r2-evidence/test-first.log"
  - "docs/reports/ENG-128-supervisor-entry-r2-evidence/entry-tests.log"
  - "node --test supervisor/test/entry.test.mjs: 37 passed, zero failures or skips"
  - "git diff --check: passed"
decisions: []
questions: []
challenges: []
---

The Major is fixed by an explicit launch binding stored atomically in the canonical
checkout at `.lane/supervisor/panes/<sha256-of-pane-id>.json`. Both native adapters
save it before opening a supervisor. SessionStart first matches `HERDR_PANE_ID`,
canonical checkout and Git common-directory identity, retaining the saved record
and supervisor recipient; explicit adapter bindings remain the fallback. An
existing bound SessionStart can also seed the receipt. Receipt reads and writes
fail with diagnostics while allowing the native session to continue. This is
separate from display-only session metadata and does not add stored work status.

Worker roles and bypass flags win over durable bindings. A lane checkout cannot
use the receipt. Opening a worker in a previously bound pane revokes the receipt
so a later environment-free restore cannot recover its former supervisor role.
The pane match survives changed native session ids on resume, clear and compact.

The duplicate-hook Moderate is fixed by checking the canonical project's native
settings before supplying adapter hook arguments. When the checked-in entry
hook covers startup, resume, clear and compact, no second adapter entry hook is
added. This preserves the separate Claude canary hook. Tests assert an empty
adapter hook argument list and exactly one cold-start brief with no failure
diagnostic for every source in both project hook configurations.

The recipient Moderate is fixed by reading the current run's `dispatch_journal`
receipt and passing its `to` to the re-armed watcher. Only absent receipts permit
fallback to the supervisor recipient or default; malformed or mismatched run
receipts produce a diagnostic instead of a misrouted watcher. Adapters export
their known supervisor recipient and retain it in the pane binding.

Test-first evidence records five failing targeted tests before implementation.
The final focused run passed all 37 entry tests in 13 seconds. New coverage runs
both checked-in hook commands on resume, clear and compact with adapter variables
removed and changed native session ids; rejects a different pane, a lane, a
worker and a bypassed session; verifies worker revocation; and proves both real
adapters save a binding before their offline native stand-ins exit. Recipient
coverage includes a non-default dispatch recipient, no journal and a missing
journal. Existing failure-path tests still cover repeated entry, reported runs,
live lock owners, command failures, STOP and housekeeping recovery boundaries.
Fixtures use temporary repositories and offline native/command stand-ins; no
live project housekeeping, pane restoration or model call was performed.

For Codex native resume without adapter environment, this repository's trusted
project SessionStart hook uses the same durable pane receipt as Claude. A native
resume losing launch arguments in a project without a persistent hook cannot
invoke entry automatically; a project hook is required there. Outside Herdr,
environment-free resume without a pane id cannot recognize a supervisor. Existing
unmarked panes require one explicit supervisor adapter launch to seed the binding.
Existing native hook availability and trust requirements remain as documented.
No live reboot/restore or native Codex trust flow was claimed by these offline tests.

Reviewed the complete diff against the brief and the supplied review. The review
file was preserved locally and excluded through Git's local exclude file; it was
not committed or copied into tracked repository content. No baseline, full suite,
promotion suite, lanes suite or live acceptance harness was run. As requested,
the report is checked and committed before `node lanes/lane.mjs check`, which is
the final action; its result is reported in the terminal response.
