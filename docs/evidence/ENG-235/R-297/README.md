# Symlinked temporary-directory correction

Run R-297, 2026-10-07. Implementation commit: `829a871`.

The unmodified `settle/test/test-plan.test.mjs` failed with
`Unexpected end of JSON input` when launched with TMPDIR pointing to a
symlinked scratch directory. `reproduction.log` preserves that failure.
The three existing feature test files changed here do not exist on main,
so the original real-planner test was reproduced on the lane's starting HEAD.

The focused offline command passed 63 tests with no failures or skips:

```sh
node test/helpers/run.mjs promote/test/affected-tests.test.mjs settle/test/test-plan.test.mjs settle/test/test-evidence.test.mjs test/helper-main.test.mjs test/cli-help.test.mjs
```

| File | Pass | Fail |
| --- | ---: | ---: |
| `promote/test/affected-tests.test.mjs` | 4 | 0 |
| `settle/test/test-plan.test.mjs` | 2 | 0 |
| `settle/test/test-evidence.test.mjs` | 12 | 0 |
| `test/helper-main.test.mjs` | 4 | 0 |
| `test/cli-help.test.mjs` | 41 | 0 |

`focused.log` records the full result. Regressions exercise the planner and
runner helpers launched through a symlinked directory, canonical planning with
a symlinked TMPDIR, snapshot cleanup, and empty/whitespace output retaining an
explicit planner failure and remaining recoverable through recorded evidence.
CLI help remains successful, including the existing release-symlink cases.

After committing the fix, `node --test settle/test/test-plan.test.mjs` passed
2/2 with TMPDIR explicitly set to a symlinked scratch directory; the canonical
snapshot therefore included the committed planner and its updated imports.
`canonical-symlink.log` records that result. Both reproduction and confirmation
used Python's `TemporaryDirectory` under `/private/tmp`, made `real` and `linked`
directories (the latter a symlink to the former), and supplied `TMPDIR=linked`
to the child command.

The main-module pattern audit found and fixed all five instances in
`test/helpers/`: affected-tests, release-suites, tier, suite and pty.
`git diff --cached --check` passed. The final lane fast check follows the checked
report commit; `.lane/gate.json` is the authoritative final-HEAD receipt.
