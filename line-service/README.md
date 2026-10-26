# Minimal line service

The operator's 2026-10-26 source hotfix runs one model-free pass per launchd
interval. It uses conditional record intake, the existing asynchronous supervisor
review handler, guarded closeout drain and priority dispatch. It never promotes
another owner's source or invokes a model API. Existing fold READY plus the
existing route, no hold and no reserved effect is today's dispatch authority.

Only the owning project supervisor installs it, from the canonical development
checkout, with the pinned Node. Brain's supervisor installs first; BCH's owner
installs its project separately. No pins, installed releases, active saved jobs,
watcher recipients or owner claims are changed. This is separate from the
project housekeeping schedule, which the worker never starts.

```sh
/Users/rewt/.nvm/versions/node/v20.19.4/bin/node line-service/launchd.mjs install --repo /CANONICAL/PROJECT --org /RECORD --to PROJECT_SUPERVISOR --herdr /ABS/herdr --socket /ACTUAL/herdr.sock
```

The launchd job runs the development source `line-service/line-service.mjs
--once`. Its environment contains executable paths and the actual Herdr socket,
never a fabricated pane, SID or `HERDR_ENV`. Dispatch/review use the supported
Herdr native launch commands with their original claims and guards. The existing
dispatch CLI performs locked session and unlanded-cap admission. One new worker
is considered per pass. The default interval is 30 seconds; `--interval` changes
it at installation.

```sh
node line-service/launchd.mjs status --repo /CANONICAL/PROJECT
node line-service/launchd.mjs stop --repo /CANONICAL/PROJECT
node line-service/launchd.mjs restart --repo /CANONICAL/PROJECT
node line-service/launchd.mjs revert --repo /CANONICAL/PROJECT --commit FULL_HOTFIX_SHA
```

Stop writes a durable service STOP then boots out only this exact launchd job.
Restart verifies that the saved job is absent, archives this service's own STOP,
and bootstraps the saved plist once. It preserves the original installation and
effect receipts; control attempts append to `controls.jsonl`. Native refusal or
uncertainty restores STOP and retains its exact diagnostic. A still-loaded job
is held, never duplicated. Project STOP/HOLD is never cleared by restart.
Revert stops it first and uses ordinary Git revert on an explicit newest-first
list of this hotfix's commits (repeat `--commit`). It refuses a dirty source,
foreign paths or commits outside `line-service/` and its narrow
`lib/product-files.mjs` inventory declaration and `test/line-service.test.mjs`
release controls; it never resets history. Only the
source project's owner reverts shared source; another project's stop is local.
Keep the pre-hotfix archive tag and record the actual committed SHA list.

The per-project directory under `RECORD/line-service/` contains `passes.jsonl`,
`effects.json`, the plist, install receipt and native stdout/stderr. Every pass,
effect and hold is logged. An effect intent precedes its command; failed or lost
replies are retained for the named supervisor to inspect through the existing
command's receipt. The service never automatically retries an ambiguous launch,
native refusal or completed validation. Review attempts across an item's runs,
native reviewer callbacks and verdict receipts all prevent another launch.
Review never waits for a verdict here; zero reviewer suites applies.
Historical closed, retired, missing and unclaimed work does not regenerate
review debt. Existing settle/native attempts and explicit independent post-code
review attempt/hold decision notes are retained. Closeout receives only explicit
unattempted keys; previously evaluated failures/native holds stay with their
existing owner and supported recovery. Actual cap holds are durable judgment
notices; no cap is widened and no completion or unblocks link is invented.

After review delivery/retention and before physical closeout, an eligible current
done report receives routine source completion through `record close ITEM
--if-current-run RUN`. The service journals intent first, rechecks the genuine
claim, immutable report, clean source/canonical Git and actual integrated HEAD,
and retains the full conditional command receipt. The record enforces its own
current-run, report, blocker, open-work and reopen checks atomically. A refusal
becomes its exact durable judgment once; no unconditional close, explicit
judgment override or fabricated promotion is used. Source completion preserves
review/callback/HOLD/archive/final-release obligations and does not wait for
physical cleanup. The service attributes these record writes to `line-service`
and never inherits `ORG_GUARD_OVERRIDE`.

Judgment is enqueued once per unchanged boundary through the existing native
inbox. The service never resumes, probes or restarts the inbox owner; native
inbox delivery/pull remains with its existing owner. Failed review/cleanup
branches leave unrelated dispatch eligible. STOP,
project HOLD and incomplete record tails prevent further effects; the closer
also preserves its specific worker-tab HOLD, lifecycle locks and archive guards.
Removing a hold does not replay a refused effect: use the existing command's
supported recovery after inspecting its evidence. No second transport or approval
schema is introduced.

The notice `--to` recipient does not override `MONITOR_SUPERVISOR_AGENT` in
child commands. Dispatch retains its existing parent/launch/project-policy
exception routing, independently of a brain-chat judgment recipient.

The focused offline check is `node test/helpers/run.mjs
test/line-service.test.mjs`, through `lane check --cmd` on committed
source. These controls stub native effects while using real Git, record/fold and
the real command argv. Actual installation and a real effect/readback belong to
each project's supervisor; a process heartbeat is not acceptance. The full
release test remains the release coordinator's next-release obligation.
The runtime distribution includes `line-service/`. The release discovers its
controls in `test/`. Untracked Finder metadata and runtime code still fail the
source parity guard; the owning supervisor archives stray artifacts through the
supported source recovery rather than weakening that guard.
