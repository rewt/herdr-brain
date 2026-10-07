---
run: R-272
outcome: done
summary: |
  Added a reusable arming path that binds watches to the caller's project, its own record, and its named supervisor. Watch now carries the explicit project into notice journaling and autopilot, including when invoked from another checkout.
  Updated the rehearsed cutover and adoption documentation for bch-cloak's record inbox, autopilot, legacy consumer shutdown, and rollback. Offline checks prove routine handling with a busy supervisor, named exception delivery, and duplicate suppression. The live switch remains bch-cloak's after a release ships.
headline: Existing projects can route worker notices through their own record and supervisor autopilot
blockers: []
proposals: []
learnings:
  - "Notice project binding used the caller's process cwd unless watch explicitly forwarded --cwd; this matters when tooling runs from an installed release or another checkout."
  - "Arming previously hard-coded herdr-brain's record and supervisor. It now discovers from the caller and accepts explicit --org, --cwd and --to bindings, freezing them before child launch."
  - "Run acceptance copied-code checks with TMPDIR=/private/tmp under the native worker sandbox: its default temp is under /Users, which the copied-code audit rejects. Nested sandbox-exec checks need an unsandboxed offline test invocation."
artifacts:
  - "ae0589f Bind existing-project watches to their record and supervisor"
  - "watch/test/existing-project.test.mjs"
  - "supervisor/arm-watch.sh and watch/watch.mjs"
  - "acceptance/cutover.mjs, acceptance/security.mjs and their offline tests"
  - "supervisor/README.md, watch/README.md, acceptance/README.md and the ENG-64 cutover update"
  - "Focused six-file offline run: 131 passing cases; one scratch-home fixture failure corrected and verified in a four-case rerun with zero failures"
  - "git diff --check; shell and JavaScript syntax checks"
decisions:
  - text: Keep the project record and named supervisor explicit in the bch-cloak cutover wrapper and freeze discovered bindings before launching watchers.
    category: tooling
    why: Installed tooling must journal and apply policy for the adopting project independently of the caller's checkout and inherited supervisor environment.
questions: []
challenges: []
---

The installed supervisor/arm-watch.sh now accepts --org RECORD --cwd PROJECT
--to SUPERVISOR and detached settings instead of hard-coding herdr-brain. Without
an explicit record it uses existing discovery; the default recipient is the
adapter's MONITOR_SUPERVISOR_AGENT, then supervisor-herdr. Detached dry runs
validate without launching a child or creating a log. Watch forwards --cwd to
the journal's project binding and freezes record/cwd/recipient across process
and pane launches.

The rehearsed bch-cloak wrapper calls that shared helper with its sibling .org
record, checkout, named supervisor and 900-second idle grace. Its notice contract
now requires the record JSONL inbox and notice-autopilot/v1; accounting for pending
old messages; preservation of the plain-text inbox/outbox; stopping the legacy
supervisor-events consumer before arming; and draining new senders before rollback.
The record's approvals and existing STOP/pause/kill switches continue to guard
automatic actions. No live migration was performed.

The new offline tests use real Git, a linked worktree, a sibling project record,
report validation, journal, policy receipts and record intake. Herdr transport and
the routed settle reply are scripted; no model is called. A routine done notice is
handled for supervisor-opus despite a busy supervisor, from a foreign caller and
through detached arming. Re-arming adopts the same final notice and performs no
second intake. A blocked report instead reaches supervisor-opus through the
project's own inbox. Discovery and detached dry-run behavior are also covered.

Verification:
- The focused run covered watch/test/existing-project.test.mjs,
  watch/test/watch.test.mjs, test/one-watcher.test.mjs,
  supervisor/test/autopilot.test.mjs, acceptance/test/cutover.test.mjs and
  acceptance/test/security.test.mjs. 131 of 132 cases passed, including the
  existing real offline autopilot settle, queue, landing and closure checks.
- The remaining case used a scratch directory named home, triggering the
  copied-code audit's deliberate /home/ refusal. The fixture now matches the
  rehearsal's copy-home name. The corrected case and all three adoption cases
  passed together: four passed, zero failed, seven unrelated cases filtered.
- Earlier sandbox runs exposed optional filesystem-event denial and nested
  sandbox-exec restrictions. The new detached-completion check reads its log;
  offline kernel checks passed outside the worker sandbox with /private/tmp.
- Scratch-path replacement now runs once, so generated candidate paths under
  the real home are not relocated a second time. A regression check covers it
  without relaxing the copied-code audit.
- contrib/settle-watch.mjs has no changes. No bch-cloak file was edited and no
  live acceptance harness, housekeeping schedule, model call or pane mutation
  was run.

After this report is checked and its repository copy committed, the final operation
is lane check with the focused adoption, cutover and watcher-wiring tests on that
committed tree. Its receipt is .lane/gate.json.
