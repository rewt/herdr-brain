# Suite second-pass evidence

Measurements use Node 20.19.4 on the local 18-CPU macOS host. `before-tiers.json`
and `after-tiers.json` name each command's start, duration, result and load samples.
The host slot covers each serialized measurement chain. Time waiting to acquire
that slot is excluded. Promotion cost is the sum of slot, core, cycle, lanes and
offline acceptance steps, which are the same steps as the promotion command.
Fast is measured separately; release means the offline release tier, never the
live acceptance harness.

`measure.mjs` and `measure.cjs` retain the measurement implementation. To reproduce
one tier from a repository root, hold the real host slot around:

```sh
node test-slot/test-slot.mjs run suite-measure --wait 600 -- \
  node docs/reports/ENG-135-suite-pass-evidence-20261003/measure.mjs sample core
```

The preload records Node child-process calls, including inherited Node fixture
calls, and entry/exit times for test files. It passes attribution to descendants.
The counts are observed process launches, not a kernel-wide census: native
compiler/shell grandchildren and Node processes that explicitly discard
`NODE_OPTIONS` are not instrumented. Such boundary commands are still counted
at their parent. The preload has identical overhead in before and after runs;
measurements include that overhead. Raw JSONL traces and TAP output are retained
compressed, with aggregate and per-file results in `measurements.json` and
`inventory.md`. The inventory separates fixture boundary counts (Git init,
Git worktree creation, PTY transport and fake Herdr CLI calls) from total launches.
Fake Herdr boundary counts include the `herdr`, `fake-herdr` and `fake-herdr.mjs` executables. All Herdr fixtures are offline; live Herdr mutations are zero.

The slot does not stop unrelated host work. Load samples varied, so wall-time
changes cannot be attributed entirely to the code. Launch counts and removal of
repeated Git initialization/compiler calls give independent cost evidence.

`test-names.json` lists static named coverage (including generated fixture titles); the TAP logs retain expanded runtime test names; `ENG-*-record.txt` and
`flake-log-excerpts.json` retain the record and today's log evidence. The optional
MCP tests are reached through `test/mcp.test.mjs`; missing optional dependencies
and provider/kernel prerequisites are explicit skips, not claimed executions.

`sandbox-blocked/` retains the first invalid attempt: the sandbox denies `ps` and
native filesystem notification delivery, so no ownership/fixture timing from it
is used. `invalid-acceptance/` retains the invalid first acceptance attempt,
affected by a shared-fixture edit during measurement. The corrected acceptance
measurement restores the original fixture and supplies the baseline row.
`after-holder-refusal.log` records an exit-75 slot refusal; no after suite started
in that attempt. The native file-wait and tier-plan focused checks are separate
from tier timing. The first after acceptance run exposed a seed/command-hook isolation regression; its red trace is retained in `failed-after-acceptance/`. Custom command hooks now receive only independently initialized fixture repositories. Only the affected acceptance step was remeasured. `corrected-after-tiers.json` retains that timing; the primary after row/trace uses that corrected step.

`final-focused.*` records verification of the final fixture-hook and deadline review changes. Core/cycle/lane/release wall times are from the initial after chain; those last response-allowance changes are validated by the affected files, without another complete chain. No whole-suite retries are hidden in the measurements.

The two test files beneath `kit/bch-cloak-20261001` are frozen external-project inventory rather than current runnable gate files. Their source layout and build assumptions belong to that historical project; they remain unchanged and their unmeasured status is explicit in the inventory.

Final diff review also restored promotion marker waits to their original 30-second base. The measured event-wait cases passed with the shorter temporary allowance; this final allowance-only restoration was syntax checked without repeating their suite.
