---
run: R-282
outcome: done
summary: |
  Implemented model-free blocked-session routing in Brain's existing watcher. Workers route through their fleet project's durable supervisor inbox; blocked supervisors and aged native or legacy deliveries escalate to the bounded steward journal and one configurable local alert command. The service no longer enables digest, and existing busy-composer delivery checks remain intact. Implementation is committed as 9d83ea5 on lane/steward-route. All 20 steward tests and 24 focused parser, project, inbox and tier regression tests passed offline. Activation remains with release and the operator's local configuration; this report precedes its check, separate report commit and final focused lane check.
headline: Blocked sessions now reach their supervisor or raise a bounded operator alert.
blockers: []
proposals: []
learnings:
  - The overnight aggregator read dialog was captured with project other despite belonging to a registered fleet project; the queue's display project is insufficient routing evidence.
  - The supervisor's third-wallet question was captured as unsent composer text rather than a structured dialog. Routing preserves that evidence and a bounded screen excerpt without answering it.
  - bch-cloak still uses a legacy file outbox whose daemon parks delivery after bounded retries. Observing regular message files by age detects that stall without replaying messages or changing the project.
  - First-seen or replacement blocked occupants need capture even without catch-up. Native session and terminal IDs distinguish replacement sessions, and unique capture IDs preserve transitions within one timestamp bucket.
artifacts:
  - "Implementation commit: 9d83ea5 on lane/steward-route"
  - "brain/lib/steward.mjs"
  - "brain/bin/brain.mjs"
  - "brain/lib/service.mjs"
  - "supervisor/prompt-supervisor.mjs"
  - "brain/test/steward.test.mjs"
  - "brain/test/fixtures/aggregator-gm-blocked.json"
  - "brain/test/fixtures/supervisor-opus-blocked.json"
  - "brain/test/fixtures/steward-screens.md"
  - "brain/README.md"
  - "/private/tmp/R-282-steward-tests.log"
  - "/private/tmp/R-282-focused-regression.log"
  - "docs/reports/ENG-243-steward-route-20261007.md"
  - "/Users/rewt/development/rewt/.org/runs/R-282/report.md"
decisions:
  - text: Route by fresh canonical Git identity and fleet record ownership, using explicit local recipients or native supervisor launch bindings.
    category: design
    why: Labels and basenames do not prove project ownership. Unknown, stale, ambiguous or foreign bindings must escalate instead of delivering to a guessed supervisor.
  - text: Separate durable enqueue from delivery and reuse the existing supervisor inbox owner and composer gate.
    category: design
    why: A busy supervisor must not stall fleet capture. Stable IDs allow safe enqueue recovery while the established transport retains FIFO, acknowledgement and busy-input checks.
  - text: Count local alert intents before effects, retain per-session cap receipts across compaction, and refuse new steward effects at the journal ceiling.
    category: tooling
    why: Failed commands, interrupted acknowledgements, watcher restarts and restored sessions must preserve rate limits and action receipts.
questions: []
challenges: []
---

The watcher invokes the steward after capture and checks aged deliveries even when
Herdr is unavailable. `brain steward --dry-run` provides a read-only JSON plan;
`brain steward` performs one foreground pass. The installed service's generated
LaunchAgent runs `watch` without `--digest`. No watcher, service, notification or
live pane operation was activated during this lane's work.

Each current blocked worker notice is enqueued with a stable ID into its fleet
record's `supervisor/inbox.log`. Enqueue returns without waiting for input.
Existing delivery ownership and recovery retain the established idle/done,
two-read composer gate; no permission keys or worker prompts are sent. The
steward itself writes no record events or item status and invokes no supervisor
cycle mutation. A blocked supervisor is journaled and alerted directly, rather
than enqueued to itself.

Local configuration lives at `$BRAIN_STATE/steward.json`. The README supplies
explicit legacy recipients for bch-cloak, its aggregator and herdr-brain; native
supervisors can resolve from explicit launch bindings. An optional absolute
`inbox` selects a custom Monitor transport journal. This implementation does not
change the fleet, operator trust, project permissions or persistent harness
settings. bch-cloak's scripts and ENG-1018 record history were read only.

The default alert invokes a fixed macOS notification program. A configurable
`alert_command` is an argv array receiving one literal JSON payload, without shell
interpolation. The local command has a ten-second deadline. Default stall and
alert debounce thresholds are five minutes, and the cap is three attempts per
session occupant across blocked and stalled causes. Failures and uncertain
acknowledgements consume attempts. `enabled: false` disables routing, recovery
and alerts. Existing loaded services require deliberate activation of the new
installation; this lane did not alter them.

The steward journal retains fsynced intents/results, the latest routing receipts,
all alert-cap receipts and 128 retired history events, within 2,048 events and
4 MiB. Retired cap receipts are compacted rather than discarded, so restoring a
session cannot reset its cap. Saturation or corruption refuses new effects for
inspection. Existing capture and supervisor transport journals retain their own
retention policies; this feature bounds its added journal.

Offline proof:

- `node --test brain/test/steward.test.mjs`: 20 passed. Covers the actual overnight
  permission-dialog and supervisor-question footers, canonical and external
  linked-worktree routing, native bindings, ambiguous/missing/stale/foreign
  recipients, historical and replaced-session suppression, stalled native and
  legacy delivery, acknowledged delivery, debounce/cap, failed or interrupted
  alerts, stable-ID lost-reply enqueue recovery, dry run/disable, configuration
  and journal refusal, compaction/restoration, saturation, Herdr outage, literal
  local-command arguments, blocked-composer input refusal, service defaults and
  actual watcher capture of first-seen and replacement occupants. All projects,
  panes and commands used by the tests are isolated fakes; no model is called.
- `node --test brain/test/capture.test.mjs brain/test/projects.test.mjs supervisor/test/delivery.test.mjs test/tier-plan.test.mjs`:
  24 passed, including existing delivery ownership, busy-input and recovery
  behavior. The new steward file participates in promotion coverage.
- `git diff --check`: passed. No baseline, npm test, promotion suite, lane suite,
  release suite or live acceptance harness was run.

After this report is checked and its repository copy committed, the last action
is the explicitly requested focused gate:

```sh
node lanes/lane.mjs check --cmd 'node --test brain/test/steward.test.mjs brain/test/capture.test.mjs brain/test/projects.test.mjs supervisor/test/delivery.test.mjs test/tier-plan.test.mjs'
```

Its `.lane/gate.json` receipt will bind the result to the final committed tree.
This report does not claim that final result before the command runs.
