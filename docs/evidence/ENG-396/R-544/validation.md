# Execution-edge profile and real-main readiness

Run: R-544, 2026-10-18. Starting head: `26b41ea6`.
Implementation tested: `ae09ba4e477b6cdab561b82cc40e008db6ded54c`.

## Disposition

Readiness is **blocked**. Ordinary functions, classes, control flow and leaf
builtin imports now pass the isolated admission controls, and positional rule
selection is fixed. The required ordinary candidate on real main is refused
because inventory and authority reach still contain concrete execution unknowns.
No admission, promotion, configuration change or enablement occurred.

## The single permitted test run

With Node 20.19.4 first in PATH:

```sh
node test/helpers/run.mjs --file-timeout=480000 --suite-timeout=540000 supervisor/test/green-pass.test.mjs supervisor/test/green-main.test.mjs
```

Exit **1**: **225 passed, 1 failed, 0 cancelled, 0 skipped**, in 40,374 ms.
The exact merged stdout/stderr is the `output` field in `green-tests.json`.
Its decoded SHA-256 is
`746ec9b69da99e5378ed3e54d118e7c90739b067f6afb72a373e065e57163b8c`.
The JSON encoding preserves trailing spaces without failing Git whitespace checks.

The failure was case 189, the inherited regex-prefix `/` witness. After a division
operator, the next slash can begin a regex operand. That context was absent from
the regex-prefix set, so a false division reading hid the following dynamic
import. The correction adds division and compound-assignment operand contexts;
unknown slash punctuation contexts now refuse instead of assuming division.
Contextual await/yield and jump-label cases remain conservative. The compound
operator matrix is extended in the fixture file.

Static inspection of the real-main diagnostics also identified a false positive
for a ternary array literal (`condition ? [] : value`). Computed-key detection
now checks its object/class position rather than treating every array followed
by a colon as a computed definition. A positive fixture was added.

Further static inspection confined environment capability reads and refused
environment escaping/mutation, including indirect `Object.assign(process.env,
...)` injection of inherited child-loader settings. Unrecognized process
capabilities, including native signal-based debugger activation, also refuse.
Crypto namespace confinement was also extended to re-exports and dynamic loads,
which could otherwise escape the static namespace-use check. Negative fixtures
were added for these forms.

These corrections and the added cases **postdate the test run**. Node 20.19.4
syntax checks passed for the changed scanner and fixture, but no second test run
was started, honoring the ask's once-only limit. There is no passing-suite claim
for the final head. Fresh focused validation is still required.

The passing cases include the ordinary-code lifecycle admission fixture, all
round-3 refusal witnesses, the reordered-contract fixture, native-loader module
refusals, recursive template loads, launcher alias/shadow controls and the frozen
inventory/authority controls. The native autopilot suite, full suites, release
gates, live acceptance and artificial load were not run. Shared-history notices
in the runner output were nonfatal diagnostics.

## Three real-main outcomes

`main-probe.json` is extracted losslessly from the runner's `GREEN_MAIN_PROBE`
diagnostic. All source bytes came from Git objects at main commit
`716984441f16cd6cebbd93b95c06acfa8f260605`. Each candidate changed one source
line in memory; Git references, main files, configuration and records were not
changed. The probe calls the same execution stage used by full admission.

| Candidate | Outcome |
| --- | --- |
| `board/render.mjs`: default width 120 to 121, outside all known frozen paths | Refused: `GREEN_REACH_UNKNOWN` |
| `supervisor/reconcile.mjs`: one appended comment in the inventory entry | Refused: `GREEN_SELF_AUTHORITY` |
| `housekeeping/config.mjs`: one appended comment in authority reach | Refused: `GREEN_SELF_AUTHORITY` |

The inventory control is also in running authority reach, so self-authority wins
by the existing precedence rule. The ordinary control was **not admitted**.
The probe records 304 inventory paths, 305 main authority paths and 323 running
authority paths, alongside capped unknown diagnostics; those counts do not claim
a complete understood closure.

## Exact blockers retained by real source

Line numbers below refer to the pinned main commit, not the lane's edited files.
The complete captured diagnostics and path inventories are in `main-probe.json`.

- `supervisor/autopilot.mjs:27`: `report?.[name]` and
  `report?.extra?.[name]` are nonnumeric computed reads.
- `supervisor/autopilot.mjs:41`: `spawnSync(process.execPath, [file, ...args],
  {...options, ...})` has a computed script, argv spread and open options.
- `supervisor/autopilot.mjs:130`, `supervisor/reconcile.mjs:19` and
  `supervisor/supervisor.mjs:96`: bare `git` launches fall outside the closed
  anchored/absolute Node-script launcher profile; arguments/options also vary.
- `supervisor/supervisor.mjs:49` and subsequent option reads use nonnumeric
  bracket keys such as `opt['accept-findings']`. Its wrapper at line 77 uses
  a computed file/argv with cwd, env and option spreads.
- `supervisor/reconcile.mjs:108`: the org launch has computed receipt arguments,
  an argv spread, computed option reads and cwd/env overrides at lines 109–110.
- The ordinary candidate's own closure includes an ambiguous slash after a
  parenthesis in `board/render.mjs:8`; `supervisor/fast-path-timing.mjs:15`
  provides another retained lexical ambiguity in authority reach.
- Main does not yet contain `supervisor/green-pass.mjs` or the committed green
  policy. The snapshot stage records the missing authority entry; full production
  admission would additionally require matching policy bytes after bootstrap.

The captured ternary-array diagnoses at `supervisor/autopilot.mjs:26` and
`board/rows.mjs:45` were false positives corrected after the run. They are retained
in the raw historical output and are not presented as remaining blockers.
The other listed loads, options and computed reads independently prevent known
reach under the requested contract. Existing ENG-422 is the follow-up for those
real execution edges; none were waived or special-cased here.

The profile now confines crypto namespace uses to explicit non-loader members,
including alias/enumeration controls, because Node's native engine loader can
load a shared library. Source:
[Node 20.19.4 crypto.setEngine documentation](https://nodejs.org/download/release/v20.19.4/docs/api/crypto.html#cryptosetengineengine-flags).

## Final checks

No dependency was added. The code and evidence whitespace checks pass. The run
report records the final commit, clean-worktree result and blocked readiness.
Independent review remains separate from these engineering observations.
