---
run: R-165
outcome: done
summary: |
  Rebased the lane onto main and fixed all four round-three findings. Supervisor
  handle now streams memory wait reasons, correction failures retain diagnostics
  and request paths, stopped reviews exit 3 with resumable settle handling, and
  cold starts carry command basenames and resource figures without process argv.
  Updated lane documentation and shipped targeted offline regressions. The final
  lane check follows this report's validation and commit; promotion validation
  remains with the supervisor's batch.
headline: Memory waits are visible and supervisor context excludes process arguments
blockers: []
proposals: []
learnings:
  - Lane review STOP receipts use exit 3; PASS remains exit 0, verdict failures exit 1, and review errors exit 2.
  - Inherited dispatch stderr needs a captured failure receipt to retain diagnostics in settle handoffs, including failures before a request journal exists.
  - Process diagnostics request ps comm rather than args and project only command basenames, PID, parent PID, RSS and CPU into cold-start context.
artifacts:
  - "Commit 3a0af25: Fix memory wait visibility, stopped reviews and process privacy"
  - "Branch lane/memory-gate, rebased onto main before edits"
  - "supervisor/test/supervisor.test.mjs: live handle wait visibility for review and correction, and command-only cold starts"
  - "settle/test/settle.test.mjs: failed correction dispatch and retry preserve their reasons and request paths in handoffs"
  - "settle/test/memory-boundaries.test.mjs: review STOP exit 3, settle retry mapping, and argument validation before pressure waits"
  - "test/memory.test.mjs: command basenames and resource rankings"
  - "lanes/README.md, lanes/docs/REFERENCE.md, docs/reference/memory-gate.md"
  - "/private/tmp/R-165-targeted-tests-authorized.log: 18 passed, 0 failed, 38 skipped"
  - "/private/tmp/R-165-dispatch-diagnostic-test.log: 1 passed, 0 failed, 17 skipped"
decisions: []
questions: []
challenges: []
---

This round addresses only the four findings from the supplied round-three review.
The review input remains untouched and uncommitted. No fourth review was launched.

Supervisor `handle` inherits settle stderr while still parsing stdout. Tests
observe the pressure reason while handle is blocked, then clear the simulated
measurement and prove both review and correction proceed.

Dispatch failures emit a JSON failure receipt on stdout alongside inherited
stderr. Settle extracts the reason and request path into its checked error,
saved journal and escalation handoff. The regression covers both the initial
uncertain delivery and its retry without launching a second correction.

Lane review validates its operands, topic and route before its memory wait.
Dispatch also validates its topic and resolved launch arguments before waiting.
Review's STOP receipt exits 3 and settle restores its review stage for ordinary
retry. Both lane documents describe pressure waits, STOP receipts, exit codes
and coordinator `--memory-checked`, with links to the memory reference.

Process sampling uses `ps`'s command-name field and strips executable directories.
Cold-start JSON explicitly projects only names and process/resource identifiers;
additional argv fields never enter the rendered brief or supervisor context.

Targeted offline command:

```sh
NODE_OPTIONS="--import=$PWD/test/helpers/fixture-policy.mjs" node --test \
  --test-concurrency=1 \
  --test-name-pattern='cold start|supervisor handle exposes|uncertain fix delivery|boundary|direct lane|validates|process diagnostics' \
  supervisor/test/supervisor.test.mjs settle/test/settle.test.mjs \
  settle/test/memory-boundaries.test.mjs test/memory.test.mjs
```

Result: 18 passed, no failures. After preserving original diagnostics for malformed
child JSON, the uncertain-fix-delivery regression was rerun: one passed, no failures.
The first sandboxed attempt could not execute `ps` for existing fixture ownership
and cleanup checks; the authorized reruns passed with those checks enabled.
No baseline, full suite, model call or live acceptance harness was run.

The final lane check uses an invocation-only Git exclude file containing the
existing global excludes plus the exact supplied untracked review path. This
preserves that input without committing it or changing persistent Git settings.
The check uses the configured fast tier; the full promotion batch is reserved
for the supervisor.
