---
run: R-318
outcome: done
summary: |
  Fixed fixture inbox teardown to tolerate missing or partially written owner metadata during lock handoff. The helper polls within a load-scaled one-second allowance, returns when the lock disappears, and retains every existing argv, process identity, group and individual-signal safety check. Persistent unreadable metadata fails clearly without process lookup or signalling. Implementation is committed as b8356e23e6c72bb7aef0719f5be766127a6fce3f on lane/inbox-teardown. All 65 requested focused tests and three existing load-sensitive teardown tests passed offline. This report precedes its check, separate report commit and final focused lane check.
headline: Fixture inbox cleanup now tolerates owner lock handoff without weakening signal safety.
blockers: []
proposals: []
learnings:
  - Notice locks already fsync owner metadata inside a candidate directory before atomically renaming it into place; recursive release can remove owner.json before removing the lock directory.
artifacts:
  - "Implementation commit: b8356e23e6c72bb7aef0719f5be766127a6fce3f"
  - "Branch: lane/inbox-teardown"
  - test/helpers/inbox.mjs
  - test/inbox.test.mjs
  - /private/tmp/R-318-focused.tap
  - /private/tmp/R-318-loaded-inbox.tap
  - docs/reports/ENG-266-inbox-teardown-R-318.md
  - /Users/rewt/development/rewt/.org/runs/R-318/report.md
  - "Final committed-head evidence: .lane/gate.json and its referenced validation log"
decisions:
  - text: Keep the fix in the fixture helper and leave supervisor/notice-lock.mjs unchanged.
    category: design
    why: Acquisition already renames a complete candidate directory into place atomically. Teardown must tolerate the normal recursive-release window instead of treating lock-directory existence as a complete receipt.
questions: []
challenges: []
---

The handoff wait uses `loadTimeout(1000)` and rechecks every 20 milliseconds.
Only ENOENT and JSON parse failures enter that wait. Other filesystem failures
still propagate. Once a receipt parses, the original ownership checks and
fresh identity confirmation before every individual signal run unchanged.
If metadata remains unreadable at the deadline, the diagnostic identifies the
fixture and bounded handoff wait, preserves the underlying error as its cause,
and leaves the unidentified lock intact.

Nine deterministic regressions cover missing and partial receipts followed by
lock disappearance, a late valid owner, or late invalid argv; persistent missing
and partial receipts; and a late owner beyond the unloaded allowance under
load. Mutations occur after the helper's first actual metadata read, ensuring
the handoff is encountered without a timing race. Existing tests retain coverage
for PID reuse, birth and command changes, group ownership, failed lookups,
transport containment, and safe owner resumption.

Validation:

- `node test/helpers/run.mjs test/inbox.test.mjs promote/test/promote.test.mjs supervisor/test/delivery.test.mjs`:
  65 passed, zero failed or skipped, exit 0, including the capped-promotion-notice
  case named in the handoff. The bounded runner reported no surviving fixtures.
  Evidence: `/private/tmp/R-318-focused.tap`.
- `node test/helpers/run.mjs --test-name-pattern='^(inbox fixture teardown|owned inbox teardown)' test/load-deadlines.test.mjs`:
  three passed, ten unrelated cases skipped by the pattern, exit 0.
  Evidence: `/private/tmp/R-318-loaded-inbox.tap`.
- `git diff --check`: passed.

The first requested-suite invocation inside the macOS workspace sandbox returned
51 passes and 14 filesystem-watch EMFILE failures. A minimal native watch probe
reproduced the restriction. The same unmodified focused suites then passed with
approved native execution. No retry was used to mask an owner-metadata teardown
failure. Fixtures use isolated Herdr/fleet state and test slots; the host test
slot was never taken. No baseline, npm test, promotion tier, release tier or live
acceptance harness ran.

After checking this report and committing its repository copy, the last action
is the focused fast-tier gate:

```sh
node lanes/lane.mjs check --cmd 'node test/helpers/run.mjs test/inbox.test.mjs'
```

Its `.lane/gate.json` receipt will name the final report-inclusive commit and
validation log. This report does not predeclare that final gate result.
