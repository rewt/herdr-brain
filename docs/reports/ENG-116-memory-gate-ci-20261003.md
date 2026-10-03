---
run: R-176
outcome: done
summary: |
  The promotion failure was an outdated installed-runtime test fixture, not a
  route-resolution regression. Declared a fixture review route and verified that
  the relocated runtime reads its bundled review template before the expected
  offline Herdr refusal, both directly and with --memory-checked. Unknown routes
  still fail before the template read. All 39 plugin-install tests passed. The
  report is checked and committed before the final targeted lane check.
headline: The relocated runtime review test now supplies its required route
blockers: []
proposals: []
learnings:
  - Explicit lane route tables do not inherit the suggested preset; an empty table cannot resolve the default review route.
  - Review now validates its route before the memory wait and template read, so a template installation test must declare a valid route.
  - Both direct review and coordinated --memory-checked review resolve the configured route and read the bundled template after the build checkout moves.
artifacts:
  - "Commit 848b6c4: Align relocated review fixture with early route validation"
  - "test/plugin-install.test.mjs: installed review route, early unknown-route refusal, and template reads with and without --memory-checked"
  - "node test/helpers/run.mjs test/plugin-install.test.mjs: 39 passed, 0 failed, 0 skipped"
  - "/private/tmp/R-176-plugin-install.log"
  - "docs/reports/ENG-116-memory-gate-ci-20261003.md"
  - "Final check after report commit: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/plugin-install.test.mjs'"
  - "/private/tmp/R-176-lane-check.log"
decisions: []
questions: []
challenges: []
---

Promotion's failure at the template-read assertion reported `unknown route:
review (none configured)`. The scratch project explicitly configured `routes:
{}`, while review defaults to the named `review` route. The earlier command
read the template before attempting dispatch's route resolution. The memory
gate follow-up moved route validation ahead of the memory wait so invalid work
does not hang under pressure; this exposed the invalid fixture sooner. The
configuration-loading and route-resolution code still honors the explicit table.

The test now declares an opaque offline fixture route. After installing the
runtime and relocating its build checkout, it checks both direct review and
coordinated review with `--memory-checked`. For each invocation, an unknown route
exits 2 without reading the template; the configured default route reads the
exact bundled template and exits 2 at the fake Herdr server refusal. This also
replaces the original broad nonzero-exit assertion with specific evidence that
execution reaches the intended dispatch boundary. Production memory waits,
STOP receipts and routing behavior remain intact.

The requested file passed all 39 tests in 89.36 seconds using the bounded offline
fixture runner. The initial sandboxed launch failed before tests because `ps`
was denied; the authorized rerun retained process ownership and cleanup checks.
No baseline, full suite, model call, live acceptance harness, review launch or
promotion was run. The final lane check uses the same targeted file through
`--cmd` to honor this run's explicit test scope, after the report commit; its
result is recorded by the lane gate and the log listed above.
