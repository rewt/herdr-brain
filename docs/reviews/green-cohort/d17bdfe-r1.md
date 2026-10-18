**NEEDS-WORK**
Schema: lane-review/v1
Reviewed commit: d17bdfec4c900ce424b671c08cff58733e8c777d
Topic: green-cohort
Round: 1
Review ID: lr-dfeeef378a1a29bc1a06092e65c7b437
Base branch: main
Base commit: 05326989cd5088fc35f29fb1779cc408843907c5

## Findings
- [Moderate] supervisor/green-reach.mjs:111 - tokenReadings silently drops any lexical reading that throws and adopts the survivors, so when the true regex reading hits construct the scanner rejects (for example a non-ASCII identifier or an identifier written with a Unicode escape placed after the hidden import on the same line) only the false division reading remains, its fake string hides the dynamic import, no ambiguity is compared and no unknown edge is recorded; the round-3 hidden-import fixture with such an identifier appended before the trailing comment fails open; Fix: discard a branch only when it fails with an unterminated regular expression at its own choice slash and treat every other branch error as an unknown edge (throw from tokens), with a fixture that appends a scanner-rejected identifier to the existing hidden-import source
- [Moderate] supervisor/green-reach.mjs:10 - The regex-start set still omits tokens that can precede a regex literal, notably \`default\`, the spread operator \`...\` and \`extends\`, so source such as \`export default\` followed by the round-3 hidden-import regex and dynamic import (or an array spread of that regex) is lexed as division and the following quote string hides \`import(spec)\` with a single unambiguous reading; Fix: add default, the spread token and extends to regexPrefix (or treat any slash after a token outside a known division-only set as ambiguous) and add fixtures for the export default and spread forms
- [Moderate] supervisor/green-reach.mjs:214 - The loader, reflection and reflective-property denylists match only identifier tokens, and a computed member read is unknown only when immediately called, so \`const load = process\['dlopen'\]; load(module, file)\`, a stored \`process\['binding'\]\`, or \`const F = (() =\> {})\['constructor'\]; F(code)()\` loads native code, spawns or evaluates arbitrary source with no unknown edge, leaving finding 4 of the prior review only partially closed; Fix: also apply the loader and reflective-property lists to string and static template token values and record an unknown edge for any bracket member access whose key is not a numeric literal unless it is a recognised closed dispatch, with fixtures for the stored dlopen and stored constructor forms
- [Moderate] supervisor/green-reach.mjs:207 - A brace import from child\_process registers only the seven launcher names, so \`import { default as cp } from 'node:child\_process'\` followed by \`cp.execSync(cmd)\` (or an imported \`ChildProcess\` whose instance spawn method launches a process) passes the namespace/default check and registers nothing, an undetected shell or subprocess launch; Fix: record an unknown edge for every child\_process import specifier other than the seven recognised launcher names (including default and ChildProcess), with a fixture for the default-as alias
- [Moderate] supervisor/green-reach.mjs:329 - Process option analysis only rejects top-level spread, computed, accessor, shell, execPath and execArgv keys, so an \`env\` object setting NODE\_OPTIONS (for example an import of a data URL or of a repository module written as a flag value that the literal-file scan does not resolve) or a computed \`cwd\` changes what the child executes while the scanner records only the named script; Fix: record an unknown edge for any cwd option that is not a string literal and for any env option that is not a closed literal object free of spreads, computed keys and NODE\_OPTIONS, with fixtures for both forms on spawn and fork
- [Moderate] supervisor/green-reach.mjs:340 - Fork and node-spawn script targets are resolved against the calling file directory (or the repository root) although Node resolves a relative modulePath or argv script against the child working directory, so \`fork('./worker.mjs')\` in a supervisor module is credited to supervisor/worker.mjs while the process actually runs a different file from its cwd, and the new fork fixture enshrines that mapping; Fix: accept only import.meta.url-anchored or otherwise absolute targets (or relative targets paired with a literal cwd option) and record an unknown edge for other relative script targets, adjusting the fork fixtures accordingly
- [Moderate] supervisor/green-pass.mjs:37 - The derived self-authority set follows only static imports from supervisor/autopilot.mjs and supervisor/green-pass.mjs, but autopilot executes supervisor/supervisor.mjs through a spawned node process as the handle path whose promotable result and review verdict it trusts and which closes promoted items, and neither that script nor its own imports such as supervisor/entry.mjs, supervisor/status.mjs and supervisor/safe-point.mjs is in authority-imports.json or any exclusion, so the fast path evidence relay stays green-eligible once ENG-422 clears the current unknown edges; Fix: derive the authority set from the execution closure of the authority entries (literal script references and spawned scripts as well as static imports) or add supervisor/supervisor.mjs to authorityEntries, with a fixture asserting a change to supervisor/supervisor.mjs refuses as GREEN\_SELF\_AUTHORITY

## Re-executed
```json
[]
```

## Non-claims
- The supplied gate is inherited evidence; this review does not claim tests passed.
- Validation is inherited from settle; the explicit zero-command review budget permits no independent execution.

## Unverified
- Test evidence not re-executed: supervisor/test/green-pass.test.mjs.
- Test evidence not re-executed: supervisor/test/autopilot.test.mjs.
- The requested single combined run recorded 2 of 257 failures; the autopilot case for stale-PASS recheck at final integration failed with an incomplete offline review whose cause the worker could not classify and whose log was removed, so it is not established as sandbox-limited.
- The final fork-overload tightening postdates the combined run and was exercised only by a single-case name-filtered run per the worker evidence; the remaining cases were not run against the reviewed head.
- Every fail-open scenario in Findings was established by reading the scanner source under the zero-command budget, not by executing a fixture.
- Whether the Brain and lab autopilot processes load the checker from the canonical checkout, and the completeness of the single cross-project entry inventory, remain deployment facts outside this review, as in the prior round.

## Sanitization
- absolute-path: 0
- user: 0
- host: 0
- private: 0
- relative-path: 0
- redacted execution fields: None

<!-- lane-review-complete -->
