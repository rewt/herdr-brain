# Green cohort review corrections

Run: R-537. Prior head: `18672a287e1b8a43e85e07f039f85703fd399afc`.
Node: 20.19.4, first in PATH. All checks were offline; no load generator ran.
The TAP captures have trailing whitespace removed for Git whitespace checks;
substantive output is unchanged.

The four independent-review findings are covered by committed fixtures:

- `fork` contributes repository script reach; computed targets and unresolved
  options refuse. Direct child-process exports and local launcher re-exports
  retain unknown edges, including aliases and exports before imports.
- Regex prefixes include braces, the requested keywords and binary operators.
  Ambiguous closing-parenthesis/brace slash readings refuse when their strings
  or identifiers differ. The exact hidden-import exploit refuses.
- Self-authority includes the running autopilot/green checker static import
  closure on each admission. Housekeeping configuration, dispatch metrics and
  transitive helpers refuse as self-authority. Missing authority input refuses.
- `process.dlopen` retains an unsupported-loader edge.

## Required focused run

Executed once:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs supervisor/test/autopilot.test.mjs
```

Output: [focused.tap](focused.tap). Exit 1; 257 tests, 255 passed, 2 failed,
none cancelled/skipped. Duration: 331870.360542 ms. All 125 green-cohort cases
passed. The unchanged autopilot file had these failures:

1. `automatic PASS reaches the real queue, lands and closes with one awaited wake`:
   the anchor fixture was refused by `PROMOTE_NATIVE_PROCESS_SOURCE_REFUSED`,
   status 125, with `Operation not permitted` during native process observation.
   This is a sandbox-limited result, not a passing integration check.
2. `automatic queue rechecks stale-PASS at final integration`:
   settling the offline reviewer exited 1 before queue admission; the recorded
   reason was `independent review did not complete` and `1 !== 0`. The fixture
   cleanup removed its private review log, so the underlying cause remains
   unclassified. This run does not establish that integration case passes.

The shared-history diagnostic mentions commands from other origins; this run
claims only the three invocations recorded here. The required suite was not rerun.

## Final overload correction

Inspection during the required run found that `fork(module, computedOptions)`
could otherwise bypass executable-option checks. After that run, the final
correction distinguishes literal argv arrays from options objects and refuses
unresolved overloads. Only its small regression was then executed (twice, as
inspection tightened object bindings against option mutation):

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 '--test-name-pattern=^fork overloads ' supervisor/test/green-pass.test.mjs
```

Output: [fork-overloads.tap](fork-overloads.tap) and the final
[fork-overloads-final.tap](fork-overloads-final.tap). Both exit 0; each has 1
passed, 125 skipped, none failed. The final case covers five resolved forms and
five unresolved, mutated or executable-override forms. The full suite predates
this final small correction.
Node syntax checks passed for both changed modules and the fixture file.

## Authority inventory and limits

[authority-imports.json](authority-imports.json) records 79 modules in the
running-source static import closure, with no unknown edges. This includes
`housekeeping/config.mjs` and `dispatch/metrics.mjs`.

The corrections enable no cohort or release. Existing unresolved checkout
execution edges remain the separately recorded ENG-422 follow-up. This evidence
does not assert deployment readiness or independent acceptance. The unchanged
integration cases still require validation during the normal promotion batch.
