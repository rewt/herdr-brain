# Closed-profile green checker validation

Run: R-543, 2026-10-18. Validated implementation head:
`d19486dc3c891e775f392d0669d88ba71f848d2c` on `lane/green-cohort`.
This completes the held validation recorded in `../R-539/validation.md`.
The round-5 ask explicitly lifted the test hold for the cohort's own tests.

## Executed check

Ran once with Node 20.19.4 first in PATH:

```sh
PATH=/Users/rewt/.nvm/versions/node/v20.19.4/bin:$PATH node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs
```

Raw output: the `output` field of `green-pass.json` (merged stdout and stderr).
Exit code: **0**. TAP reports **177 passed,
0 failed, 0 cancelled, 0 skipped**, in 51,876 ms. No implementation or fixture
corrections were needed. This run adds only validation evidence.

Decoded raw output SHA-256:
`f86d2c1a252d5573ed197dd6ad57aa0cc9d16c3a394e9002be4b47cfa3da0b9a`.
JSON preserves the exact output, including trailing spaces in two truncated
test labels, while keeping the committed diff free of trailing whitespace.

## Review findings exercised

The fixtures assert admission codes, rather than merely checking that a scanner
returned a diagnostic. All witnesses use the same closed grammar; no fixture
source or finding name is special-cased in production code.

| Round-3 finding | Passing TAP cases | Required result |
| --- | --- | --- |
| Lexical branch errors after hidden imports | 18–19: non-ASCII and escaped identifiers | `GREEN_REACH_UNKNOWN` |
| Regex starts after default, spread and extends | 20–22, plus the regex-prefix matrix | `GREEN_REACH_UNKNOWN` |
| Stored/computed loader and reflection reads | 23–26: dlopen, binding, constructor, computed key | `GREEN_REACH_UNKNOWN` |
| Unrecognized child-process import specifiers | 27–28: default-as and ChildProcess | `GREEN_REACH_UNKNOWN` |
| Child environment and cwd overrides | 29–34: spawn/fork env, computed cwd and literal cwd | `GREEN_REACH_UNKNOWN` |
| Cwd-relative subprocess targets | 35–36: fork and Node spawn | `GREEN_REACH_UNKNOWN` |
| Spawned supervisor handle authority | 54–57: supervisor entry and transitive helpers; 37: authority-only spawned target | `GREEN_SELF_AUTHORITY` |

Positive controls include an eligible lifecycle change with bound control
evidence, canonical lab evidence through the actual autopilot admission flow,
pure constant data, static/literal imports, URL-anchored named launches, confined
absolute script paths and closed fork overloads. Frozen inventory and authority
mode-change fixtures retain their named refusal codes.

The actual authority fixture inventories 242 paths and retains 128 diagnostics
(the diagnostic cap), including the supervisor handle relay and its helpers.
This is conservative reach evidence alongside unknowns, not a claim of a complete
understood production closure. Existing ENG-422 remains necessary before enabling
green admission.

## Scope and remaining validation

No `supervisor/test/autopilot.test.mjs`, full suite, release gate, live acceptance
or artificial load ran. Native autopilot validation remains with the supervisor,
as the ask requires. The passing autopilot admission case above belongs to the
cohort's own test file; it does not replace that separate native suite.

The runner emitted a nonfatal shared-history diagnostic about command files from
other origins; the process completed successfully with no test failure. The
change enables no cohort or release and supplies no independent review verdict.

`git diff --check main...HEAD` and the evidence diff whitespace check passed.
The run report records the evidence commit and the final clean-worktree check.
