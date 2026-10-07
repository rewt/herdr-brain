# R-300 rebase evidence

Rebased `lane/existing-cleanup` from `40703146` onto local main
`47989b788eadf2185d60773a522907563e445ac2`. The six lane commits were replayed;
the reviewed head became `03b8c8b8`. `rebase-range-diff.txt` shows that the only
patch change preserves `digest` alongside `worker` in the CLI command registry.
Main's outcome ownership and reopen ordering code remains intact.

Runtime: Node v20.19.4. Requested offline command:

```sh
TMPDIR=/private/tmp node test/helpers/run.mjs \
  dispatch/test/record-worker.test.mjs \
  acceptance/test/cutover-housekeeping.test.mjs \
  acceptance/test/cutover.test.mjs \
  test/digest.test.mjs test/flow.test.mjs test/cli-help.test.mjs
```

`targeted.tap` retains the initial invocation without the TMPDIR override.
It passed 85/87, failing two cutover copy audits because the inherited worker
temp path was under `/Users/rewt/.herdr-monitor/`; relocated scratch paths then
contained the forbidden home prefix. `targeted-private-tmp.tap` captures the
rerun with scratch outside that prefix: 86/87 passed, with the remaining case
denied by the outer worker sandbox when applying its own macOS sandbox
(`sandbox-exec: sandbox_apply: Operation not permitted`). The bounded runner's
process snapshot was also denied. `targeted-host.tap` captures the same requested
command with approved host execution so both native sandbox application and
fixture process auditing can complete. No audit or product code was changed.

Host result: **87 passed, 0 failed, 0 skipped/cancelled**, exit 0, with no
surviving-fixture or cleanup diagnostic. Per file: record-worker 6,
cutover-housekeeping 1, cutover 14, digest 8, flow 17, cli-help 41.
`git diff --check` also passed.

All invocations use the bounded offline runner and its isolated fleet/fake
Herdr adapter. No model calls, live acceptance harness, project housekeeping
loop, or live tab cleanup were used.
