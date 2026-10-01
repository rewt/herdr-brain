---
run: R-45
outcome: done
summary: |
  Fixed the idle-grace watcher finding and clarified the release-gated bch-cloak cutover plan. Idle grace now requires observed working and wakes on blocked, with two offline lifecycle fixtures. The plan names continue.sh's wait-to-refusal change, carries both launcher retry rules into the planned SETTLE.md edit, and adds explicit retry checks. Confirmed the supervisor's existing KICKOFF.md guidance resolves the third finding and left it unchanged. No bch-cloak files, external record, release, installed command or compatibility watcher changed.
headline: Watcher grace and launcher retry guidance are ready for the release-gated switch
blockers: []
proposals: []
learnings:
  - Idle grace is separate from startup grace and applies only after this watcher has seen the worker working.
  - A worker becoming blocked during idle grace must wake the watcher immediately and remain watched until it finishes.
  - Repointing bch-cloak's launcher changes continue.sh from waiting for busy settle or exec sessions to refusing immediately, so its supervisor must wait and retry when continuation is still needed.
  - The supervisor already added the settle refusal-and-retry guidance to KICKOFF.md before this run.
artifacts:
  - "Commit: Gate idle grace on observed work and notice blocked workers"
  - "Commit: Report watch parity fixes"
  - "watch/watch.mjs, watch/test/watch.test.mjs and watch/README.md"
  - "docs/reports/ENG-64-one-watcher-20261001.md: cutover files, parity table and checks"
  - "supervisor/KICKOFF.md: existing report-retention and retry guidance confirmed unchanged"
  - "npm test before changes: 313 passed, 0 failed, 1 explicit Herdr-only skip"
  - "node --test watch/test/watch.test.mjs: 17 passed, 0 failed"
  - "npm test after changes: 315 passed, 0 failed, 1 explicit Herdr-only skip"
  - "git diff --check: passed"
decisions:
  - decision: Require observed working before idle grace and include blocked in its blocking wait.
    why: This matches the documented lifecycle contract and prevents a fifteen-minute delay in reporting a newly blocked worker during bch-cloak's planned grace.
  - decision: Keep bch-cloak changes as a release-gated plan, including continuation and settle retries.
    why: This run fixes prerequisites in this lane; the operator still controls release activation and the quiet-point switch.
  - decision: Leave KICKOFF.md unchanged.
    why: Its existing Reports reach you paragraph already tells the supervisor to keep a refused settle notice and retry after the busy session stops, with a link to SETTLE.md.
questions: []
challenges:
  - premise: Idle grace already matched its documented previously-working requirement and noticed blocked transitions.
    verdict: wrong
    evidence: The branch lacked observedWorking and waited only for working; the added gate and blocked wait state correct both omissions, and the new fixtures exercise them.
  - premise: Repointing continue.sh only needs argument compatibility verified.
    verdict: wrong
    evidence: The launcher changes waiting to immediate refusal; the cutover plan now names that behavior and requires a successful retry of the original continuation after the named busy session stops.
  - premise: The supervisor still lacks kickoff guidance for a refused settle launch.
    verdict: moot
    evidence: KICKOFF.md already retains the notice and requires retry after the working settle session stops; this run made no change to that file.
---

All three Minor findings from the supplied review are fixed or already resolved.

The initially idle fixture uses zero startup grace and ten seconds of idle grace. It gets a
no-report notice and delivers the report written in response within the three-second test
deadline, proving idle grace does not apply before observed working. The second fixture waits
for working, then for the idle-grace wait, and changes the worker to blocked. It receives the
blocked notice within two seconds of that transition, well before the ten-second grace ends,
without a no-report notice. A valid report while blocked remains intermediate; changing to idle
delivers the final report and exits successfully.

The original cutover plan now documents immediate continuation refusal in both its files list
and parity table. Its planned bch-cloak SETTLE.md edit retains refused report notices, waits for
the named busy session with Herdr, and retries settlement or a still-needed continuation. The
checks require immediate refusal without a new session followed by exactly one fresh exec
session on continuation retry, plus retention and retry of a refused settle notice. These are
future cutover checks; no live bch-cloak canary or switch was performed here.

The compatibility file contrib/settle-watch.mjs and supervisor/KICKOFF.md have no diff. Core
dependencies, record writes and lifecycle safety checks are unchanged. Tests use local fake
Herdr and record executables and never call a model.

This report is checked with record check and committed before running lane check as the last
operational step. The final gate records the report commit in the ignored .lane/gate.json.
