---
run: R-236
outcome: done
summary: |
  Fixed the remaining readiness finding within the supervisor's narrowed scope. The native transport records its actual child exit independently of adapter cleanup, and the release witness rejects native termination and checks the recorded native PID around the UI observation. Removed the 250 ms readiness window in favor of direct liveness evidence. All 13 focused offline tests passed; disabling the native checks made all four delayed-cleanup regressions fail as expected. The implementation is committed; the focused lane check follows the checked report commit as the final action.
headline: Entry readiness now checks the native session before accepting its prompt
blockers: []
proposals: []
learnings:
  - Adapter completion can lag behind native UI termination; capture the native child's exit at the transport boundary and check its PID around the UI observation.
  - Delayed-cleanup regressions can hold adapter cleanup until the harness stop marker, avoiding a race against a chosen delay.
artifacts:
  - "Implementation commit: 7d30f79b776e067bdb30812b4d19ed37f9cba86e"
  - "Branch: lane/lessons-entry"
  - acceptance/entry-native.mjs
  - acceptance/lessons.mjs
  - acceptance/test/lessons.test.mjs
  - docs/reports/ENG-173-lessons-entry-R-236.md
  - "Focused tests: node test/helpers/run.mjs acceptance/test/lessons.test.mjs"
  - "Final lane check: node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs acceptance/test/lessons.test.mjs'"
  - ".lane/gate.json records the final lane check result against the report commit"
decisions: []
questions: []
challenges: []
---

Resolved the Major finding in `docs/reviews/lessons-entry/be38082-r1.md`.
The inherited R-234 validation log contained no failing checks. This run changes
only readiness evidence and its offline regressions, as directed by the supervisor.

`entry-native.mjs` writes a separate native termination receipt on the actual
UI child's `exit` event, before transport or installed adapter cleanup. It retains
the native PID, exit code and signal. Capability probes carry no entry policy and
cannot overwrite that interactive session's evidence.

The gate checks native and adapter termination while waiting for delivery, before
and after reading the UI, and immediately before accepting readiness. Once the
existing lesson argument receipt identifies the native PID, `kill(pid, 0)` verifies
that process is present around the UI observation. Native completion rejects the
launch regardless of exit code. The arbitrary 250 ms observation window is gone;
the proof concerns liveness when delivery and the interactive prompt are observed,
not indefinite future session health. Native and adapter completion evidence are
both retained during owned-session teardown.

Both installed transports have prompt-then-exit regressions for codes zero and
one. The scratch copy of the actual adapter blocks cleanup until the harness stop
marker. The tests wait for native termination and retained prompt output, then
assert gate failure while cleanup is blocked and the adapter completion file is
absent. They verify the native exit receipt, retained interactive prompt, workspace
closure and released producer receipts. Existing successful delivery, proposed
lesson rejection, banner failures and skipped-gate behavior remain covered.

Validation:

- `node test/helpers/run.mjs acceptance/test/lessons.test.mjs`: 13 passed, zero failed, zero skipped.
- Mutation witness: temporarily disabled native termination/PID checks while retaining adapter completion checks. All four delayed-cleanup regressions failed because the broken gate returned success. Source was restored in a `finally` block.
- `git diff --check`: passed before the implementation commit.

The focused macOS sandbox/PTY tests ran outside the enclosing agent sandbox,
which denies nested `sandbox-exec`. An initial sandboxed attempt hit that known
restriction; fixture iterations corrected observation synchronization and a
scratch-only import insertion before the passing run. Every test used offline
native stand-ins, scratch projects and owned PTYs; no model or live acceptance
session ran. Discovery lesson selection and MCP are unchanged by this correction.

After checking and committing this report, the recorded focused lane check is
the final command. Its `.lane/gate.json` receipt carries the result for that exact
commit. Promotion and real-CLI release acceptance remain with the canonical
supervisor. No live or skip-live harness pass ran in this lane.
